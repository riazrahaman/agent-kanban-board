import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStore, onChange, onDiff, onSettings, getSettings, getTasks, getProjectSummaries, startReaper, stopReaper, isReaperEnabled, startBackup, stopBackup } from './store.js';
import { startNotifier, stopNotifier, notifierConfig } from './notifier.js';
import { startDeployDrift, stopDeployDrift } from './deployDrift.js';
import { startWebhooks, stopWebhooks } from './webhooks.js';
import tasksRouter from './routes/tasks.js';
import projectsRouter from './routes/projects.js';
import metricsRouter from './routes/metrics.js';
import auditRouter from './routes/audit.js';
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import settingsRouter from './routes/settings.js';
import milestonesRouter from './routes/milestones.js';
import agentsRouter from './routes/agents.js';
import { onAudit } from './store.js';
import { appendAudit } from './auditLog.js';
import { configureCors } from './middleware/cors.js';
import { createAuthMiddleware, parseProjectTokens } from './middleware/auth.js';
import { reportCredentialCoverage } from './utils/credentialMap.js';
import { createRateLimitMiddleware, rateLimitConfig } from './middleware/rateLimit.js';
import { createBugReportsRouter } from './routes/bugReports.js';
import { createAskRouter } from './routes/ask.js';

// ---------------------------------------------------------------------------
// SEC-05 (v2.6.0) — cap concurrent SSE streams.
// ---------------------------------------------------------------------------
// An unbounded /api/events fan-out is a DoS vector: each long-lived stream
// holds a listener + open socket indefinitely. A module-level counter caps
// concurrent connections; `KANBAN_MAX_SSE_STREAMS` sets the ceiling (default
// 100; a negative value disables the cap entirely so a test or operator can
// turn it off). Over-cap requests get 503 BEFORE any SSE headers are set so a
// client does not mistake a rejection for an open stream.
let activeSseStreams = 0;

function maxSseStreams() {
  const raw = process.env.KANBAN_MAX_SSE_STREAMS;
  if (raw === undefined || raw === '') return 100;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 100;
  return n; // negative => unlimited (checked at call site)
}

export function liveSseStreamCount() {
  return activeSseStreams;
}

export function resetSseStreams() {
  activeSseStreams = 0;
  openSseStreams.clear();
}

/**
 * Every currently-open `/api/events` response.
 *
 * This exists for shutdown (#108). `server.close()` stops accepting new
 * connections but only calls back once every EXISTING one has ended, and an
 * SSE stream never ends on its own — it is a response that is deliberately
 * held open forever. Without a handle on them there is nothing to close, so
 * the callback never fires and the process sits there until something kills
 * it. A plain counter cannot do this; we need the responses themselves.
 */
const openSseStreams = new Set();

/**
 * Ends every open SSE stream. Called on SIGTERM/SIGINT before `server.close()`.
 *
 * Ending the response (rather than destroying the socket) is what lets the
 * browser's `EventSource` treat it as a normal stream end and reconnect on its
 * own schedule — straight onto the new container during a rolling deploy. A
 * destroyed socket surfaces as a network error instead.
 *
 * @returns {number} how many streams were ended.
 */
export function drainSseStreams() {
  const streams = [...openSseStreams];
  openSseStreams.clear();
  for (const res of streams) {
    try {
      res.end();
    } catch {
      // Already torn down by the peer — nothing to do, and a throw here must
      // never be allowed to abort the rest of the shutdown.
    }
  }
  activeSseStreams = Math.max(0, activeSseStreams - streams.length);
  return streams.length;
}

/**
 * Resolve the interface to bind.
 *
 * `net.Server.listen` needs a bare IP/hostname, but orchestration platforms
 * sometimes hand over an IPv6 literal in URLs' bracketed form (Railway injects
 * `HOST=[::]`). Passing `[::]` straight through makes Node treat it as a
 * hostname and fail DNS resolution with `ENOTFOUND`, which — as an unhandled
 * 'error' event — crashes the process and restart-loops the deploy. Strip the
 * brackets so `[::]` / `[::1]` become `::` / `::1`. An unset HOST keeps the
 * hosted-vs-local default (0.0.0.0 when PORT is injected, else loopback).
 */
export function resolveHost(env = process.env) {
  const raw = typeof env.HOST === 'string' ? env.HOST.trim() : '';
  if (!raw) return env.PORT ? '0.0.0.0' : '127.0.0.1';
  if (raw.startsWith('[') && raw.endsWith(']')) return raw.slice(1, -1);
  return raw;
}

