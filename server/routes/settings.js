import { Router } from 'express';
import * as store from '../store.js';
import { projectScopeGuard, rawProjectScope } from '../middleware/projectScope.js';

const router = Router();

const asyncHandler = (handler) =>
  (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// v2.5.0: per-project display settings (column colors). GET is a public read
// (matching every other GET); PUT is a token-gated mutation — the auth
// middleware derives its project-authorization set from referencedProjects(req)
// which reads ?project=, so per-project token isolation applies unchanged.
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
    return res.status(result.status).json({ error: result.error });
  }
  res.status(200).json(result);
}));

export default router;