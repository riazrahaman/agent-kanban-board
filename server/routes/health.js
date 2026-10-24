import { Router } from 'express';
import { createRequire } from 'node:module';
import * as store from '../store.js';
import { parseProjectTokens, getAuthorizedProjects } from '../middleware/auth.js';
import { checkCredentialCoverage } from '../utils/credentialMap.js';
import { deployDriftStatus } from '../deployDrift.js';

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

  // §2.10 / §2.11: surface credential-map coverage so a monitoring probe sees a
  // truncated token map without reading logs. Read-only; never exposes a token
  // value.
  //
  // Project NAMES are withheld from anonymous callers. When authenticated,
  // admin tokens receive all names, while project-scoped tokens only receive
  // missing/extra project names within their authorized scope.
  const coverage = checkCredentialCoverage(
    store.getProjectSummaries().map((s) => s.project),
    parseProjectTokens()
  );
  const authorized = getAuthorizedProjects(req);
  let nameDisclosure = null;
  if (authorized === '*') {
    nameDisclosure = { missing: coverage.missing, extra: coverage.extra };
  } else if (authorized instanceof Set) {
    nameDisclosure = {
      missing: coverage.missing.filter((p) => authorized.has(p)),
      extra: coverage.extra.filter((p) => authorized.has(p)),
    };
  }

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
    // §2.10 (v3.9.5): is the RUNNING version the newest release? Public and
    // secret-free. `unknown` means the check itself failed (GitHub unreachable),
    // not that the board is unhealthy; `checked_at: null` means no check has run
    // yet (monitor disabled or just booted).
    deploy_drift: deployDriftStatus(),
    credential_map: {
      status: coverage.status,
      covered: coverage.covered.length,
      missing_count: coverage.missing.length,
      extra_count: coverage.extra.length,
      // v3.8.0 role binding visibility (§2.10): how many credentials carry a
      // bound role vs. leave roles to the caller-declared X-Agent-Role header.
      credentials_total: coverage.credentials_total,
      credentials_bound: coverage.credentials_bound,
      credentials_unbound: coverage.credentials_unbound,
      ...(nameDisclosure !== null ? nameDisclosure : {}),
    },
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
