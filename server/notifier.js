/**
 * §2.11 outbound notifications — Telegram alerts when the reaper returns a task
 * to BACKLOG.
 *
 * This module is a pure SUBSCRIBER. It adds zero surface to the mutation path:
 * `store.onDiff` already fans every committed mutation out to listeners, and the
 * reclaim path emits a semantic `{ kind: 'reclaimed', reason }` event (see
 * `reclaimTaskInner` in store.js). We just filter that stream and POST to
 * Telegram's Bot API.
 *
 * Design constraints, all deliberate:
 *   - OFF by default. Unset token/chat id ⇒ `startNotifier()` is a no-op, so the
 *     test suite and any unconfigured deployment never make a network call.
 *   - FAIL-OPEN for the board, fail-silent for the alert. A Telegram outage must
 *     NEVER break a reclaim; the listener is wrapped and the send is queued
 *     fire-and-forget. The reaper's write already committed by the time we run.
 *   - NO new dependency. Node 20/22 ship a global `fetch`, and the Bot API is a
 *     plain JSON POST (CI matrix is 20.x + 22.x — see .github/workflows/ci.yml).
 *   - The bot token is a secret. It is never returned to clients, never written
 *     to the board, and scrubbed out of any error we log.
 */

import { onDiff } from './store.js';

export const DEFAULT_BOARD_URL = 'https://agent-kanban.riazrahaman.com';
export const DEFAULT_EVENTS = ['lease_expired', 'orphan_normalized'];
export const TELEGRAM_TEXT_LIMIT = 4096;
export const DESCRIPTION_LIMIT = 300;
const SEND_TIMEOUT_MS = 5000;
const MAX_RETRY_AFTER_S = 10;

// ============================================================================
// Config — read at call time (matches the reaper/backup convention in store.js
// so a test suite can override per-suite via env).
// ============================================================================

function envTruthy(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  return raw !== 'false' && raw !== '0';
}

