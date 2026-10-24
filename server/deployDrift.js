/**
 * §2.10 (v3.9.5) — deploy-drift monitor.
 *
 * Answers one question, out loud: is the version this process is RUNNING the
 * version the project last RELEASED? A Railway service with `checkSuites: true`
 * does not fail a deploy when CI is red — it SKIPS it, and the board keeps
 * serving the previous build with a healthy `/api/health`. That is a silent
 * failure mode: nothing is broken, so nothing alerts, and the fix (re-run the
 * deployment) is invisible unless someone compares two version strings.
 *
 * Design constraints, all deliberate:
 *   - OFF is impossible; DISABLING is possible. One check runs shortly after
 *     boot, then every KANBAN_DEPLOY_DRIFT_INTERVAL_MS (default 30 min; ≤ 0
 *     disables the monitor entirely, in which case `status` stays `unknown`
 *     with a null `checked_at` and the client chip stays hidden).
 *   - NEVER throws. Any fetch/parse failure is `unknown` — GitHub being
 *     unreachable says nothing about this deployment's health.
 *   - NO new secret and no GitHub token. `releases/latest` is a public read;
 *     the only credentials it uses are the Telegram pair the notifier already
 *     owns, and if either is unset it stays silent.
 *   - GRACE. A release tag appears on GitHub the moment it is cut, minutes
 *     before the redeploy lands. Reporting drift in that window would alert on
 *     every single good deploy, so a mismatch only becomes `drift` once it has
 *     persisted longer than KANBAN_DEPLOY_DRIFT_GRACE_MS (default 45 min).
 *   - The timer is unref()'d and started ONLY from `startServer`, never from
 *     `createApp`, so the HTTP-contract tests never make a network call.
 *
 * Everything the monitor decides is in the pure `evaluateDrift()` helper, which
 * takes an explicit clock — the tests drive it without network or timers.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Same single source of truth as routes/health.js: server/package.json.
const { version: APP_VERSION } = require('./package.json');

export const DEFAULT_API_URL =
  'https://api.github.com/repos/riazrahaman/agent-kanban-board/releases/latest';
export const DEFAULT_INTERVAL_MS = 1800000; // 30 min
export const DEFAULT_GRACE_MS = 2700000; // 45 min
export const DEFAULT_BOARD_URL = 'https://agent-kanban.riazrahaman.com';
const FETCH_TIMEOUT_MS = 8000;
const SEND_TIMEOUT_MS = 5000;
// "Once shortly after boot": late enough that the deploy's own healthcheck has
// settled, early enough to be in the first log scroll.
const BOOT_CHECK_DELAY_MS = 5000;

// ============================================================================
// Config — read at call time, matching the reaper/backup/notifier convention.
// ============================================================================

function envInt(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/**
 * Resolve monitor configuration from `process.env` at call time.
 *
 * `intervalMs <= 0` disables the timer (the endpoint keeps reporting `unknown`
 * with `checked_at: null`, which the client treats as "no check configured" and
 * hides). `graceMs` is a floor of 0 so a test/deployment may opt into
 * "report the mismatch immediately".
 */
export function deployDriftConfig() {
  return {
    intervalMs: envInt(process.env.KANBAN_DEPLOY_DRIFT_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    graceMs: Math.max(0, envInt(process.env.KANBAN_DEPLOY_DRIFT_GRACE_MS, DEFAULT_GRACE_MS)),
    apiUrl:
      String(process.env.KANBAN_DEPLOY_DRIFT_API_URL || '').trim() || DEFAULT_API_URL,
  };
}

/** `v3.9.5` and `3.9.5` are the same release; compare the bare triple. */
export function normalizeTag(tag) {
  if (typeof tag !== 'string') return null;
  const trimmed = tag.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, '');
}

// ============================================================================
// The decision — pure, no network, no clock of its own
// ============================================================================

/**
 * Decide the drift status from two version strings and a clock.
 *
 * Returns `{ status, drift_since }` where `status` is one of
 * `'in_sync' | 'drift' | 'unknown'` and `drift_since` is epoch milliseconds
 * (the first observation of the current mismatch) or null.
 *
 * A mismatch inside the grace window reports `in_sync` — the release is simply
 * newer than the deploy that has not landed yet — but the observation is
 * RETURNED in `drift_since` so the caller can keep timing it across checks.
 * Equality clears the timer.
 *
 * @param {object} args
 * @param {string} args.running Version this process runs (server/package.json).
 * @param {string|null} args.latestTag Newest release tag from GitHub.
 * @param {number} args.now Clock, epoch ms.
 * @param {number|null} [args.driftSince] First observation of the mismatch.
 * @param {number} [args.graceMs] How long a mismatch must persist.
 */
