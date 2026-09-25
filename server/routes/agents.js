import { Router } from 'express';
import * as store from '../store.js';
import { projectScopeGuard } from '../middleware/projectScope.js';

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
 */
router.post('/:agent_id/heartbeat', asyncHandler(async (req, res) => {
  const agentId = req.params.agent_id;
  const caller = req.caller || {};
  const isSelf = Boolean(caller.agent_id) && caller.agent_id === agentId;
  if (!isSelf && !store.isPrivilegedRole(caller.role)) {
    return res.status(403).json({ error: 'Forbidden: may only heartbeat your own agent id' });
  }
  const project = req.query?.project ?? req.query?.workspace ?? req.headers?.['x-kanban-project'];
  const result = await store.renewAllLeases(agentId, { project, caller });
  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }
  return res.status(200).json({ renewed: result.renewed, count: result.count });
}));

export default router;