function envNumber(raw, fallback, min) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function envList(raw, fallback) {
  const src = raw === undefined || raw === '' ? fallback : raw;
  return new Set(
    String(src)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * Resolve notifier configuration from the environment.
 * `enabled` is true only when BOTH the bot token and the chat id are present —
 * either alone cannot send anything, so the module stays inert.
 */
export function notifierConfig(env = process.env) {
  const botToken = String(env.KANBAN_TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env.KANBAN_TELEGRAM_CHAT_ID || '').trim();
  const projectsRaw = String(env.KANBAN_NOTIFY_PROJECTS || '').trim();
  return {
    enabled: Boolean(botToken && chatId),
    botToken,
    chatId,
    boardUrl: String(env.KANBAN_BOARD_URL || DEFAULT_BOARD_URL).replace(/\/+$/, ''),
    events: envList(env.KANBAN_NOTIFY_EVENTS, DEFAULT_EVENTS.join(',')),
    projects: projectsRaw
      ? envList(env.KANBAN_NOTIFY_PROJECTS, '')
      : null, // null = every project
    includeDesc: envTruthy(env.KANBAN_NOTIFY_INCLUDE_DESC, true),
    minIntervalMs: envNumber(env.KANBAN_NOTIFY_MIN_INTERVAL_MS, 1000, 0),
  };
}

// ============================================================================
// Text handling
// ============================================================================

// Stored strings are already HTML-escaped by the store (escapeHtml in
// utils/sanitize.js) to defend the WEB client. Telegram is a different sink with
// its own HTML subset, so re-using those bytes verbatim would show literal
// "&quot;" in the alert. We therefore decode the known entity set and re-escape
// ONLY the three characters Telegram's HTML parser treats as markup.
//
// Decode order matters: the specific entities must go first, `&amp;` LAST, or a
// stored `&amp;lt;` would decode twice into a real '<'.
const DECODE_ORDER = [
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#039;', "'"],
  ['&amp;', '&'],
];

function decodeStored(str) {
  if (typeof str !== 'string') return '';
  let out = str;
  for (const [entity, char] of DECODE_ORDER) out = out.split(entity).join(char);
  return out;
}

function htmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Stored text -> safe Telegram-HTML text. */
function safe(str) {
  return htmlEscape(decodeStored(str));
}

function truncate(str, limit) {
  const s = String(str ?? '');
  if (s.length <= limit) return s;
  return `${s.slice(0, Math.max(0, limit - 1))}…`;
}

function fmtUtc(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** Human "how long ago", coarse (d/h/m/s). */
function ago(iso, nowMs) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!parts.length) parts.push(`${seconds}s`);
  return `${parts.join(' ')} ago`;
}

function reasonLabel(reason) {
  if (reason === 'lease_expired') return 'Lease expired (idle — no heartbeat)';
  if (reason === 'orphan_normalized') return 'Orphan normalized (active with no owner)';
  return reason || 'unknown';
}

function line(label, value) {
  if (value === null || value === undefined || value === '') return null;
  return `<b>${htmlEscape(label)}:</b> ${value}`;
}

/** Join a list of already-safe fragments with a separator, or null when empty. */
function joined(list) {
  const items = (Array.isArray(list) ? list : []).map((x) => safe(x)).filter(Boolean);
  return items.length ? items.join(', ') : null;
}

/**
 * Render the full-detail Telegram message for one reclaim event.
 *
 * Takes the diff event (`{ task, prev, project, reason, ts }`) plus config and
 * returns Telegram-HTML text. Only fields that actually carry a value emit a
 * line, so an ownerless orphan reads differently from a dead-lease reclaim
 * without printing empty labels.
 */
export function formatReclaimMessage(event, cfg = notifierConfig(), opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const task = event.task || {};
  const prev = event.prev || {};
  const project = task.project || event.project || '?';
  const reason = event.reason || 'unknown';

  const reclaims = Number.isInteger(task.reclaim_count) ? task.reclaim_count : null;
  const lastLog = Array.isArray(prev.agent_logs) && prev.agent_logs.length
    ? prev.agent_logs[prev.agent_logs.length - 1]
    : null;

  const stageOwners = (() => {
    const map = task.stage_owners || prev.stage_owners;
    if (!map || typeof map !== 'object') return null;
    const parts = Object.entries(map)
      .filter(([, v]) => v)
      .map(([k, v]) => `${safe(k)}: ${safe(v)}`);
    return parts.length ? parts.join(' · ') : null;
  })();

  const workContext = [
    task.priority ? `priority <b>${safe(task.priority)}</b>` : null,
    Number.isInteger(task.round) || Number.isInteger(prev.round)
      ? `round <b>${Number.isInteger(task.round) ? task.round : prev.round}</b>`
      : null,
  ].filter(Boolean).join(' · ');

  const leaseEnded = fmtUtc(prev.claim_expires_at);
  const leaseAgo = ago(prev.claim_expires_at, now);

  const rows = [
    `🔻 <b>Task reclaimed to BACKLOG</b>`,
    '',
    line('Project', `<b>${safe(project)}</b>`),
    line('Task', `<b>${safe(task.id || prev.id)}</b>`),
    line('Title', safe(task.title || prev.title)),
    line('Work', workContext),
    line('Branch', safe(task.branch || prev.branch)),
    line('Depends on', joined(task.depends_on || prev.depends_on)),
    line('Issues', joined(task.issues || prev.issues)),
    line('Description', cfg.includeDesc ? safe(truncate(decodeStored(task.description || prev.description), DESCRIPTION_LIMIT)) : null),
    '',
    line('Reason', `<b>${htmlEscape(reasonLabel(reason))}</b>`),
    line('Held by', prev.assigned_agent ? safe(prev.assigned_agent) : 'none — active with no owner'),
    line('Lease ended', leaseEnded ? `${htmlEscape(leaseEnded)}${leaseAgo ? ` (${htmlEscape(leaseAgo)})` : ''}` : null),
    line('Last activity', (() => {
      const at = fmtUtc(prev.updated);
      if (!at) return null;
      const a = ago(prev.updated, now);
      return `${htmlEscape(at)}${a ? ` (${htmlEscape(a)})` : ''}`;
    })()),
    line('Created', fmtUtc(task.created_at || prev.created_at)),
    line('Reclaim count', reclaims === null ? null : String(reclaims)),
    line('Stage owners', stageOwners),
    line('Last log', lastLog
      ? `"${safe(truncate(lastLog.message, 200))}" — ${safe(lastLog.agent_id || 'system')}`
      : null),
    '',
    `<b>Board:</b> ${htmlEscape(`${cfg.boardUrl}/?project=${encodeURIComponent(project)}`)}`,
  ].filter((r) => r !== null);

  let text = rows.join('\n');
  if (text.length > TELEGRAM_TEXT_LIMIT) {
    text = `${text.slice(0, TELEGRAM_TEXT_LIMIT - 1)}…`;
  }
  return text;
}

// ============================================================================
// Transport
// ============================================================================

/** Remove a secret from any string we are about to log. */
function scrub(message, cfg) {
  let s = String(message ?? '');
  if (cfg && cfg.botToken) s = s.split(cfg.botToken).join('[redacted]');
  return s;
}

async function telegramSend(cfg, text, { fetchImpl, sleep }, attempt = 0) {
  const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });

    if (res.status === 429 && attempt < 1) {
      let retryAfter = 1;
      try {
        const body = await res.json();
        retryAfter = body?.parameters?.retry_after ?? 1;
      } catch {/* body not JSON — default */ }
      await sleep(Math.min(Number(retryAfter) || 1, MAX_RETRY_AFTER_S) * 1000);
      return await telegramSend(cfg, text, { fetchImpl, sleep }, attempt + 1);
    }

    if (!res.ok) throw new Error(`telegram responded HTTP ${res.status}`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}/**
 * One-at-a-time sender with a minimum inter-message gap.
 *
 * The app sends one message PER TASK (not one per sweep), so a sweep that
 * reclaims five tasks would otherwise fire five back-to-back requests and trip
 * Telegram's per-chat rate limit. Serialising the queue with a configurable
 * floor (KANBAN_NOTIFY_MIN_INTERVAL_MS, default 1s) keeps us under it, and any
 * 429 is retried once honouring `parameters.retry_after`.
 */
