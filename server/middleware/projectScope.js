import * as store from '../store.js';

/**
 * §2.1 project resolution order:
 *   ?project= query > ?workspace= alias > X-Kanban-Project header
 */
export function rawProjectScope(req) {
  return (
    req.query?.project ??
    req.query?.workspace ??
    req.headers['x-kanban-project']
  );
}

/**
 * Rejects a supplied-but-invalid project scope instead of letting it widen.
 *
 * A bad value resolves to `undefined`, and `store.getTasks(undefined)` /
 * `getMetrics(undefined)` mean *every* project — so without this a caller that
 * believes it is scoped to one project silently receives the whole portfolio,
 * and a write silently lands in `default`. The store already returns nothing
 * for a bad id; this stops the route defeating that guard.
 *
 * Shared rather than per-router on purpose: a new router that forgets it
 * re-opens the bug on its own endpoints.
 */
export function projectScopeGuard() {
  return (req, res, next) => {
    const raw = rawProjectScope(req);
    if (raw === undefined || raw === null || raw === '') return next();
    if (typeof raw === 'string' && store.isValidProjectId(raw)) return next();
    return res.status(400).json({ error: `Invalid project scope: ${String(raw)}` });
  };
}
