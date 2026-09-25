/**
 * opt-integration-hooks (v2.11.0) — outbound webhooks.
 *
 * A generic companion to `notifier.js`: where the notifier renders one
 * human-readable Telegram alert for a single event kind, this module POSTs a
 * machine-readable JSON envelope for EVERY committed mutation kind to one or
 * more subscriber URLs. That is the "sync the board with GitHub/Jira/an
 * external system" primitive the roadmap called out; the receiving end decides
 * what to do with it.
 *
 * Same design constraints as the notifier, all deliberate:
 *   - OFF by default. No KANBAN_WEBHOOK_URLS ⇒ `startWebhooks()` is a no-op, so
 *     tests and unconfigured deployments never make a network call.
 *   - FAIL-SILENT for the board. A subscriber being down must NEVER break a
 *     mutation; the listener is wrapped and the send is queued fire-and-forget.
 *   - NO new dependency (global `fetch`, like the notifier).
 *   - The payload carries only public board fields (project, task id, status,
 *     kind, actor, reason, ts) — never tokens — and the HMAC signature (when
 *     `KANBAN_WEBHOOK_SECRET` is set) is computed over an explicit timestamp +
 *     body so the receiver can reject both tampering and replays.
 */

import { createHmac } from 'node:crypto';
import { onDiff } from './store.js';

const SEND_TIMEOUT_MS = 5000;
export const WEBHOOK_SIGNATURE_HEADER = 'x-kanban-signature';
export const WEBHOOK_EVENT_HEADER = 'x-kanban-event';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-kanban-timestamp';

function envList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve webhook configuration from the environment. `enabled` is true only
 * when at least one URL is configured. `events` defaults to every kind.
 */
export function webhookConfig(env = process.env) {
  const urls = envList(env.KANBAN_WEBHOOK_URLS);
  const events = envList(env.KANBAN_WEBHOOK_EVENTS);
  return {
    enabled: urls.length > 0,
    urls,
    events: new Set(events.length ? events : []),
    secret: env.KANBAN_WEBHOOK_SECRET || null,
    timeoutMs: SEND_TIMEOUT_MS,
  };
}

/** Should this diff event be delivered? */
export function shouldDeliver(event, cfg) {
  if (!cfg.enabled) return false;
  if (!event || typeof event.kind !== 'string') return false;
  if (cfg.events.size > 0 && !cfg.events.has(event.kind)) return false;
  return true;
}

/**
 * Build the JSON body for one event. Deliberately a flat, stable envelope so a
 * receiver can key on `{ kind, project, task_id }`.
 */
export function buildPayload(event) {
  const task = event.task || null;
  return {
    event: 'task.changed',
    kind: event.kind,
    project: event.project || (task && task.project) || null,
    task_id: task ? task.id : null,
    status: task ? task.status : null,
    priority: task ? task.priority : null,
    milestone: task ? task.milestone ?? null : null,
    actor: event.actor || null,
    reason: event.reason || null,
    timestamp: event.ts || Date.now(),
  };
}

/** `sha256=<hex>` HMAC over `${timestamp}.${body}` — the GitHub webhook convention. */
export function signBody(secret, timestamp, body) {
  if (!secret) return null;
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function scrub(str, cfg) {
  let out = String(str);
  if (cfg.secret) out = out.split(cfg.secret).join('[redacted]');
  return out;
}

/** One POST per URL. Never throws; returns the per-URL status (or null). */
async function deliver(event, cfg, fetchImpl) {
  const body = JSON.stringify(buildPayload(event));
  const timestamp = String(Date.now());
  const signature = signBody(cfg.secret, timestamp, body);
  for (const url of cfg.urls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      const headers = {
        'Content-Type': 'application/json',
        [WEBHOOK_EVENT_HEADER]: String(event.kind),
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
      };
      if (signature) headers[WEBHOOK_SIGNATURE_HEADER] = signature;
      await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal });
      clearTimeout(timer);
    } catch (err) {
      console.warn('[kanban webhook] delivery failed:', scrub(err && err.message ? err.message : err, cfg));
    }
  }
}

// ============================================================================
// Lifecycle
// ============================================================================

let unsubscribe = null;
let running = false;

/**
 * Subscribe to the diff stream and deliver configured events. Returns the
 * config (with `enabled`) so `server.js` can log the state; a no-op returns
 * `{ enabled: false }`.
 */
export function startWebhooks({ env = process.env, fetchImpl = fetch } = {}) {
  if (running) return webhookConfig(env);
  const cfg = webhookConfig(env);
  if (!cfg.enabled) return cfg;
  unsubscribe = onDiff((event) => {
    if (!shouldDeliver(event, cfg)) return;
    deliver(event, cfg, fetchImpl);
  });
  running = true;
  return cfg;
}

export function stopWebhooks() {
  if (unsubscribe) {
    try {
      unsubscribe();
    } catch {
      /* best-effort */
    }
    unsubscribe = null;
  }
  running = false;
}

export function isWebhooksRunning() {
  return running;
}
