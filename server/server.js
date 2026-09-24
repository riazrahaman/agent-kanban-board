import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStore, onChange, onDiff, onSettings, getSettings, getTasks, startReaper, stopReaper, isReaperEnabled, startBackup, stopBackup } from './store.js';
import { startNotifier, stopNotifier, notifierConfig } from './notifier.js';
import tasksRouter from './routes/tasks.js';
import projectsRouter from './routes/projects.js';
import metricsRouter from './routes/metrics.js';
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import settingsRouter from './routes/settings.js';
import { configureCors } from './middleware/cors.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createRateLimitMiddleware, rateLimitConfig } from './middleware/rateLimit.js';

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

export function createApp() {
  const app = express();
  app.use(configureCors());
  app.use(express.json());
  // The handshake endpoint must be reachable before the auth middleware: it is
  // gated by proof-of-secret, not by a pre-existing session token.
  app.use('/api/auth', authRouter);
  app.use(createAuthMiddleware());
  app.use(createRateLimitMiddleware());

  app.use('/api/tasks', tasksRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/metrics', metricsRouter);
  app.use('/api/health', healthRouter);
  app.use('/healthz', healthRouter);
  // v2.5.0: per-project display settings (column colors).
  app.use('/api/settings', settingsRouter);

  /**
   * §2.2 — SSE stream in three modes:
   *   /api/events                        legacy: full snapshot, `event: tasks`
   *   /api/events?project=X              same shape, filtered to one project
   *   /api/events?project=X&mode=diff    per-task events, `event: task.<kind>`
   * The legacy path is kept byte-compatible so the existing client is unaffected.
   */
  app.get('/api/events', (req, res) => {
    const rawProject = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    const project = rawProject || null;
    const isDiffMode = req.query.mode === 'diff';

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
      unsubscribe = onDiff((evt) => {
        if (project && evt.project !== project) return;
        send(`task.${evt.kind}`, evt);
        });
      } else {
      send('tasks', getTasks(project ?? undefined));
      if (!closed) {
        unsubscribe = onChange((tasks) => {
          send('tasks', project ? tasks.filter((t) => t.project === project) : tasks);
          });
        }
      }

    // v2.5.0: push display-settings changes (column colors) live so an
    // operator's save applies immediately in every open browser. A scoped
    // stream receives both its own project's saves and the board-default save
    // (a default save can change any project's resolved colors). Snapshot
    // mode only — the diff contract is strictly per-task events.
    if (!closed && !isDiffMode) {
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
      });
    });

  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  // Global error handler: omit internal stack traces (A05)
  app.use((err, req, res, next) => {
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
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
       // §2.4: schedule the lease reaper only on a real boot (not in createApp),
       // so the HTTP-contract tests never spawn a timer.
      let stop = null;
      if (isReaperEnabled()) {
        stop = startReaper();
        // Clean shutdown: stop the sweep when the server closes.
        server.on('close', () => stopReaper());
        }
      startBackup();
      server.on('close', () => stopBackup());
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
      resolve({ server, stopReaper: stop || stopReaper });
      });
    });
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
      });
}
