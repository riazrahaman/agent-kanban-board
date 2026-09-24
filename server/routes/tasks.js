import { Router } from 'express';
import * as store from '../store.js';
import { VALID_ROLES } from '../middleware/auth.js';
import { projectScopeGuard } from '../middleware/projectScope.js';

const router = Router();

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * §2.1 project resolution order:
 *   ?project= query > ?workspace= alias > X-Kanban-Project header
 * An empty/invalid value yields undefined so the caller falls back to the
 * task's own project or the default.
 */
function resolveProjectFromReq(req) {
  const raw =
    req.query?.project ??
    req.query?.workspace ??
    req.headers['x-kanban-project'];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'string' && store.isValidProjectId(raw)) return raw;
  return undefined;
}

/**
 * §2.6: resolve the expected-version guard for a mutation. A body
 * `expected_version` takes precedence; otherwise an `If-Match` header
 * (Etag-style bare int) is used. Returns `{ expected_version }` so the store
 * runs the CAS check; returns `null` when no guard was supplied.
 */
function resolveExpectedVersion(req) {
  const fromBody = req.body?.expected_version;
  if (fromBody !== undefined && fromBody !== null && fromBody !== '') {
    return { expected_version: fromBody };
   }
  const header = req.headers['if-match'];
  if (header !== undefined && header !== null && header !== '') {
    // Express may surface the header as an array on repeated names; coerce.
    const value = Array.isArray(header) ? header[0] : header;
   return { expected_version: value };
   }
  return null;
}

// A supplied-but-invalid project scope is a client error, never a widening.
// Shared with the metrics router — see middleware/projectScope.js.
router.use(projectScopeGuard());

// --- Collection ---------------------------------------------------------

router.get('/', asyncHandler(async (req, res) => {
  // §2.8 lazy sweep before every list read.
  await store.runArchiveSweep();
  const project = resolveProjectFromReq(req);
  res.json(store.getTasks(project));
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = req.body ?? {};
   // §2.1: project may arrive as body.project, body.workspace_id, or ?project=.
  const project = resolveProjectFromReq(req);
  const result = await store.createTask(body, project);
  if (result.error) {
    console.warn(`[kanban rejection] POST /api/tasks: ${result.status} ${result.error}`);
    return res.status(result.status).json({ error: result.error });
   }
  res.status(201).json(result.task);
}));

// --- §2.8 archive (MUST be declared before /:id so Express treats `archive`
//     as a static segment, not an :id match) ----------------------------

router.get('/archive', asyncHandler(async (req, res) => {
  await store.runArchiveSweep();
  const project = resolveProjectFromReq(req);
  res.json(store.getArchivedTasks(project));
}));

router.post('/archive/sweep', asyncHandler(async (req, res) => {
  const moved = await store.runArchiveSweep();
  res.json({ moved, projects: store.getProjectSummaries() });
}));

// --- §admin-purge bulk purge (MUST be declared before /:id so Express treats
//     `purge` as a static segment, not an :id match) ----------------------

router.post('/purge', asyncHandler(async (req, res) => {
  const result = await store.purgeTasks({
    caller: req.caller || {},
    project: resolveProjectFromReq(req),
    ids: req.body?.ids,
    filter: req.body?.filter,
  });
  if (result.error) {
    console.warn(`[kanban rejection] POST /api/tasks/purge: ${result.status} ${result.error}`);
    return res.status(result.status).json({ error: result.error });
  }
  res.status(result.status).json({ deleted: result.deleted, count: result.count });
}));

// --- §2.7 fair claim queue (MUST be declared before /:id so Express treats
//     `next-claim` as a static segment, not an :id match) ------------------

/**
 * §2.7 POST /api/tasks/next-claim — atomically select + claim the highest-
 * priority, unclaimed, dependency-satisfied BACKLOG task for the caller.
 * The caller's role is taken from the authenticated identity only (never the
 * query string). Query: ?project= (accepted, no-op today), ?agent_id= (falls
 * back to the caller's agent_id). Returns 200 + the claimed task, or 204 when
 * nothing is claimable.
 */