function createSender(cfg, { fetchImpl, sleep }) {
  let chain = Promise.resolve();
  let lastSentAt = 0;

  return function enqueue(text) {
    chain = chain
      .then(async () => {
        const wait = Math.max(0, cfg.minIntervalMs - (Date.now() - lastSentAt));
        if (wait > 0) await sleep(wait);
        lastSentAt = Date.now();
        await telegramSend(cfg, text, { fetchImpl, sleep });
        // Positive delivery proof for operators grepping the deploy log. The
        // message body is NOT logged (it can carry task detail, and the URL
        // carries the secret) — only that a send succeeded.
        console.log('[kanban notify] delivered 1 reclaim alert to telegram');
      })
      .catch((err) => {
        // Never rethrow: a delivery failure must not reach the mutation path.
        console.error('[kanban notify] send failed:', scrub(err && err.message, cfg));
      });
    return chain;
  };
}

/**
 * Should this diff event produce an alert? Exported for direct unit testing.
 */
export function shouldNotify(event, cfg = notifierConfig()) {
  if (!cfg.enabled) return false;
  if (!event || event.kind !== 'reclaimed') return false;
  if (cfg.events && cfg.events.size && !cfg.events.has(event.reason)) return false;
  if (cfg.projects && cfg.projects.size && !cfg.projects.has(event.project)) return false;
  return true;
}

// ============================================================================
// Lifecycle — mirrors startReaper/startBackup in store.js
// ============================================================================

let active = null;

/**
 * Subscribe to the diff stream and start delivering reclaim alerts.
 * Returns a handle `{ stop(), cfg }`, or null when notifications are not
 * configured (no token/chat id). Idempotent: a second call returns the same
 * handle rather than double-subscribing.
 *
 * `fetchImpl` / `sleep` are injectable so the test suite can drive the transport
 * deterministically without hitting the network.
 */
export function startNotifier({
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now,
} = {}) {
  if (active) return active;
  const cfg = notifierConfig(env);
  if (!cfg.enabled) return null;
  if (typeof fetchImpl !== 'function') {
    console.error('[kanban notify] no fetch implementation available; notifier disabled');
    return null;
  }

  const enqueue = createSender(cfg, { fetchImpl, sleep });

  const unsubscribe = onDiff((event) => {
    try {
      if (!shouldNotify(event, cfg)) return;
      enqueue(formatReclaimMessage(event, cfg, { now }));
    } catch (err) {
      console.error('[kanban notify] dispatch failed:', scrub(err && err.message, cfg));
    }
  });

  console.log(
    `[kanban notify] started (telegram chat=${cfg.chatId}, events=${[...cfg.events].join(',') || 'none'})`
  );

  active = {
    cfg,
    unsubscribe,
    stop() {
      try {
        unsubscribe();
      } finally {
        active = null;
      }
    },
  };
  return active;
}

export function stopNotifier() {
  if (!active) return false;
  active.stop();
  return true;
}

export function isNotifierRunning() {
  return active !== null;
}
