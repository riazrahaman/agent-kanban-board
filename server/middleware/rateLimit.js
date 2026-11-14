import { referencedProjects } from './projectScope.js';
import { defaultProjectName, emitAudit, isValidProjectId } from '../store.js';

/**
 * §2.3 — per-project rate limiting for mutating requests.
 *
 * Budgets are per project so one busy (or compromised) project cannot starve
 * another's agents: a flood against project A exhausts A's window and leaves
 * B untouched. Reads are never limited — the board is polled by dashboards and
 * a 429 on a GET would break them for no security benefit.
 *
 * Fixed window rather than a sliding log: the worst case is 2x the limit across
 * a window boundary, which is an acceptable trade for O(1) memory per project
 * and no per-request array churn. Disabled unless KANBAN_RATE_LIMIT_PER_MIN is
 * set, so existing deployments are unaffected.
 */

const buckets = new Map(); // project -> { count, windowStartMs }

export function resetRateLimits() {
  buckets.clear();
}

/** Number of projects currently holding a bucket. Exists to test the bound. */
export function trackedProjectCount() {
  return buckets.size;
}

/**
 * Drops windows that have already elapsed. Without this the map only ever grew:
 * entries were reset in place, never removed, so every distinct project name
 * ever seen stayed for the process lifetime.
 */
function pruneExpired(now, span) {
  for (const [project, bucket] of buckets) {
    if (now - bucket.windowStartMs >= span) buckets.delete(project);
  }
}