/**
 * Resolves Express's `trust proxy` setting from `KANBAN_TRUST_PROXY`.
 *
 * Needed for `GET /api/bug-reports` (and anything else keyed off `req.ip`) to
 * see the REAL client address rather than a platform load balancer's: Railway
 * (and most PaaS front doors) put exactly one reverse proxy in front of the
 * app, so the default is `1` — trust one hop, i.e. use the rightmost
 * untrusted address in `X-Forwarded-For`. A caller cannot widen that by
 * sending a longer forged `X-Forwarded-For` chain; Express only reads as many
 * entries as there are trusted hops. Accepts the numeric hop count (default),
 * `false`/`"0"` to trust no proxy at all (raw socket address), `true` to
 * trust every hop (only correct if you know exactly how many proxies sit in
 * front — otherwise it reopens the spoof this exists to close), or one of
 * Express's named presets (`loopback`, `linklocal`, `uniquelocal`).
 */
export function resolveTrustProxy(raw = process.env.KANBAN_TRUST_PROXY) {
  if (raw === undefined || raw === '') return 1;
  if (raw === 'false' || raw === '0') return false;
  if (raw === 'true') return true;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  return raw; // named preset or proxyaddr-compatible IP/CIDR list
}

export function createApp(opts = {}) {
  const app = express();
  app.use(configureCors());
  app.use(express.json());
  app.set('trust proxy', resolveTrustProxy());
  app.set('query parser', 'extended');
  // The handshake endpoint must be reachable before the auth middleware: it is
  // gated by proof-of-secret, not by a pre-existing session token.
  app.use('/api/auth', authRouter);
  // §bug-reports (v2.16.0): mounted BEFORE auth/rate-limit on purpose — this is
  // the one unauthenticated, human-facing write route on the board (an
  // anonymous visitor has no board token). It is its own in-memory limiter
  // (see routes/bugReports.js), not the per-project mutation limiter below.
  // `opts.bugReports` lets tests inject a fake fetch/clock; production passes
  // nothing and the router reads real env + global fetch.
  app.use('/api/bug-reports', createBugReportsRouter(opts.bugReports));
  // Ask-the-Board (v3.4.0): also public — it carries its OWN password gate
  // (`x-ask-pass`) instead of a board token, so it must mount before auth too.
  // `opts.ask` lets tests inject a fake fetch/clock/env/store; production
  // passes nothing and the router reads real env + global fetch.
  app.use('/api/ask', createAskRouter(opts.ask));
  app.use(createAuthMiddleware());
  app.use(createRateLimitMiddleware());

  app.use('/api/tasks', tasksRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/metrics', metricsRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/health', healthRouter);
  app.use('/healthz', healthRouter);
  // v2.5.0: per-project display settings (column colors).
  app.use('/api/settings', settingsRouter);
  app.use('/api/milestones', milestonesRouter);
  app.use('/api/agents', agentsRouter);

  /**
   * §2.2 — SSE stream modes (PERF-01 rev-snapshot-to-diff):
   *   /api/events                         DIFF (default): per-task `task.<kind>` events
   *   /api/events?mode=snapshot           legacy: full snapshot, `event: tasks`
   *   /api/events?project=X               same shape, filtered to one project
   *   /api/events?project=X&mode=diff     explicit diff (same as default now)
   *   /api/events?prime=1                 diff mode: emit one priming `tasks` snapshot on connect
   *
   * DIFF is the default (no mode param → diff) because the snapshot path
   * re-sends the ENTIRE board on every mutation — 18MB at 3000 tasks. The
   * client primed via GET /api/tasks, so the diff stream needs no priming
   * unless `?prime=1` is passed explicitly.
   *
   * BOTH modes carry `event: settings` on connect and on change (PERF-01c).
   */
  app.get('/api/events', (req, res) => {
    // SEC-05: cap concurrent SSE streams BEFORE setting headers.
    const cap = maxSseStreams();
    if (cap >= 0 && activeSseStreams >= cap) {
      return res.status(503).json({ error: 'Too many concurrent event streams' });
    }
    activeSseStreams += 1;
    openSseStreams.add(res);

    const rawProject = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    let project = rawProject || null;
    // Deep-review (auth P2): a scoped credential must not stream projects it
    // cannot see. The middleware has attached authorizedProjects to req.caller;
    // null means the caller is unscoped (anonymous/admin/global) and the stream
    // stays open as before.
    const allowed = req.caller?.authorizedProjects;
    if (allowed instanceof Set) {
      if (project && !allowed.has(project)) {
        return res.status(403).json({ error: `Forbidden: token is not authorized for project '${project}'` });
      }
      if (!project && allowed.size === 1) {
        project = [...allowed][0];
      }
    }
    const passesScope = (taskProject) => !(allowed instanceof Set) || allowed.has(taskProject);
    // PERF-01: diff is the default. Only an explicit ?mode=snapshot selects the
    // legacy whole-board snapshot path. ?mode=diff is accepted as a no-op alias.
    const isDiffMode = req.query.mode !== 'snapshot';
    const wantPrime = req.query.prime === '1';

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      });
     res.flushHeaders();

    let closed = false;
    let unsubscribe = () => {};

    // Store listeners fire outside the request tick, so a throw here can reach
    // no error middleware. A write to an already-destroyed socket is the real
    // failure mode: treat it as a closed client and detach.
    const send = (event, payload) => {
      if (closed) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch {
        closed = true;
        unsubscribe();
      }
    };

    if (isDiffMode) {
      // PERF-01b: emit a priming `tasks` snapshot ONLY when ?prime=1 is passed.
      // The client relies on its own GET /api/tasks fetch for initial state.
      if (wantPrime) {
        send('tasks', getTasks(project ?? undefined).filter((t) => passesScope(t.project)));
      }
      unsubscribe = onDiff((evt) => {
        if (project && evt.project !== project) return;
        if (!passesScope(evt.project)) return;
        send(`task.${evt.kind}`, evt);
      });
    } else {
      send('tasks', getTasks(project ?? undefined).filter((t) => passesScope(t.project)));
      if (!closed) {
        unsubscribe = onChange((tasks) => {
          send('tasks', tasks.filter((t) => (project ? t.project === project : true) && passesScope(t.project)));
        });
      }
    }

    // v2.5.0 / PERF-01c: push display-settings changes (column colors) live so
    // an operator's save applies immediately in every open browser. A scoped
    // stream receives both its own project's saves and the board-default save
    // (a default save can change any project's resolved colors). BOTH modes
    // (diff and snapshot) carry `event: settings` on connect and on change.
    if (!closed) {
      send('settings', getSettings(project ?? undefined));
      const unsubSettings = onSettings(({ project: savedProject }) => {
        if (project && savedProject !== project && savedProject !== 'default') return;
        send('settings', getSettings(project ?? undefined));
      });
      const prevUnsub = unsubscribe;
      unsubscribe = () => { unsubSettings(); prevUnsub(); };
    }

      req.on('close', () => {
        closed = true;
        unsubscribe();
        // `delete` reports whether it was still registered, so a stream that
        // drainSseStreams() already ended is not counted down twice.
        if (openSseStreams.delete(res)) {
          activeSseStreams = Math.max(0, activeSseStreams - 1);
        }
      });
    });

  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client/dist');
  app.use(express.static(clientDist));
  app.get('{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  // Global error handler: omit internal stack traces (A05).
  //
  // express.json() (mounted above, on EVERY route) throws a body-parser
  // error for malformed JSON, an oversized body, or unsupported encoding BEFORE
  // any route handler runs; left untranslated, these fell through to the generic
  // 500 branch below — a client error reported as a server error, with no way
  // to tell "you sent broken payload/encoding" from "the server is broken".
  // Both error types carry a stable `err.type` from body-parser itself, so
  // this checks that rather than inspecting `err.message`.
  const BODY_PARSER_ERROR_MAP = {
    'entity.parse.failed': { status: 400, error: 'invalid_json' },
    'entity.too.large': { status: 413, error: 'payload_too_large' },
    'encoding.unsupported': { status: 415, error: 'unsupported_encoding' },
    'request.size.invalid': { status: 400, error: 'request_size_invalid' },
    'request.aborted': { status: 400, error: 'request_aborted' },
  };

  app.use((err, req, res, next) => {
    if (err && err.type && BODY_PARSER_ERROR_MAP[err.type]) {
      const mapped = BODY_PARSER_ERROR_MAP[err.type];
      return res.status(mapped.status).json({ error: mapped.error });
    }
    if (err && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: err.code || err.type || 'client_error' });
    }
    console.error(`[kanban error] ${req.method} ${req.originalUrl}:`, err.message);
    res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}

