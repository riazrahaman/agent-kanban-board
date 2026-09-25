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
    backup: store.backupStatus(),
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  });
}));

/**
 * ENH-05 (v2.7.0): GET /api/health/ready — readiness probe.
 *
 * Returns HTTP 200 `{ready:true, store_loaded:true, ...}` when the store is
 * loaded, else HTTP 503 `{ready:false, store_loaded:false, ...}`. Read-only and
 * unauthenticated, same contract as the liveness endpoint. Mounted before the
 * SPA catch-all. The liveness `GET /` and the `/healthz` alias are unchanged.
 */
router.get('/ready', asyncHandler(async (req, res) => {
  const loaded = store.isStoreLoaded();
  if (loaded) {
    return res.status(200).json({
      ready: true,
      store_loaded: true,
      uptime_seconds: Math.round(process.uptime()),
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
    });
  }
  return res.status(503).json({
    ready: false,
    store_loaded: false,
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  });
}));

export default router;