router.post('/next-claim', asyncHandler(async (req, res) => {
  const agentId =
    req.query?.agent_id ||
    req.body?.agent_id ||
    req.caller?.agent_id;
  if (!agentId) {
    return res.status(400).json({ error: 'agent_id is required' });
    }

  // §2.7: the role is taken from the authenticated caller only, never the query
  // string, so an authenticated `builder` cannot elevate to `reviewer` via
  // `?role=reviewer`. It is still validated against VALID_ROLES (403 on bad).
  const rawRole = req.caller?.role;
  if (rawRole !== undefined && rawRole !== null && rawRole !== '') {
    const role = typeof rawRole === 'string' ? rawRole.toLowerCase() : null;
    if (!role || !VALID_ROLES.has(role)) {
      console.warn(`[kanban next-claim] 403 invalid role: ${rawRole}`);
      return res.status(403).json({
        error: `A valid agent role is required for next-claim (got '${rawRole}')`,
       });
    }
   }

   // §2.7: project scoping is a no-op today (accepted, ignored — §2.1 lands it).
    const project = resolveProjectFromReq(req);
    const result = await store.nextClaim({
      agentId,
      role: rawRole ? String(rawRole).toLowerCase() : undefined,
      project,
     });

     if (result.unavailable) {
        return res.status(204).end();
    }
     if (result.error) {
      console.warn(
        `[kanban next-claim] ${result.status} ${result.error} ${result.reason || ''}`
        );
      return res.status(result.status).json({
        error: result.error,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.unresolved_dependencies
           ? { unresolved_dependencies: result.unresolved_dependencies }
           : {}),
       });
     }
     return res.status(200).json(result.task);
     }));

// --- Single task --------------------------------------------------------

router.get('/:id', asyncHandler(async (req, res) => {
  const task = store.getTask(req.params.id, resolveProjectFromReq(req));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await store.deleteTask(req.params.id, {
    caller: req.caller || {},
    project: resolveProjectFromReq(req),
  });
  if (result.error) {
    console.warn(`[kanban rejection] DELETE /api/tasks/${req.params.id}: ${result.status} ${result.error}`);
    return res.status(result.status).json({ error: result.error });
  }
  res.status(200).json(result.task);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const patch = { ...(req.body ?? {}) };
  const guard = resolveExpectedVersion(req);
  if (guard) patch.expected_version = guard.expected_version;
  const result = await store.patchTask(req.params.id, patch, {
      caller: req.caller || {},
      project: resolveProjectFromReq(req),
      });
  if (result.error) {
        // §2.6: a version-conflict 409 carries the current vs. supplied version
        // so the client can re-fetch and re-apply; surface its details verbatim.
    if (result.status === 409 && result.details) {
     console.warn(
      `[kanban version-conflict] PATCH /api/tasks/${req.params.id}: 409 ` +
       `expected=${result.details.expected} provided=${result.details.provided}`
       );
      return res.status(409).json({
        error: result.error,
        details: result.details,
        currentVersion: result.details.expected,
        status: 409,
       });
       }
    console.warn(
        `[kanban rejection] PATCH /api/tasks/${req.params.id}: ${result.status} ${result.error}`
       );
        // §2.5: a dependency-conflict 409 carries a `reason` +
        // `unresolved_dependencies` so callers can branch on "blocked on deps"
        // (mirrors the claim route's shape; a contention/version 409 carries no
        // reason).
    if (result.status === 409 && result.reason) {
     return res.status(409).json({
        error: result.error,
        reason: result.reason,
           ...(result.unresolved_dependencies
              ? { unresolved_dependencies: result.unresolved_dependencies }
              : {}),
         status: 409,
          });
    }
    return res.status(result.status).json({ error: result.error });
      }
  res.status(200).json(result.task);
}));

router.post('/:id/claim', asyncHandler(async (req, res) => {
  const agentId = req.body?.agent_id || req.caller?.agent_id;
  if (!agentId) {
    return res.status(400).json({ error: 'agent_id is required' });
      }

  const guard = resolveExpectedVersion(req);
  const result = await store.claimTask(
        req.params.id, agentId, resolveProjectFromReq(req), guard || {},
       );
  if (result.error) {
        // §2.6: distinguish a version-conflict 409 from contention 409. A stale
        // claim ("Version mismatch") carries the current version for retry; a
        // contention 409 ("… already claimed by …") carries no version.
    if (result.status === 409 && result.details) {
     return res.status(409).json({
        error: result.error,
        details: result.details,
        currentVersion: result.details.expected,
        status: 409,
         });
     }
       // §2.5: a dependency-conflict 409 carries a `reason` +
       // `unresolved_dependencies` so callers can branch on "blocked on deps"
       // (distinct from a contention 409, which carries no reason).
    if (result.status === 409 && result.reason) {
     return res.status(409).json({
        error: result.error,
        reason: result.reason,
           ...(result.unresolved_dependencies
              ? { unresolved_dependencies: result.unresolved_dependencies }
              : {}),
         status: 409,
          });
    }
    console.warn(
          `[kanban rejection] POST /api/tasks/${req.params.id}/claim: ${result.status} ${result.error}`
           );
    return res.status(result.status).json({ error: result.error });
      }
  res.status(200).json(result.task);
}));