export function evaluateDrift({
  running,
  latestTag,
  now,
  driftSince = null,
  graceMs = DEFAULT_GRACE_MS,
}) {
  const runningTag = normalizeTag(running);
  const latest = normalizeTag(latestTag);
  if (!runningTag || !latest || !Number.isFinite(now)) {
    return { status: 'unknown', drift_since: null };
  }
  if (runningTag === latest) {
    return { status: 'in_sync', drift_since: null };
  }
  const since = Number.isFinite(driftSince) ? driftSince : now;
  const elapsed = now - since;
  return {
    status: elapsed >= Math.max(0, graceMs) ? 'drift' : 'in_sync',
    drift_since: since,
  };
}

// ============================================================================
// State
// ============================================================================

function emptyState() {
  return {
    status: 'unknown',
    running: APP_VERSION,
    latest_tag: null,
    checked_at: null,
    drift_since: null,
  };
}

let state = emptyState();
let checkTimer = null;
let bootTimer = null;
let inFlight = false;
let lastLoggedFailure = null; // one log line per distinct failure, not per tick

/**
 * Read-only snapshot for `GET /api/health`. Contains the running version, the
 * newest release tag seen, the last check time and the first observation of the
 * current mismatch — no secrets, nothing caller-specific.
 */
export function deployDriftStatus() {
  return { ...state };
}

/** Test/ops seam: forget the observation history without touching the timer. */
export function resetDeployDriftState() {
  state = emptyState();
  lastLoggedFailure = null;
  return deployDriftStatus();
}

// ============================================================================
// Telegram — transitions only
// ============================================================================

function telegramTarget(env = process.env) {
  const botToken = String(env.KANBAN_TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env.KANBAN_TELEGRAM_CHAT_ID || '').trim();
  return {
    enabled: Boolean(botToken && chatId),
    botToken,
    chatId,
    boardUrl: String(env.KANBAN_BOARD_URL || DEFAULT_BOARD_URL).replace(/\/+$/, ''),
  };
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function humanDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * Render the one message a transition sends. `kind` is `'drift'` or `'in_sync'`.
 * Exported only so the wording can be read in a test; the monitor calls it with
 * its own state.
 */
export function formatDeployDriftMessage(kind, snapshot, boardUrl = DEFAULT_BOARD_URL) {
  const running = esc(normalizeTag(snapshot.running) ?? 'unknown');
  const latest = esc(normalizeTag(snapshot.latest_tag) ?? 'unknown');
  const board = esc(boardUrl);
  if (kind === 'drift') {
    const sinceMs = Date.parse(snapshot.drift_since || '');
    const forHowLong = Number.isNaN(sinceMs) ? '' : ` for ${humanDuration(Date.now() - sinceMs)}`;
    return [
      '🔻 <b>Deploy drift</b>',
      '',
      `Live board is running <b>v${running}</b> but the newest release is <b>v${latest}</b>${forHowLong}.`,
      'The deploy was most likely SKIPPED (red CI), not failed — the board itself is healthy.',
      '',
      `<b>Board:</b> ${board}`,
    ].join('\n');
  }
  return [
    '✅ <b>Deploy back in sync</b>',
    '',
    `Live board now runs <b>v${running}</b>, matching the newest release <b>v${latest}</b>.`,
    '',
    `<b>Board:</b> ${board}`,
  ].join('\n');
}

/**
 * POST one message to Telegram. Returns true/false, never throws, and logs at
 * most one line. Unconfigured (either env var unset) is a silent no-op.
 */
async function sendTelegram(text, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const target = telegramTarget(env);
  if (!target.enabled || typeof fetchImpl !== 'function') return false;
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${target.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: target.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res || !res.ok) {
      console.error(`[kanban deploy-drift] telegram alert failed: HTTP ${res && res.status}`);
      return false;
    }
    console.log('[kanban deploy-drift] delivered 1 alert to telegram');
    return true;
  } catch (err) {
    // Never rethrow: an alerting failure must not affect the board. The token
    // is in the URL, so only the message is logged — and it is already scrubbed
    // by dropping the URL from the error text.
    console.error(`[kanban deploy-drift] telegram alert failed: ${err && err.name}`);
    return false;
  }
}

// ============================================================================
// One check
// ============================================================================

