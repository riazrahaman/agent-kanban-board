import { Router } from 'express';
import * as store from '../store.js';

const router = Router();

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

router.get('/', (req, res) => {
  res.json(store.getTasks());
});

router.post('/', asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const result = await store.createTask(body);
  if (result.error) {
    console.warn(`[kanban rejection] POST /api/tasks: ${result.status} ${result.error}`);
    return res.status(result.status).json({ error: result.error });
  }
  res.status(201).json(result.task);
}));

router.get('/:id', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

router.patch('/:id', asyncHandler(async (req, res) => {
  const patch = req.body ?? {};
  const result = await store.patchTask(req.params.id, patch, {
    caller: req.caller || {},
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

  const result = await store.claimTask(req.params.id, agentId);
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

  const result = await store.appendLog(req.params.id, agentId, message);
  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }
  res.status(200).json(result.task);
}));

router.get('/:id/issues', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ issues: task.issues || [] });
});

router.post('/:id/issues', asyncHandler(async (req, res) => {
  const { issue_id } = req.body ?? {};
  if (!issue_id) {
    return res.status(400).json({ error: 'issue_id is required' });
  }

  const result = await store.addIssue(req.params.id, issue_id);
  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }
  res.status(200).json(result);
}));

export default router;
