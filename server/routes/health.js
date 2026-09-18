import { Router } from 'express';
import { createRequire } from 'node:module';
import * as store from '../store.js';

const require = createRequire(import.meta.url);
// Single source of truth for the deployed version: server/package.json.
const { version: APP_VERSION } = require('../package.json');

const router = Router();

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * §health — GET /api/health (and /healthz alias).
 *
 * Read-only liveness + readiness probe for load-balancers and operators. It
 * reports store state without any mutation, and is intentionally unauthenticated
 * (a GET, matching the open-read contract of the other read routes). Mounted in
 * createApp() before the SPA catch-all so it is never swallowed by the index.
 */
router.get('/', asyncHandler(async (req, res) => {
  const loaded = store.isStoreLoaded();
  const live = store.getTasks();
  const reaperEnabled = store.isReaperEnabled();

  res.json({
    status: loaded && reaperEnabled ? 'ok' : 'degraded',
    uptime_seconds: Math.round(process.uptime()),
    store_loaded: loaded,
    tasks_total: live.length,
    tasks_live: live.length,
    listeners: store.listenerCounts(),
    reaper: {
      enabled: reaperEnabled,
      running: store.isReaperRunning(),
    },
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  });
}));

export default router;
