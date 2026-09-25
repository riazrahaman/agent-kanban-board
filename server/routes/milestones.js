import { Router } from 'express';
import * as store from '../store.js';
import { projectScopeGuard, rawProjectScope } from '../middleware/projectScope.js';

const router = Router();

/**
 * opt-milestones (v2.11.0) — GET /api/milestones.
 * Groups in-flight cards by their `milestone` label and reports per-goal
 * progress. Scoped to one project via `?project=`, or every project when the
 * scope is absent. Open read, like the other GET endpoints.
 */
router.use(projectScopeGuard());

router.get('/', (req, res) => {
  const raw = rawProjectScope(req);
  if (raw !== undefined && raw !== null && raw !== '' && typeof raw !== 'string') {
    return res.status(400).json({ error: `Invalid project scope: ${String(raw)}` });
  }
  const project = typeof raw === 'string' && raw !== '' ? raw : undefined;
  res.json({ milestones: store.getMilestones(project) });
});

export default router;
