import { Router } from 'express';
import * as store from '../store.js';
import { projectScopeGuard, rawProjectScope } from '../middleware/projectScope.js';

const router = Router();

const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

router.use(projectScopeGuard());

/**
 * §2.4b POST /api/agents/:agent_id/heartbeat — renew EVERY lease the agent holds
 * in one call (v2.12.0, RC-2). A non-privileged caller may only heartbeat its
 * own agent id; a privileged caller (runner/system/human/admin) may renew on
 * another agent's behalf. An optional `?project=` narrows the sweep to one
 * project. Lapsed leases are not revived (see store.renewAllLeases).
 *
 * v2.12.1 fixups (post-release review):
 *   I-4 — privilege is derived from the CREDENTIAL (`store.callerIsPrivileged`,
 *         mirroring the destructive-op check in store.js), never from the
 *         self-asserted `X-Agent-Role` header alone. A per-project worker
 *         token cannot grant itself cross-agent access by sending
 *         `X-Agent-Role: admin`.
 *   I-3 — a NON-privileged caller must supply an explicit `?project=` (or
 *         `?workspace=` / `X-Kanban-Project`) scope. Without this, a
 *         single-project credential could renew that agent's leases in every
 *         project on the board — the auth middleware authorizes this route
 *         against the referenced project(s), but a bulk sweep with no scope
 *         silently referenced ALL of them. Only a privileged credential may
 *         omit the scope for the intentional all-projects sweep.
 */
router.post('/:agent_id/heartbeat', asyncHandler(async (req, res) => {
  const agentId = req.params.agent_id;
  const caller = req.caller || {};
  const isSelf = Boolean(caller.agent_id) && caller.agent_id === agentId;
  const isPrivileged = store.callerIsPrivileged(caller);
  if (!isSelf && !isPrivileged) {
    return res.status(403).json({ error: 'Forbidden: may only heartbeat your own agent id' });
  }
  const project = rawProjectScope(req);
  if (!isPrivileged && (project === undefined || project === null || project === '')) {
    return res.status(400).json({
      error: 'project scope (?project=) is required for a non-privileged heartbeat',
    });
  }
  const result = await store.renewAllLeases(agentId, { project, caller });
  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }
  return res.status(200).json({ renewed: result.renewed, count: result.count });
}));

export default router;
