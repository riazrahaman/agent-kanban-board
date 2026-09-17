import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStore, onChange, onDiff, getTasks, startReaper, stopReaper, isReaperEnabled } from './store.js';
import tasksRouter from './routes/tasks.js';
import projectsRouter from './routes/projects.js';
import { configureCors } from './middleware/cors.js';
import { createAuthMiddleware } from './middleware/auth.js';

export function createApp() {
  const app = express();
  app.use(configureCors());
  app.use(express.json());
  app.use(createAuthMiddleware());

  app.use('/api/tasks', tasksRouter);
  app.use('/api/projects', projectsRouter);

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

      req.on('close', () => {
       closed = true;
       unsubscribe();
        });
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
  host = process.env.HOST || '127.0.0.1'
) {
  await loadStore();
  const app = createApp();
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
  const HOST = process.env.HOST || '127.0.0.1';
  startServer(PORT, HOST).then(({ server }) => {
     console.log(`Agent Kanban server listening on http://${HOST}:${PORT}`);
      });
}
