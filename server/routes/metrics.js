import { Router } from 'express';
import * as store from '../store.js';
import { projectScopeGuard, rawProjectScope } from '../middleware/projectScope.js';

const router = Router();

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// Without this a malformed scope would fall through to `undefined` and silently
// aggregate the whole portfolio for a caller that believes it is scoped.
router.use(projectScopeGuard());

/**
 * §2.9 GET /api/metrics[?project=X]
 *
 * Unscoped returns every project plus an aggregate; scoped returns just that
 * project (and an aggregate over it). Open to reads like the other GETs.
 */
router.get('/', asyncHandler(async (req, res) => {
  // Lazy sweep first, so archived counts and cycle time reflect current state.
  await store.runArchiveSweep();
  const raw = rawProjectScope(req);
  const project = typeof raw === 'string' && raw !== '' ? raw : undefined;
  const metrics = store.getMetrics(project);
  if (!metrics) {
    return res.status(400).json({ error: `Invalid project scope: ${String(raw)}` });
  }
  res.json(metrics);
}));

export default router;