/**
 * Run a single check: fetch the newest release, compare it with the running
 * version, record the state, and alert ONLY on a status transition.
 *
 * Injectable (`fetchImpl`, `now`, `env`, `graceMs`, `apiUrl`) so the tests drive
 * every branch with no network, no timers and no clock.
 *
 * @returns {Promise<object>} the new `deployDriftStatus()` snapshot.
 */
export async function runDeployDriftCheck({
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  env = process.env,
  graceMs,
  apiUrl,
  send = true,
} = {}) {
  const cfg = deployDriftConfig();
  const grace = Number.isFinite(graceMs) ? graceMs : cfg.graceMs;
  const url = apiUrl || cfg.apiUrl;
  const previous = state;
  const checkedAt = new Date(now).toISOString();

  try {
    if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation');
    const res = await fetchImpl(url, {
      headers: {
        // GitHub rejects API requests with no User-Agent.
        'User-Agent': `agent-kanban-board/${APP_VERSION}`,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
    const body = await res.json();
    const latestTag = normalizeTag(body && body.tag_name);
    if (!latestTag) throw new Error('release payload has no tag_name');

    const decision = evaluateDrift({
      running: APP_VERSION,
      latestTag,
      now,
      driftSince: previous.drift_since ? Date.parse(previous.drift_since) : null,
      graceMs: grace,
    });

    state = {
      status: decision.status,
      running: APP_VERSION,
      latest_tag: latestTag,
      checked_at: checkedAt,
      drift_since:
        decision.drift_since === null ? null : new Date(decision.drift_since).toISOString(),
    };
    lastLoggedFailure = null;
  } catch (err) {
    // Keep `latest_tag`/`drift_since` from the last SUCCESSFUL observation: a
    // GitHub outage must not erase a drift we are already timing. The status is
    // honest about this check alone.
    state = { ...previous, status: 'unknown', running: APP_VERSION, checked_at: checkedAt };
    const line = `[kanban deploy-drift] check failed: ${err && err.message}`;
    // One line per distinct failure; a 30-minute tick would otherwise spam a
    // week of identical DNS errors into the log.
    if (line !== lastLoggedFailure) {
      console.error(line);
      lastLoggedFailure = line;
    }
    return deployDriftStatus();
  }

  if (send) {
    const target = telegramTarget(env);
    if (target.enabled) {
      if (previous.status !== 'drift' && state.status === 'drift') {
        await sendTelegram(formatDeployDriftMessage('drift', state, target.boardUrl), {
          env,
          fetchImpl,
        });
      } else if (previous.status === 'drift' && state.status === 'in_sync') {
        await sendTelegram(formatDeployDriftMessage('in_sync', state, target.boardUrl), {
          env,
          fetchImpl,
        });
      }
    }
  }

  return deployDriftStatus();
}

// ============================================================================
// Lifecycle — mirrors startReaper/startBackup in store.js
// ============================================================================

/**
 * Start the monitor: one check shortly after boot, then every
 * `KANBAN_DEPLOY_DRIFT_INTERVAL_MS`. Idempotent. Returns the interval handle, or
 * null when disabled. Both timers are unref()'d so a monitor can never be the
 * reason a process stays alive.
 */
export function startDeployDrift({ fetchImpl = globalThis.fetch } = {}) {
  if (checkTimer) return checkTimer;
  const { intervalMs } = deployDriftConfig();
  if (!(intervalMs > 0)) {
    console.log('[kanban deploy-drift] disabled (KANBAN_DEPLOY_DRIFT_INTERVAL_MS <= 0)');
    return null;
  }

  const tick = () => {
    if (inFlight) return; // a slow GitHub call must not stack up ticks
    inFlight = true;
    runDeployDriftCheck({ fetchImpl })
      .catch((err) => {
        // runDeployDriftCheck already swallows; this is belt-and-braces so an
        // unexpected throw cannot kill the interval or the process.
        console.error('[kanban deploy-drift] check crashed:', err && err.message);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  bootTimer = setTimeout(tick, BOOT_CHECK_DELAY_MS);
  if (typeof bootTimer.unref === 'function') bootTimer.unref();

  checkTimer = setInterval(tick, intervalMs);
  if (typeof checkTimer.unref === 'function') checkTimer.unref();

  console.log(`[kanban deploy-drift] started (interval=${intervalMs}ms)`);
  return checkTimer;
}

/** Stop both timers. Returns true when something was actually running. */
export function stopDeployDrift() {
  let stopped = false;
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
    stopped = true;
  }
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
    stopped = true;
  }
  return stopped;
}

export function isDeployDriftRunning() {
  return checkTimer !== null;
}
