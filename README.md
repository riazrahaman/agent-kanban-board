# Agent Kanban Board

A local-only Kanban "state dashboard" for a swarm of AI agents. Instead of
humans dragging cards around, headless agents claim tasks, move them through
`backlog → todo → in_progress → blocked/done`, and leave a running log of
what they did — all via a small HTTP API. The board is a real-time window
into what the swarm is doing, updated live over Server-Sent Events with no
page refresh. See [`../Agent_Orchestrator_Prompt.md`](../Agent_Orchestrator_Prompt.md)
for the full spec this project implements.

Everything runs entirely on `localhost` — no cloud services, no external
accounts, no network calls beyond your own machine. Task state is persisted
to a plain JSON file at `server/tasks.json`.

## Project layout

```
.
├── server/    Node/Express API — serves and mutates tasks.json, on :4000
├── client/    Vite/React frontend — the visual Kanban board
└── scripts/   test-agents.js — headless demo of the multi-agent workflow
```

## How to run it

1. Start the API server:

   ```bash
   cd server
   npm install
   npm start
   ```

   This serves the REST API (and SSE stream) on `http://localhost:4000`.

2. In a separate terminal, start the frontend:

   ```bash
   cd client
   npm install
   npm run dev
   ```

   Vite will print its own local URL (typically `http://localhost:5173`) —
   open that in your browser to see the board.

## How to run the multi-agent demo

With the server running (step 1 above), from the project root run:

```bash
node scripts/test-agents.js
```

This simulates two agents working the board headlessly:

- **Agent-Alpha** claims `task-1`, moves it to `blocked`, and logs why.
- **Agent-Beta** claims `task-3`, moves it to `done`, and logs a completion
  note.

The script prints the "before" and "after" state of both tasks (including
their `agent_logs`) so you can see the effect directly in the terminal — no
browser required. If you have the client open in a browser while the script
runs, you'll see the cards move and the logs appear live via Server-Sent
Events, with no page refresh needed.

## Raw curl equivalents

The demo script uses `task-1` and `task-3`. To poke at the API by hand
without touching those, use `task-2` as a scratch task:

Claim a task for an agent:

```bash
curl -X POST http://localhost:4000/api/tasks/task-2/claim \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"Agent-Casey"}'
```

Move a task to a new status (or update any other field):

```bash
curl -X PATCH http://localhost:4000/api/tasks/task-2 \
  -H 'Content-Type: application/json' \
  -d '{"status":"todo"}'
```

Append a log entry to a task:

```bash
curl -X POST http://localhost:4000/api/tasks/task-2/logs \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"Agent-Casey","message":"Investigating root cause."}'
```

Fetch the full task list or a single task (no write, just for reference):

```bash
curl http://localhost:4000/api/tasks
curl http://localhost:4000/api/tasks/task-2
```