/**
 * Boots the store and the HTTP server, and — unlike `createApp` — schedules the
 * §2.4 lease reaper. The timer is unref()'d (see store.startReaper) so it never
 * keeps a process alive, and it is gated on KANBAN_REAP_ENABLED so operators can
 * disable it (e.g. when an external sweeper owns the lease lifecycle). `createApp`
 * is what the HTTP-contract tests import, so they never spawn a timer.
 */
export async function startServer(
  port = process.env.PORT || 4000,
  host = resolveHost()
) {
  await loadStore();

  // §2.10: compare the projects named in KANBAN_PROJECT_TOKENS against the
  // projects that actually have a store file. A valid-but-truncated map is the
  // dangerous shape — JSON.parse succeeds, the server looks healthy, and every
  // uncovered project 403s silently. This makes that loud at boot. It never
  // throws: a coverage gap is an operator signal, not a reason to refuse to
  // start, and the covered projects must keep serving.
  try {
    const parsed = parseProjectTokens();
    reportCredentialCoverage(
      getProjectSummaries().map((s) => s.project),
      parsed
    );
  } catch (err) {
    console.warn(`[kanban auth] credential-map check skipped: ${err.message}`);
  }

  const rl = rateLimitConfig();
  console.info(
    rl.enabled
      ? `rate limit: ${rl.limit}/min/project (window ${rl.windowMs}ms)`
      : 'rate limit: disabled'
  );

  // In a hosted environment (PORT set) with no auth mechanism configured, warn
  // once at startup that mutations are fail-closed until a token is set.
  if (process.env.PORT && !process.env.KANBAN_AUTH_TOKEN && !process.env.KANBAN_AUTH_SECRET) {
    console.warn(
      '[kanban auth] no KANBAN_AUTH_TOKEN/KANBAN_AUTH_SECRET configured; ' +
      'mutations are fail-closed (503) until a token is set'
    );
  }

  const app = createApp();
  if (process.env.PORT && !(process.env.KANBAN_ALLOWED_ORIGIN || '').trim()) {
    console.warn(
      '[kanban warning] KANBAN_ALLOWED_ORIGIN is unset: CORS is falling back to the localhost dev origin (http://localhost:5173). Set it explicitly in production (e.g. to RENDER_EXTERNAL_HOSTNAME).'
    );
  }
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, (err) => {
      if (err) return reject(err);
      // §2.4: schedule the lease reaper only on a real boot (not in createApp),
       // so the HTTP-contract tests never spawn a timer.
      let stop = null;
      if (isReaperEnabled()) {
        stop = startReaper();
        // Clean shutdown: stop the sweep when the server closes.
        server.on('close', () => stopReaper());
        }
      // §2.9 (v2.9.0): persist audit entries to JSONL when enabled.
      const unsubAudit = onAudit(appendAudit);
      server.on('close', () => unsubAudit());
      startBackup();
      server.on('close', () => stopBackup());
      // §2.10 (v3.9.5): deploy-drift monitor. Compares the running version with
      // the newest GitHub release so a SKIPPED deploy (red CI -> Railway skips
      // rather than fails) becomes visible in /api/health and, on a transition,
      // in Telegram. Started only here, never in createApp: the HTTP-contract
      // tests must never make a network call. Unref'd and off with
      // KANBAN_DEPLOY_DRIFT_INTERVAL_MS <= 0.
      startDeployDrift();
      server.on('close', () => stopDeployDrift());
      // §2.11: outbound Telegram alerts for reclaims. Off unless a bot token +
      // chat id are configured, so tests and unconfigured deployments stay inert.
      const notifier = startNotifier();
      server.on('close', () => stopNotifier());
      if (!notifier) {
        const ncfg = notifierConfig();
        if (process.env.KANBAN_TELEGRAM_BOT_TOKEN || process.env.KANBAN_TELEGRAM_CHAT_ID) {
          console.warn(
            '[kanban warning] Telegram notifications are partially configured: set BOTH KANBAN_TELEGRAM_BOT_TOKEN and KANBAN_TELEGRAM_CHAT_ID to enable them.'
          );
        }
      }
      // v2.11.0 (opt-integration-hooks): outbound JSON webhooks. Off unless one
      // or more KANBAN_WEBHOOK_URLS are configured.
      startWebhooks();
      server.on('close', () => stopWebhooks());
      resolve({ server, stopReaper: stop || stopReaper });
      });
    // IMPL-01 (v2.7.0): handle a bind failure (EADDRINUSE, EADDRNOTAVAIL, …)
    // so an unhandled 'error' event does not crash the process/restart-loop.
    server.on('error', (err) => {
      console.error('[kanban server] listen error:', err);
      reject(err);
    });
    });
}

