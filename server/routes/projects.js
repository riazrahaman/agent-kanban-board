import { Router } from 'express';
import * as store from '../store.js';

const router = Router();

/**
 * §2.1 — per-project portfolio summary.
 * Returns `[{ project, task_count, done_count, live_count, archived_count, updated }]`
 * sorted by project. Open to reads like the other GET endpoints (no token).
 */
router.get('/', asyncHandler(async (req, res) => {
  // Lazy archive sweep so archived_count reflects the freshest state.
  await store.runArchiveSweep();
  res.json(store.getProjectSummaries());
}));

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export default router;
