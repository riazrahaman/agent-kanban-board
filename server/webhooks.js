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
 *     mutation; the listener is wrapped and the send is queued, never awaited
 *     on the request path.
 *   - NO new dependency (global `fetch`, like the notifier).
 *   - The payload carries only public board fields (project, task id, status,
 *     kind, actor, reason, ts) — never tokens — and the HMAC signature (when
 *     `KANBAN_WEBHOOK_SECRET` is set) is computed over an explicit timestamp +
 *     body so the receiver can reject both tampering and replays.
 *
 * D6 (v3.12.6) - retries + dead-letter + queue cap. Previously one non-2xx or
 * a throw DROPPED the event with only a log line. Now each event is attempted
 * up to `KANBAN_WEBHOOK_MAX_ATTEMPTS` times (default 3) with exponential
 * backoff (base `KANBAN_WEBHOOK_BACKOFF_MS`, default 250 -> 250ms, 1s, 4s; a
 * 429/503 `Retry-After` is honoured up to 30s). Only TRANSIENT outcomes retry:
 * a network throw/timeout, 408, 425, 429 and 5xx. A 2xx/3xx or any other 4xx is
 * terminal after one attempt. Terminal failures land in a per-URL in-memory
 * dead-letter ring (`KANBAN_WEBHOOK_DEAD_LETTER_MAX`, default 50) with
 * `{ at, event_kind, status?, error?, attempts }`. The per-URL queue is capped
 * (`KANBAN_WEBHOOK_MAX_QUEUE`, default 100); exceeding it drops the OLDEST
 * queued event with one warn line. Nothing is persisted, and no path throws at
 * the caller.
 */

import { createHmac } from 'node:crypto';
import { onDiff } from './store.js';
import { createLogger } from './logger.js';

const log = createLogger('webhook');

const SEND_TIMEOUT_MS = 5000;
/** Retry-After is honoured but never delays an event longer than this. */
const RETRY_AFTER_CAP_MS = 30000;
export const WEBHOOK_SIGNATURE_HEADER = 'x-kanban-signature';
export const WEBHOOK_EVENT_HEADER = 'x-kanban-event';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-kanban-timestamp';

function envList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function positiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function nonNegativeInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
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
    maxAttempts: positiveInt(env.KANBAN_WEBHOOK_MAX_ATTEMPTS, 3),
    // 0 is meaningful: tests (and impatient operators) can disable waiting
    // while keeping the attempt count. The default ladder is 250/1000/4000.
    backoffMs: nonNegativeInt(env.KANBAN_WEBHOOK_BACKOFF_MS, 250),
    maxQueue: positiveInt(env.KANBAN_WEBHOOK_MAX_QUEUE, 100),
    deadLetterMax: positiveInt(env.KANBAN_WEBHOOK_DEAD_LETTER_MAX, 50),
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

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'unknown-host'; }
}

// ============================================================================
// Per-URL delivery state (memory only)
// ============================================================================

/**
 * url -> {
 *   queue: event[],       // waiting to be attempted, oldest first
 *   processing: boolean,  // one worker per URL (no parallel burst)
 *   dropped: number,      // queue-cap evictions since reset
 *   deadLetters: entry[], // insertion-ordered ring, newest last
 * }
 */
const deliveryState = new Map();
const activeDrains = new Set();

function stateFor(url) {
  let state = deliveryState.get(url);
  if (!state) {
    state = { queue: [], processing: false, dropped: 0, deadLetters: [] };
    deliveryState.set(url, state);
  }
  return state;
}

/** Test seam: forget queues, counters and dead letters (does not stop workers). */
export function resetWebhookState() {
  deliveryState.clear();
}

/**
 * Test/monitoring seam: per-URL `{ queued, dropped, deadLetters, processing }`.
 * `deadLetters` is the retained entry list (its length is the count), so a test
 * can assert on `{ status, attempts, event_kind }` without a second accessor.
 */
export function getWebhookStats() {
  const out = {};
  for (const [url, state] of deliveryState) {
    out[url] = {
      queued: state.queue.length,
      dropped: state.dropped,
      deadLetters: state.deadLetters.map((entry) => ({ ...entry })),
      processing: state.processing,
    };
  }
  return out;
}

/** Resolve once every delivery worker that is draining right now has finished. */
export function awaitWebhookIdle() {
  return Promise.all([...activeDrains]).then(() => undefined);
}

// ============================================================================
// Delivery with retry
// ============================================================================

function isTransientStatus(status) {
  if (status === 408 || status === 425 || status === 429) return true;
  return typeof status === 'number' && status >= 500 && status <= 599;
}

function retryAfterMs(res) {
  try {
    const raw = res?.headers?.get?.('retry-after');
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  } catch {
    /* a malformed Retry-After is simply ignored */
  }
  return 0;
}

