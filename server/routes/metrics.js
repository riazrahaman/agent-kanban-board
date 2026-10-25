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
  await store.runArchiveSweep({ lazy: true });
  const raw = rawProjectScope(req);
  const project = typeof raw === 'string' && raw !== '' ? raw : undefined;
  let metrics = store.getMetrics(project);
  if (!metrics) {
    return res.status(400).json({ error: `Invalid project scope: ${String(raw)}` });
  }
  // Deep-review (auth P2): per-token read isolation applies to metrics too —
  // a caller whose authorized set excludes a project must see nothing from it.
  const allowed = req.caller?.authorizedProjects;
  if (allowed instanceof Set) {
    if (project && !allowed.has(project)) {
      metrics = [];
    } else if (Array.isArray(metrics)) {
      metrics = metrics.filter((m) => allowed.has(m.project));
    }
  }
  res.json(metrics);
}));

export default router;
