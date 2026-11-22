import { Router } from 'express';
import * as store from '../store.js';
import { projectScopeGuard, rawProjectScope } from '../middleware/projectScope.js';

const router = Router();

const asyncHandler = (handler) =>
  (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// Display settings (column colors): a project's own palette, or - with no
// project scope - the BOARD-WIDE palette every project inherits (stored as the
// default project's settings; see store.getSettings for the resolution order).
// GET is a public read (matching every other GET). PUT is a gated mutation:
// the auth middleware derives its project-authorization set from
// referencedProjects(req), which reads ?project=, so per-project token
// isolation applies unchanged - a project token saves its own project, the
// admin/shared token saves anything. The master unlock (X-Kanban-Unlock, see
// masterUnlock.js) is also accepted here and ONLY here: saving column colors,
// board-wide or per project, is the one write it may perform. Either way the
// payload goes through the store's color validation.
router.use(projectScopeGuard());

router.get('/', (req, res) => {
  const raw = rawProjectScope(req);
  const project = typeof raw === 'string' && raw !== '' ? raw : undefined;
  res.json(store.getSettings(project));
});

router.put('/', asyncHandler(async (req, res) => {
  const raw = rawProjectScope(req);
  const project = typeof raw === 'string' && raw !== '' ? raw : undefined;
  const result = await store.updateSettings(project, req.body ?? {}, { caller: req.caller || {} });
  if (result.error) {
    return res.status(result.status).json({ error: result.error, ...(result.reason === 'outcome_unknown' ? { reason: result.reason } : {}) });
  }
  res.status(200).json(result);
}));

export default router;