/**
 * Attaches graceful shutdown listeners for SIGTERM and SIGINT.
 *
 * When Railway, Docker, or Kubernetes rolls out a new deployment or stops
 * a container, it issues SIGTERM. By cleanly stopping background workers
 * and calling server.close(), we ensure in-flight requests finish,
 * persistence flush hooks run, and the process exits with code 0 instead of 143.
 *
 * ORDER MATTERS HERE (#108). `server.close()` stops new connections but waits
 * for every open one to end, and this server deliberately holds connections
 * open forever: each browser tab parks on `GET /api/events`. Measured locally:
 * with no SSE client the process exits in ~0.1s; with ONE open stream it never
 * reached the close callback and left only via the `timeoutMs` path below,
 * five seconds later. In production every tab holds a stream, so that was the
 * normal case, and the deploy logs show SIGTERM followed by the container
 * stopping ~2.8s later with no exit line in between.
 *
 * (The crash emails #108 was filed for had a different, earlier cause — an
 * `npm` wrapper in the Railway start command, fixed in the dashboard on
 * 2026-10-11, after which they stopped. This is a second defect found while
 * verifying that one: a shutdown that was never actually graceful.)
 *
 * Hence: drain the SSE streams first (a clean `res.end()`, so EventSource
 * reconnects to the new container by itself), then close the server, then
 * `closeIdleConnections()` for keep-alive sockets sitting between requests.
 * A request still being served is deliberately NOT destroyed here — that is
 * what "graceful" means, and killing a PATCH mid-response would hand the
 * client a reset whose retry then fails on a version mismatch. If one is still
 * running a second later, `closeAllConnections()` takes it; the `timeoutMs`
 * exit stays as the last backstop, not as the normal path.
 *
 * @param {import('node:http').Server} server
 * @param {object} [opts]
 * @param {function} [opts.exit]
 * @param {function} [opts.log]
 * @param {number} [opts.timeoutMs]
 * @param {function} [opts.drain] Ends long-lived streams. Defaults to
 *   `drainSseStreams`; injectable so the unit tests can observe the ordering.
 * @returns {function} cleanup callback to remove signal listeners
 */
