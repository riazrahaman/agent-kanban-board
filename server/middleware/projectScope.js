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
 * The task-id path segment of a task route, or null. Only `/api/tasks/:id...`
 * and `/api/tasks/trash/:id...` carry task ids; other routes (for example
 * `/api/agents/:agent_id/heartbeat`, whose ids may legitimately contain a
 * colon) never carry a composite project id.
 */
function taskIdSegment(fullPath) {
  const parts = String(fullPath || '').split('/').filter(Boolean);
  if (parts[0]?.toLowerCase() !== 'api' || parts[1]?.toLowerCase() !== 'tasks') return null;
  const first = parts[2];
  if (first === undefined) return null;
  const lower = first.toLowerCase();
  if (lower === 'trash') return parts[3] ?? null;
  if (lower === 'archive' || lower === 'purge' || lower === 'next-claim') return null;
  return first;
}

/** Valid `project:id` prefix of the task-id path segment (task routes only). */
export function compositePathProjects(req) {
  const found = new Set();
  const segment = taskIdSegment(`${req.baseUrl || ''}${req.path || ''}`);
  if (segment === null) return found;
  // This mirrors resolveProjectScope's rule: a `:`-prefixed id counts only when
  // the prefix is a valid project id and something follows it. Decode BEFORE
  // looking for the separator (req.path is still percent-encoded).
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape cannot be a valid composite id; fall back to raw.
  }
  const idx = decoded.indexOf(':');
  if (idx > 0 && decoded.length > idx + 1) {
    const prefix = decoded.slice(0, idx);
    if (store.isValidProjectId(prefix)) found.add(prefix);
  }
  return found;
}

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

  for (const id of compositePathProjects(req)) out.add(id);

  return [...out];
}

/**
 * SEC-101 follow-up: every non-blank string project channel (query project /
 * workspace, X-Kanban-Project, body project / workspace_id) as trimmed values.
 * Blank means absent, as everywhere else.
 */
function channelProjects(req) {
  const out = [];
  for (const v of [
    req.query?.project,
    req.query?.workspace,
    req.headers?.['x-kanban-project'],
    req.body?.project,
    req.body?.workspace_id,
  ]) {
    if (typeof v === 'string' && !isBlank(v)) out.push(v.trim());
  }
  return out;
}

/**
 * A request must name ONE project. Channels that disagree with each other, or
 * with a composite `project:id` path prefix, are rejected rather than resolved
 * by precedence. Returns the conflicting ids, or null when consistent.
 */
export function conflictingProjectChannels(req) {
  const channels = channelProjects(req);
  const all = new Set(channels);
  for (const id of compositePathProjects(req)) all.add(id);
  return all.size > 1 ? [...all] : null;
}

export function projectScopeGuard() {
  return (req, res, next) => {
    normalizeBodyScope(req);
    if (conflictingProjectChannels(req)) {
      return res.status(400).json({
        error: 'Conflicting project scope: query, header, body and path must name the same project',
      });
    }
    const raw = rawProjectScope(req);
    if (raw === undefined || raw === null || raw === '') return next();
    if (typeof raw === 'string' && store.isValidProjectId(raw)) return next();
    return res.status(400).json({ error: `Invalid project scope: ${String(raw)}` });
  };
}
