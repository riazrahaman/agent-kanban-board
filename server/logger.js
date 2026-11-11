/**
 * C6 (v3.12.5) — one small structured logger for the server.
 *
 * The codebase had ~40 hand-rolled `console.warn`/`console.error` calls with
 * four different shapes (`[kanban] msg: err.message`, `[kanban x] a b c`,
 * `[kanban] ${obj}`, …). None of them carried machine-readable fields, so a log
 * aggregator could not separate a project from an error, and webhooks had its
 * own ad-hoc 60s dedupe map.
 *
 * This module is deliberately tiny and dependency-free:
 *
 *   - `log(level, scope, msg, fields)` emits `[kanban <scope>] <msg> k=v …`,
 *     with values serialised (strings with spaces quoted, Errors reduced to
 *     their message). The `[kanban …]` prefix is preserved so existing log
 *     greps and the one test that waits for "listening on" keep working.
 *   - `createLogger(scope)` binds the scope: `.info/.warn/.error/.debug`.
 *   - `warnOnce(key, ttlMs, msg, fields, scope)` is the ONE dedupe helper
 *     (webhook delivery failures use it instead of a private Map).
 *
 * No response path may depend on this module: every call is best-effort and a
 * throwing console sink is swallowed. Levels are not filtered — the historic
 * behaviour was to always print, and changing volume is a behaviour change.
 */

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/** Serialise one structured field value for a single-line log record. */
export function serializeValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Error) return serializeValue(value.message);
  if (typeof value === 'string') {
    // Quote only when the bare token would be ambiguous (spaces, quotes, `=`).
    return /[\s="]/.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }
  return String(value);
}

/**
 * Format one record. Exported for the unit test and for callers that want the
 * exact line without emitting it.
 *
 *   formatLine('warn', 'webhook', 'delivery failed', { host: 'x.test' })
 *   -> '[kanban webhook] delivery failed host=x.test'
 */
export function formatLine(level, scope, msg, fields = {}) {
  const prefix = scope ? `[kanban ${scope}]` : '[kanban]';
  const pairs = Object.entries(fields || {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${serializeValue(value)}`)
    .join(' ');
  return `${prefix} ${msg}${pairs ? ` ${pairs}` : ''}`;
}

const SINK = {
  debug: (...args) => console.log(...args),
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

/** Emit one structured record. Best-effort: a sink failure never propagates. */
export function log(level, scope, msg, fields = {}) {
  const lvl = LEVELS.has(level) ? level : 'info';
  try {
    SINK[lvl](formatLine(lvl, scope, msg, fields));
  } catch {
    /* logging must never break a request or a sweep */
  }
}

/** A logger bound to one `[kanban <scope>]` prefix. */
export function createLogger(scope) {
  return {
    debug: (msg, fields) => log('debug', scope, msg, fields),
    info: (msg, fields) => log('info', scope, msg, fields),
    warn: (msg, fields) => log('warn', scope, msg, fields),
    error: (msg, fields) => log('error', scope, msg, fields),
    /** Deduped warn: see warnOnce. */
    warnOnce: (key, ttlMs, msg, fields) => warnOnce(key, ttlMs, msg, fields, scope),
  };
}

/** Convenience one-shots for modules that use several scopes. */
export const logInfo = (scope, msg, fields) => log('info', scope, msg, fields);
export const logWarn = (scope, msg, fields) => log('warn', scope, msg, fields);
export const logError = (scope, msg, fields) => log('error', scope, msg, fields);

/**
 * The single dedupe helper: emit `msg` at most once per `key` per `ttlMs`.
 * Returns true when the record was emitted (a caller may use it to gate extra
 * work). A non-positive ttl means "always emit".
 */
const seenAt = new Map();
export function warnOnce(key, ttlMs, msg, fields = {}, scope = null) {
  const ttl = Number.isFinite(ttlMs) ? ttlMs : 0;
  const now = Date.now();
  const last = seenAt.get(key);
  if (ttl > 0 && last !== undefined && now - last < ttl) return false;
  seenAt.set(key, now);
  log('warn', scope, msg, fields);
  return true;
}

/** Test seam: forget every dedupe key. */
export function resetWarnOnce() {
  seenAt.clear();
}

/** Default scope-less logger (`[kanban] …`). */
export const logger = createLogger(null);
