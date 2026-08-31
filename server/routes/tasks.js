import { Router } from 'express';
import * as store from '../store.js';

const router = Router();

router.get('/', (req, res) => {
  res.json(store.getTasks());
});

router.post('/', async (req, res) => {
  const body = req.body ?? {};
  if (!body.id || !body.title) {
    return res.status(400).json({ error: 'id and title are required' });
  }
  if (body.status && !store.isValidStatus(body.status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const created = await store.createTask(body);
  res.status(201).json(created);
});


router.get('/:id', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

router.patch('/:id', async (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const patch = req.body ?? {};
  if ('status' in patch && !store.isValidStatus(patch.status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const updated = await store.patchTask(req.params.id, patch);
  res.json(updated);
});

router.post('/:id/claim', async (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { agent_id } = req.body ?? {};
  if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });

  const updated = await store.claimTask(req.params.id, agent_id);
  res.json(updated);
});

router.post('/:id/logs', async (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { agent_id, message } = req.body ?? {};
  if (!agent_id || !message) {
    return res.status(400).json({ error: 'agent_id and message are required' });
  }

  const updated = await store.appendLog(req.params.id, agent_id, message);
  res.json(updated);
});

export default router;
