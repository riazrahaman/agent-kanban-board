import { referencedProjects } from './projectScope.js';
import { defaultProjectName, isValidProjectId } from '../store.js';

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
// Disabled by default (no env => disabled) so existing tests and deployments
// are unaffected. `KANBAN_AUTH_RATE_LIMIT_PER_MIN` sets the per-IP ceiling; when
// unset it falls back to `KANBAN_RATE_LIMIT_PER_MIN`, and if BOTH are unset the
// whole subsystem is inert.
const authBuckets = new Map(); // ip -> { count, windowStartMs }

export function resetAuthLimits() {
  authBuckets.clear();
}

export function trackedAuthIpCount() {
  return authBuckets.size;
}

function authLimitPerWindow() {
  const raw = process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN;
  if (raw === undefined || raw === '') {
    // Fall back to the mutation limit; if that is also unset, disabled.
    return limitPerWindow();
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

function clientIp(req) {
  // Trust X-Forwarded-For when present (common behind a reverse proxy); fall
  // back to the raw socket address. Only the first hop is used.
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim() !== '') {
    return fwd.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

function pruneAuthExpired(now, span) {
  for (const [ip, bucket] of authBuckets) {
    if (now - bucket.windowStartMs >= span) authBuckets.delete(ip);
  }
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
  const ip = clientIp(req);
  pruneAuthExpired(now, span);
  let bucket = authBuckets.get(ip);
  if (!bucket || now - bucket.windowStartMs >= span) {
    bucket = { count: 0, windowStartMs: now };
    authBuckets.set(ip, bucket);
  }
  bucket.count += 1;
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
  const ip = clientIp(req);
  pruneAuthExpired(now, span);
  const bucket = authBuckets.get(ip);
  if (!bucket) return null;
  if (now - bucket.windowStartMs >= span) return null;
  if (bucket.count >= limit) {
    return Math.max(0, bucket.windowStartMs + span - now);
  }
  return null;
}
