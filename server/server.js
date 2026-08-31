import express from 'express';
import cors from 'cors';
import { loadStore, onChange, getTasks } from './store.js';
import tasksRouter from './routes/tasks.js';

const PORT = process.env.PORT || 4000;

async function main() {
  await loadStore();

  const app = express();
  app.use(cors());
  app.use(express.json());

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

  app.listen(PORT, () => {
    console.log(`Agent Kanban server listening on http://localhost:${PORT}`);
  });
}

main();