/** Exponential ladder: base, base*4, base*16, capped at 30s. */
function backoffFor(cfg, attempt, retryAfter) {
  if (retryAfter > 0) return Math.min(retryAfter, RETRY_AFTER_CAP_MS);
  const base = cfg.backoffMs > 0 ? cfg.backoffMs : 0;
  if (base === 0) return 0;
  return Math.min(base * 4 ** (attempt - 1), RETRY_AFTER_CAP_MS);
}

/**
 * One POST attempt. Never throws: a throw/timeout is the transient `error`
 * outcome. Deep-review: a non-2xx is surfaced (rate-limited) — a dead endpoint
 * previously produced zero signal.
 */
async function deliverOne(url, event, cfg, fetchImpl) {
  const body = JSON.stringify(buildPayload(event));
  const timestamp = String(Date.now());
  const signature = signBody(cfg.secret, timestamp, body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const headers = {
      'Content-Type': 'application/json',
      [WEBHOOK_EVENT_HEADER]: String(event.kind),
      [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
    };
    if (signature) headers[WEBHOOK_SIGNATURE_HEADER] = signature;
    const res = await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal });
    const ok = !!res && res.ok === true;
    const status = res && typeof res.status === 'number' ? res.status : undefined;
    if (!ok) {
      log.warnOnce(
        `webhook:${hostOf(url)}:${status}`,
        60000,
        `${event.kind}: ${hostOf(url)} answered ${status}`,
        { url: hostOf(url), status, event: event.kind },
      );
    }
    return {
      ok,
      status,
      transient: !ok && isTransientStatus(status),
      retryAfterMs: status === 429 || status === 503 ? retryAfterMs(res) : 0,
    };
  } catch (err) {
    return {
      ok: false,
      status: undefined,
      transient: true,
      retryAfterMs: 0,
      error: scrub(err && err.message ? err.message : err, cfg),
    };
  } finally {
    clearTimeout(timer);
  }
}

function recordDeadLetter(url, event, cfg, entry) {
  const state = stateFor(url);
  state.deadLetters.push(entry);
  while (state.deadLetters.length > cfg.deadLetterMax) state.deadLetters.shift();
  log.warn('dead-lettered', {
    host: hostOf(url),
    event: event.kind,
    status: entry.status,
    attempts: entry.attempts,
    error: entry.error,
  });
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Attempt one event, retrying transient outcomes. Never throws. */
async function deliverWithRetry(url, event, cfg, fetchImpl, sleep) {
  const maxAttempts = cfg.maxAttempts > 0 ? cfg.maxAttempts : 1;
  let attempts = 0;
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    last = await deliverOne(url, event, cfg, fetchImpl);
    if (last.ok) return;
    if (!last.transient) break;
    if (attempt === maxAttempts) break;
    const delay = backoffFor(cfg, attempt, last.retryAfterMs);
    if (delay > 0) await sleep(delay);
  }
  recordDeadLetter(url, event, cfg, {
    at: new Date().toISOString(),
    event_kind: event.kind,
    ...(last && last.status !== undefined ? { status: last.status } : {}),
    ...(last && last.error ? { error: last.error } : {}),
    attempts,
  });
}

function enqueue(url, event, cfg, fetchImpl, sleep) {
  const state = stateFor(url);
  if (state.queue.length >= cfg.maxQueue) {
    // Never block the board and never throw: drop the OLDEST waiting event so
    // the freshest state still gets a chance to sync.
    const dropped = state.queue.shift();
    state.dropped += 1;
    log.warn('queue full; dropped oldest event', {
      host: hostOf(url),
      event: dropped && dropped.kind,
      queue_max: cfg.maxQueue,
    });
  }
  state.queue.push(event);
  startDrain(url, cfg, fetchImpl, sleep);
}

function startDrain(url, cfg, fetchImpl, sleep) {
  const state = stateFor(url);
  if (state.processing) return;
  state.processing = true;
  const drain = (async () => {
    try {
      while (state.queue.length > 0) {
        const event = state.queue.shift();
        try {
          await deliverWithRetry(url, event, cfg, fetchImpl, sleep);
        } catch {
          /* one broken event must not strand the rest of the queue */
        }
      }
    } catch {
      /* delivery must never throw into a mutation/listener */
    } finally {
      state.processing = false;
    }
  })();
  activeDrains.add(drain);
  drain.then(
    () => activeDrains.delete(drain),
    () => activeDrains.delete(drain),
  );
}

/** One POST per URL (serialized per URL, retried). Never throws. */
function deliver(event, cfg, fetchImpl, sleep = defaultSleep) {
  for (const url of cfg.urls) {
    try {
      enqueue(url, event, cfg, fetchImpl, sleep);
    } catch {
      /* a delivery failure must never surface to the caller */
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
export function startWebhooks({ env = process.env, fetchImpl = fetch, sleep = defaultSleep } = {}) {
  if (running) return webhookConfig(env);
  const cfg = webhookConfig(env);
  if (!cfg.enabled) return cfg;
  unsubscribe = onDiff((event) => {
    if (!shouldDeliver(event, cfg)) return;
    deliver(event, cfg, fetchImpl, sleep);
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