export function registerShutdownHandlers(
  server,
  { exit = process.exit, log = console.log, timeoutMs = 5000, drain = drainSseStreams } = {}
) {
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`[kanban server] received ${signal}, shutting down gracefully...`);

    // Before close(), or close() waits on streams that never end by design.
    let drained = 0;
    try {
      drained = drain() ?? 0;
    } catch (err) {
      console.error('[kanban server] error draining event streams:', err);
    }
    if (drained > 0) {
      log(`[kanban server] ended ${drained} open event stream(s)`);
    }

    const closeStarted = Date.now();
    server.close((err) => {
      if (err) {
        console.error('[kanban server] error during close:', err);
        exit(1);
        return;
      }
      // Logged so a retirement can be told apart from a container that was
      // killed before it ever got here — the two are indistinguishable in the
      // deploy log otherwise, which is what made #108 hard to confirm.
      log(`[kanban server] closed cleanly in ${Date.now() - closeStarted}ms`);
      exit(0);
    });
    // Node 18.2+. Idle keep-alive sockets are dropped at once: nothing is being
    // served on them, and they would otherwise hold close() open for their full
    // keep-alive window. In-flight requests are left alone.
    if (typeof server.closeIdleConnections === 'function') {
      try {
        server.closeIdleConnections();
      } catch (err) {
        console.error('[kanban server] error closing idle connections:', err);
      }
    }

    // Backstop for a request that is still running a second later (or a client
    // that ignored the stream end). Unref'd, so it never by itself keeps the
    // process alive once everything has drained.
    if (typeof server.closeAllConnections === 'function') {
      const hard = setTimeout(() => {
        try {
          server.closeAllConnections();
        } catch (err) {
          console.error('[kanban server] error closing connections:', err);
        }
      }, 1000);
      if (typeof hard.unref === 'function') hard.unref();
    }

    const timer = setTimeout(() => {
      console.warn('[kanban server] graceful shutdown timed out; exiting forcefully');
      exit(0);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  const onSigTerm = () => shutdown('SIGTERM');
  const onSigInt = () => shutdown('SIGINT');

  process.on('SIGTERM', onSigTerm);
  process.on('SIGINT', onSigInt);

  return () => {
    process.off('SIGTERM', onSigTerm);
    process.off('SIGINT', onSigInt);
  };
}

// Auto-run when executed directly
const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const PORT = process.env.PORT || 4000;
  const HOST = resolveHost();
  startServer(PORT, HOST).then(({ server }) => {
    console.log(`Agent Kanban server listening on http://${HOST}:${PORT}`);
    registerShutdownHandlers(server);
  });
}
