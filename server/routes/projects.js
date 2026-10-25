import { Router } from 'express';
import * as store from '../store.js';
import { getAuthorizedProjects, parseProjectTokens } from '../middleware/auth.js';

const router = Router();

/**
 * §2.1 / §2.11 — per-project portfolio summary.
 * Returns `[{ project, task_count, done_count, live_count, archived_count, updated }]`
 * sorted by project, restricted to authorized project(s) under per-token isolation.
 */
router.get('/', asyncHandler(async (req, res) => {
  // Lazy archive sweep so archived_count reflects the freshest state.
  await store.runArchiveSweep({ lazy: true });
  const projectTokens = parseProjectTokens();
  const authorized = getAuthorizedProjects(req);

  // When per-project isolation is active (KANBAN_PROJECT_TOKENS configured):
  if (projectTokens?.map) {
    if (authorized === '*') {
      return res.json(store.getProjectSummaries());
    }
    if (authorized instanceof Set) {
      return res.json(store.getProjectSummaries().filter((s) => authorized.has(s.project)));
    }
    // Anonymous or invalid token under isolation mode
    return res.json([]);
  }

  // Legacy single-tenant mode (no per-project token map)
  if (authorized instanceof Set) {
    return res.json(store.getProjectSummaries().filter((s) => authorized.has(s.project)));
  }
  return res.json(store.getProjectSummaries());
}));

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export default router;
