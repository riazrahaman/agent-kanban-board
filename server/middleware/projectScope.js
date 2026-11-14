import * as store from '../store.js';

/**
 * §2.1 project resolution order:
 *   ?project= query > ?workspace= alias > X-Kanban-Project header
 */
const isBlank = (v) => typeof v === 'string' && v.trim() === '';

/**
 * A blank (empty or whitespace-only) value in any channel means "absent" and
 * is skipped, so a blank `?project=` can no longer shadow a real
 * `?workspace=` / header value. `??` would not skip '' — hence the filter.
 */
export function rawProjectScope(req) {
  return [
    req.query?.project,
    req.query?.workspace,
    req.headers?.['x-kanban-project'],
    // Body channels are authorised too (referencedProjects), so they must also
    // route; otherwise a body-only scope is authorised for one project while
    // the route falls back to default.
    req.body?.project,
    req.body?.workspace_id,
  ].find((v) => v !== undefined && v !== null && !isBlank(v));
}

/**
 * Drops blank body `project` / `workspace_id` so the store's `??` chain
 * (body.project ?? body.workspace_id ?? query) cannot stop on a blank and
 * resolve a different project than the one authorisation checked.
 */
export function normalizeBodyScope(req) {
  const b = req.body;
  if (!b || typeof b !== 'object') return;
  for (const k of ['project', 'workspace_id']) {
    if (isBlank(b[k])) delete b[k];
  }
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
/**
 * Every project id a request references, from any channel that can influence
 * which board is touched: the body (`project` / `workspace_id`), the query
 * (`project` / `workspace`) and the `X-Kanban-Project` header.
 *
 * §2.3 authorizes against *all* of them rather than against one "effective"
 * value on purpose. `store.createTask` resolves `data.project ?? data.
 * workspace_id ?? projectArg` — the body outranks the query — so a check that
 * looked only at `?project=` would authorize project A while the task landed in
 * project B. Requiring authorization for every referenced id makes that class
 * of bypass impossible even if the store's precedence changes later.
 *
 * Returns raw (unvalidated) strings; the caller decides what to do with an id
 * that is malformed or unknown.
 */
export function referencedProjects(req) {
  const candidates = [
    req.body?.project,
    req.body?.workspace_id,
    req.query?.project,
    req.query?.workspace,
    req.headers?.['x-kanban-project'],
  ];
  const out = new Set();
  for (const c of candidates) {
    if (typeof c === 'string' && !isBlank(c)) out.add(c);
  }

  // A composite `project:id` in the URL path is the fourth channel, and the
  // sneakiest: `store.resolveProjectScope` lets that prefix OVERRIDE ?project=,
  // so `PATCH /api/tasks/beta:victim?project=alpha` resolves to beta. Ignoring
  // it let an alpha token rewrite a beta task on every task-scoped route, and
  // let a flood at `/api/tasks/beta:t/claim` be charged to the wrong budget.
  // This mirrors resolveProjectScope's rule exactly: a `:`-prefixed segment
  // counts only when the prefix is a valid project id and something follows it.
  for (const segment of String(req.path || '').split('/')) {
    if (segment === '') continue;
    // Decode BEFORE looking for the separator: req.path is still percent-
    // encoded, so `beta%3Avictim` contains no literal ':' and a pre-decode
    // check would wave the encoded form of the very same attack straight
    // through. Express hands the route the decoded id, so decoding is what
    // the store will actually see.
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // A malformed escape cannot be a valid composite id; fall back to raw.
    }
    if (!decoded.includes(':')) continue;
    const idx = decoded.indexOf(':');
    if (idx <= 0 || decoded.length <= idx + 1) continue;
    const prefix = decoded.slice(0, idx);
    if (store.isValidProjectId(prefix)) out.add(prefix);
  }

  return [...out];
}

export function projectScopeGuard() {
  return (req, res, next) => {
    normalizeBodyScope(req);
    const raw = rawProjectScope(req);
    if (raw === undefined || raw === null || raw === '') return next();
    if (typeof raw === 'string' && store.isValidProjectId(raw)) return next();
    return res.status(400).json({ error: `Invalid project scope: ${String(raw)}` });
  };
}