function limitPerWindow() {
  const raw = process.env.KANBAN_RATE_LIMIT_PER_MIN;
  if (raw === undefined || raw === '') return 0; // disabled
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

function windowMs() {
  const raw = process.env.KANBAN_RATE_LIMIT_WINDOW_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 60000;
}

/** Single source of truth for the effective rate-limit configuration. */
export function rateLimitConfig() {
  const limit = limitPerWindow();
  const span = windowMs();
  return { limit, windowMs: span, enabled: limit > 0 };
}

export function createRateLimitMiddleware() {
  return (req, res, next) => {
    const limit = limitPerWindow();
    if (limit === 0) return next();

    const isMutation = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);
    if (!isMutation) return next();

    const span = windowMs();
    const now = Date.now();
    // Only real project ids get a bucket. referencedProjects returns raw
    // caller-supplied strings, and this middleware runs before the router's
    // projectScopeGuard would reject a malformed one — so without this filter a
    // caller sending a fresh random ?project= each time grew the map without
    // bound. An invalid scope is charged to the default bucket instead, and the
    // guard rejects the request a moment later anyway.
    const referenced = referencedProjects(req).filter((p) => isValidProjectId(p));
    const scopes = referenced.length > 0 ? referenced : [defaultProjectName()];
    pruneExpired(now, span);

    // Charge every project the request references, for the same reason auth
    // authorizes all of them: the body can outrank the query when the store
    // resolves which board is actually touched.
    for (const scope of scopes) {
      let bucket = buckets.get(scope);
      if (!bucket || now - bucket.windowStartMs >= span) {
        bucket = { count: 0, windowStartMs: now };
        buckets.set(scope, bucket);
      }
      if (bucket.count >= limit) {
        const retryMs = Math.max(0, bucket.windowStartMs + span - now);
        res.set('Retry-After', String(Math.ceil(retryMs / 1000)));
        res.set('X-RateLimit-Limit', String(limit));
        res.set('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
        console.warn(
          `[kanban rate limit] 429 on ${req.method} ${req.originalUrl} for project '${scope}'`
        );
        return res.status(429).json({
          error: `Rate limit exceeded for project '${scope}'`,
          retry_after_ms: retryMs,
        });
      }
    }
    for (const scope of scopes) buckets.get(scope).count += 1;

    return next();
  };
}

// ---------------------------------------------------------------------------
// ENH-09 (v2.6.0) — rate-limit FAILED AUTH attempts per client IP.
// ---------------------------------------------------------------------------
// A second fixed-window bucket map keyed by client IP, separate from the
// per-project mutation budget. This exists so a brute-force attack on the auth
// token (401 spam) or the session proof (401/403 spam) is throttled even when
// the per-project mutation rate limit is not configured — the mutation limiter
// only counts requests that PASS auth, so it never sees the failures.
//
// On by default: when `KANBAN_AUTH_RATE_LIMIT_PER_MIN` is unset the per-IP
// ceiling falls back to `KANBAN_RATE_LIMIT_PER_MIN` when that is set, and
// otherwise to DEFAULT_AUTH_FAILURES_PER_WINDOW (60 per window), matching the
// documented default. Only failures are counted, so a correctly configured
// client never consumes this budget. An explicit `0` disables the subsystem.
// (The per-project mutation limiter above stays disabled unless configured.)
//
// Memory is bounded: at most MAX_AUTH_BUCKETS addresses get their own bucket.
// When the map is full, any further address shares one OVERFLOW bucket, so a
// flood of distinct (e.g. forged forwarded) addresses is still throttled
// collectively. Expired buckets are pruned at most once per AUTH_PRUNE_INTERVAL_MS
// rather than on every request; a stale bucket is still ignored on read because
// every lookup checks its window.
const authBuckets = new Map(); // ip | AUTH_OVERFLOW_KEY -> { count, windowStartMs }

export const MAX_AUTH_BUCKETS = 10000;
export const AUTH_OVERFLOW_KEY = '\u0000overflow';
const AUTH_PRUNE_INTERVAL_MS = 1000;
let lastAuthPruneMs = 0;

export function resetAuthLimits() {
  authBuckets.clear();
  lastAuthPruneMs = 0;
}

export function trackedAuthIpCount() {
  return authBuckets.size;
}

export const DEFAULT_AUTH_FAILURES_PER_WINDOW = 60;

function authLimitPerWindow() {
  const raw = process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN;
  if (raw === undefined || raw === '') {
    // Unset: keep the historical fallback to a configured mutation limit, and
    // otherwise use the documented default instead of switching the limiter off.
    const mutationLimit = limitPerWindow();
    return mutationLimit > 0 ? mutationLimit : DEFAULT_AUTH_FAILURES_PER_WINDOW;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

function clientIp(req) {
  // Rely on Express's req.ip which honours KANBAN_TRUST_PROXY (app.set('trust proxy')).
  // Raw socket fallback preserves compatibility for non-Express / mock harnesses.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function pruneAuthExpired(now, span) {
  if (now - lastAuthPruneMs < AUTH_PRUNE_INTERVAL_MS) return;
  lastAuthPruneMs = now;
  for (const [ip, bucket] of authBuckets) {
    if (now - bucket.windowStartMs >= span) authBuckets.delete(ip);
  }
}

/**
 * The bucket key for an address: its own entry when it already has one or
 * there is room, otherwise the shared overflow bucket. O(1).
 */
function authBucketKey(ip) {
  if (authBuckets.has(ip)) return ip;
  // The overflow bucket does not count against the per-address capacity.
  const perAddress = authBuckets.size - (authBuckets.has(AUTH_OVERFLOW_KEY) ? 1 : 0);
  return perAddress < MAX_AUTH_BUCKETS ? ip : AUTH_OVERFLOW_KEY;
}

/** Live bucket for the request's address, or null (no bucket / window over). */
function liveAuthBucket(req, now, span) {
  return liveAuthBucketAndKey(req, now, span)?.bucket ?? null;
}

function liveAuthBucketAndKey(req, now, span) {
  const key = authBucketKey(clientIp(req));
  const bucket = authBuckets.get(key);
  if (!bucket || now - bucket.windowStartMs >= span) return null;
  return { key, bucket };
}

/**
 * Logged and audited once per bucket per window, on the failure that takes it
 * past the hard cap. The address goes to the server console only; the audit
 * entry (which can reach board readers via the audit stream) carries none.
 */
function noteHardCapTripped(key, count, limit, span) {
  const who = key === AUTH_OVERFLOW_KEY ? 'the shared overflow bucket' : `address ${key}`;
  console.warn(
    `[kanban auth] failed-auth hard cap reached for ${who}: ${count} failures in the ` +
    `current ${span}ms window (limit ${limit}, cap ${limit * AUTH_HARD_CAP_MULTIPLIER}); ` +
    'all credential-checked requests from it get 429 until the window ends'
  );
  emitAudit({
    ts: new Date().toISOString(),
    kind: 'auth_hard_cap',
    project: defaultProjectName(),
    task: null,
    actor: 'system',
    reason: `failed-auth hard cap reached (${count} failures in window, cap ${limit * AUTH_HARD_CAP_MULTIPLIER})`,
  });
}

/**
 * Records a failed auth attempt for the request's client IP. Called on every
 * 401/403 the auth middleware (or the handshake routes) return. Inert when the
 * auth rate limit is disabled.
 */
export function recordAuthFailure(req) {
  const limit = authLimitPerWindow();
  if (limit === 0) return;
  const span = windowMs();
  const now = Date.now();
  pruneAuthExpired(now, span);
  const key = authBucketKey(clientIp(req));
  let bucket = authBuckets.get(key);
  if (!bucket || now - bucket.windowStartMs >= span) {
    bucket = { count: 0, windowStartMs: now };
    authBuckets.set(key, bucket);
  }
  bucket.count += 1;
  // The shared overflow bucket never trips the outright refusal (see
  // authHardCapExceeded), so it is not reported as a hard-cap event either.
  if (key !== AUTH_OVERFLOW_KEY && bucket.count === limit * AUTH_HARD_CAP_MULTIPLIER + 1) {
    noteHardCapTripped(key, bucket.count, limit, span);
  }
}

/**
 * Returns the retry-after in ms when the client IP has exceeded the auth-failure
 * budget, or null when it is within budget (or the subsystem is disabled).
 */
export function authFailuresExceeded(req) {
  const limit = authLimitPerWindow();
  if (limit === 0) return null;
  const span = windowMs();
  const now = Date.now();
  pruneAuthExpired(now, span);
  const bucket = liveAuthBucket(req, now, span);
  if (!bucket) return null;
  if (bucket.count >= limit) {
    return Math.max(0, bucket.windowStartMs + span - now);
  }
  return null;
}

/**
 * Hard ceiling on failures per address per window, as a multiple of the
 * failed-auth limit. Below it, valid credentials are served while an address is
 * over the limit (see rejectFailedAuth); above it, the address is refused
 * outright until the window ends, valid or not, so guessing cannot continue at
 * full speed behind the "valid requests still served" rule. With the default
 * limit of 60 that is 600 failures in one window — only a flood gets there.
 */
export const AUTH_HARD_CAP_MULTIPLIER = 10;

/**
 * Returns the retry-after in ms when the client IP has accumulated MORE than
 * AUTH_HARD_CAP_MULTIPLIER x limit failures in the current window, else null.
 * Inert when the failed-auth limiter is disabled (explicit 0).
 */
export function authHardCapExceeded(req) {
  const limit = authLimitPerWindow();
  if (limit === 0) return null;
  const span = windowMs();
  const now = Date.now();
  // O(1): runs on every credential-checked request, so no pruning here.
  const live = liveAuthBucketAndKey(req, now, span);
  if (!live) return null;
  // The overflow bucket is shared by unrelated addresses, so it only throttles
  // failed attempts (authFailuresExceeded); it never refuses valid credentials.
  if (live.key === AUTH_OVERFLOW_KEY) return null;
  const { bucket } = live;
  if (bucket.count > limit * AUTH_HARD_CAP_MULTIPLIER) {
    return Math.max(0, bucket.windowStartMs + span - now);
  }
  return null;
}

/**
 * Answers a request that FAILED authentication. Throttling is applied here, at
 * the failure point, rather than before credentials are checked: while an
 * address is over the failed-auth budget only requests that would fail anyway
 * get the 429, so one misconfigured client cannot lock out every valid caller
 * sharing its address (an office NAT, or every local agent on 127.0.0.1). A
 * valid request never touches the bucket, so it neither clears nor extends the
 * window.
 *
 * The 429 is decided only after the full credential check has run, so it takes
 * the same work as the 401/403 it replaces and reveals nothing the 401/403 does
 * not.
 *
 * Every call records a failure, as the pre-check path did for a throttled
 * request. Returns the Express response.
 */
export function rejectFailedAuth(req, res, status, payload) {
  const retryAfter = authFailuresExceeded(req);
  recordAuthFailure(req);
  if (retryAfter !== null) return sendAuthThrottled(res, retryAfter);
  return res.status(status).json(payload);
}

/** The failed-auth 429 (body unchanged; Retry-After header in whole seconds). */
export function sendAuthThrottled(res, retryAfterMs) {
  res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return res.status(429).json({
    error: 'Too many failed authentication attempts',
    retry_after_ms: retryAfterMs,
  });
}
