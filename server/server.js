import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStore, onChange, getTasks } from './store.js';
import tasksRouter from './routes/tasks.js';
import { createAuthMiddleware } from './middleware/auth.js';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(createAuthMiddleware());

  app.use('/api/tasks', tasksRouter);

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

  return app;
}

export async function startServer(port = process.env.PORT || 4000) {
  await loadStore();
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
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
  startServer(PORT).then(() => {
    console.log(`Agent Kanban server listening on http://localhost:${PORT}`);
  });
}