// --- §2.4 lease heartbeat ------------------------------------------------

/**
 * §2.4 POST /api/tasks/:id/heartbeat — renew the lease on a held task. The
 * HOLDER (the builder/reviewer/tester that owns it) or a PRIVILEGED role
 * (runner/system/human/admin) may renew; a non-privileged non-holder gets a
 * `not_lease_holder` 409, an unclaimed task a `not_claimed` 409, a missing task
 * a 404. Runs in the mutation lock. No log entry by default (no spam).
 */
router.post('/:id/heartbeat', asyncHandler(async (req, res) => {
  const agentId = req.body?.agent_id || req.caller?.agent_id;
  if (!agentId) {
    return res.status(400).json({ error: 'agent_id is required' });
      }

   const result = await store.renewLease(req.params.id, agentId, {
    caller: req.caller || {},
    project: resolveProjectFromReq(req),
    });

     if (result.error) {
        // Distinguish the lease 409s with a reason tag.
      if (result.status === 409) {
        console.warn(
          `[kanban heartbeat] 409 ${result.reason || ''} on ${req.params.id}`
          );
        return res.status(409).json({
          error: result.error,
          ...(result.reason ? { reason: result.reason } : {}),
         });
       }
      console.warn(
        `[kanban rejection] POST /api/tasks/${req.params.id}/heartbeat: ${result.status} ${result.error}`
        );
      return res.status(result.status).json({ error: result.error });
      }
     return res.status(200).json(result.task);
      }));

router.post('/:id/logs', asyncHandler(async (req, res) => {
  const agentId = req.body?.agent_id || req.caller?.agent_id;
  const message = req.body?.message;
  if (!agentId || !message) {
    return res.status(400).json({ error: 'agent_id and message are required' });
       }

  const guard = resolveExpectedVersion(req);
  const result = await store.appendLog(
        req.params.id, agentId, message, resolveProjectFromReq(req), guard || {},
        );
  if (result.error) {
    if (result.status === 409 && result.details) {
     return res.status(409).json({
        error: result.error,
        details: result.details,
        currentVersion: result.details.expected,
        status: 409,
         });
     }
    return res.status(result.status).json({ error: result.error });
       }
  res.status(200).json(result.task);
}));

router.get('/:id/issues', (req, res) => {
  const task = store.getTask(req.params.id, resolveProjectFromReq(req));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ issues: task.issues || [] });
});

router.post('/:id/issues', asyncHandler(async (req, res) => {
  const { issue_id } = req.body ?? {};
  if (!issue_id) {
    return res.status(400).json({ error: 'issue_id is required' });
       }

  const guard = resolveExpectedVersion(req);
  const result = await store.addIssue(
        req.params.id, issue_id, resolveProjectFromReq(req), guard || {},
        );
  if (result.error) {
    if (result.status === 409 && result.details) {
     return res.status(409).json({
        error: result.error,
        details: result.details,
        currentVersion: result.details.expected,
        status: 409,
         });
     }
    return res.status(result.status).json({ error: result.error });
       }
  res.status(200).json(result);
}));

// v2.5.0: append a comment to a task's discussion thread. Mirrors /:id/logs —
// agent_id + message required, §2.6 CAS guard, 409 details passthrough.
router.post('/:id/comments', asyncHandler(async (req, res) => {
  const agentId = req.body?.agent_id || req.caller?.agent_id;
  const message = req.body?.message;
  if (!agentId || !message || typeof message !== 'string') {
    return res.status(400).json({ error: 'agent_id and message are required' });
       }

  const guard = resolveExpectedVersion(req);
  const result = await store.addComment(
        req.params.id, agentId, message, resolveProjectFromReq(req), guard || {},
        );
  if (result.error) {
    if (result.status === 409 && result.details) {
     return res.status(409).json({
        error: result.error,
        details: result.details,
        currentVersion: result.details.expected,
        status: 409,
         });
     }
    return res.status(result.status).json({ error: result.error });
       }
  res.status(200).json(result.task);
}));

export default router;
