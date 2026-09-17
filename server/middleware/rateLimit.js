import { referencedProjects } from './projectScope.js';
import { defaultProjectName } from '../store.js';

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

export function createRateLimitMiddleware() {
  return (req, res, next) => {
    const limit = limitPerWindow();
    if (limit === 0) return next();

    const isMutation = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);
    if (!isMutation) return next();

    const span = windowMs();
    const now = Date.now();
    const referenced = referencedProjects(req);
    const scopes = referenced.length > 0 ? referenced : [defaultProjectName()];

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
