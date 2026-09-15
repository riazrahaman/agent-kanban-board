import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStore, onChange, getTasks } from './store.js';
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

  app.get('/api/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    res.write(`event: tasks\ndata: ${JSON.stringify(getTasks())}\n\n`);

    const unsubscribe = onChange((tasks) => {
      res.write(`event: tasks\ndata: ${JSON.stringify(tasks)}\n\n`);
    });

    req.on('close', () => {
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

export async function startServer(
  port = process.env.PORT || 4000,
  host = process.env.HOST || '127.0.0.1'
) {
  await loadStore();
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      resolve(server);
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
  startServer(PORT, HOST).then(() => {
    console.log(`Agent Kanban server listening on http://${HOST}:${PORT}`);
  });
}
