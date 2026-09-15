import { Router } from 'express';
import * as store from '../store.js';

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

// --- Single task --------------------------------------------------------

router.get('/:id', asyncHandler(async (req, res) => {
  const task = store.getTask(req.params.id, resolveProjectFromReq(req));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const patch = req.body ?? {};
  const result = await store.patchTask(req.params.id, patch, {
    caller: req.caller || {},
    project: resolveProjectFromReq(req),
   });
  if (result.error) {
    console.warn(
       `[kanban rejection] PATCH /api/tasks/${req.params.id}: ${result.status} ${result.error}`
     );
    return res.status(result.status).json({ error: result.error });
   }
  res.status(200).json(result.task);
}));

router.post('/:id/claim', asyncHandler(async (req, res) => {
  const agentId = req.body?.agent_id || req.caller?.agent_id;
  if (!agentId) {
    return res.status(400).json({ error: 'agent_id is required' });
   }

  const result = await store.claimTask(req.params.id, agentId, resolveProjectFromReq(req));
  if (result.error) {
    console.warn(
       `[kanban rejection] POST /api/tasks/${req.params.id}/claim: ${result.status} ${result.error}`
     );
    return res.status(result.status).json({ error: result.error });
   }
  res.status(200).json(result.task);
}));

router.post('/:id/logs', asyncHandler(async (req, res) => {
  const agentId = req.body?.agent_id || req.caller?.agent_id;
  const message = req.body?.message;
  if (!agentId || !message) {
    return res.status(400).json({ error: 'agent_id and message are required' });
   }

  const result = await store.appendLog(req.params.id, agentId, message, resolveProjectFromReq(req));
  if (result.error) {
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

  const result = await store.addIssue(req.params.id, issue_id, resolveProjectFromReq(req));
  if (result.error) {
    return res.status(result.status).json({ error: result.error });
   }
  res.status(200).json(result);
}));

export default router;
