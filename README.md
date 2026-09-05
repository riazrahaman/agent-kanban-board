# Agent Kanban Board

A local-first, real-time Kanban state dashboard designed for swarms of autonomous AI agents. Headless agents claim tasks, move them through a deterministic state machine (`BACKLOG → BUILDING → IN_REVIEW → IN_TEST → DONE`), and append structured operational logs via a lightweight HTTP API. Human operators monitor swarm progress live over Server-Sent Events (SSE) with zero page refreshes.

Drag-and-drop interactions are deliberately omitted: agents drive the board state, eliminating stray human clicks that could corrupt loop execution.

Everything runs locally on `localhost` with zero cloud dependencies, accounts, or telemetry.

---

## Project Layout

```
.
├── client/           Vite + React + Tailwind frontend styled to DESIGN.md
├── server/           Node/Express API with atomic JSON & git-backed YAML storage
├── scripts/          test-agents.js — headless multi-agent workflow demo
├── .github/          CI workflow for automated testing and builds
├── Makefile          Standard build, test, and security check targets
└── LICENSE           MIT License
```

---

## Quickstart

### 1. Start the API Server

```bash
# From repository root
npm start
# or: cd server && npm install && npm start
```

The REST API and Server-Sent Events stream run on `http://localhost:4000`. By default, the server runs with zero configuration using the standalone atomic JSON store (`server/tasks.json`).

### 2. Start the Frontend Client

In a separate terminal:

```bash
cd client
npm install
npm run dev
```

Open `http://localhost:5173` in your browser to view the board.

---

## State Machine & Role Ownership

The board enforces a strict lifecycle state machine and role-based permissions:

```
BACKLOG ──► BUILDING ──► IN_REVIEW ──► IN_TEST ──► DONE
               ▲              │           │
               └── (rejection)┘           │
               ▲                          │
               └───────── (failure) ──────┘
```

- **`BLOCKED`** can be set from any active state (`BUILDING`, `IN_REVIEW`, `IN_TEST`). Resuming moves back to `BUILDING`.
- **Illegal transitions** (e.g., jumping directly from `BACKLOG` to `DONE`) return `409 Conflict`.
- **Role Ownership Rules**:
  - **Builder**: May advance `BACKLOG → BUILDING` or `BUILDING → IN_REVIEW`. Cannot mark `DONE`.
  - **Reviewer**: May approve `IN_REVIEW → IN_TEST` or return `IN_REVIEW → BUILDING`. Cannot mark `DONE`.
  - **Tester**: May advance `IN_TEST → DONE` or return `IN_TEST → BUILDING`.
  - Callers provide their role via request body (`{"role": "builder"}`) or header (`X-Agent-Role: builder`). Unauthorized role transitions return `403 Forbidden`.
- **Claim Contention**: Once an agent claims a task (`POST /api/tasks/:id/claim`), a second agent cannot claim or hijack it (`409 Conflict`) until released.

---

## Storage Backends

The board features pluggable persistence:

1. **Standalone JSON Storage (Default)**:
   - Persists all tasks in `server/tasks.json`.
   - Writes are atomic: writes land in a temporary file and atomically rename into place (`rename`), preventing corruption from crashes mid-write.
2. **Git-Backed YAML Storage**:
   - Enabled via environment variables:
     ```bash
     KANBAN_STORAGE=git
     KANBAN_STORAGE_DIR=/path/to/cards
     ```
   - Persists each task as an individual YAML card (`<ID>.yml`).
   - Automatically commits git transitions on disk (`ops(<ID>): kanban <STATUS>`), eliminating state drift between the board and version control.

---

## Security & Authentication

- **Authentication (A07)**:
  - Configure `KANBAN_AUTH_TOKEN=<secret>` in your environment.
  - When set, mutating endpoints (`POST`, `PATCH`, `PUT`, `DELETE`) require `Authorization: Bearer <token>` or `X-API-Token: <token>`.
  - Read-only endpoints (`GET /api/tasks`, `GET /api/events`) remain open for non-blocking monitoring.
- **CORS Lockdown (A05)**:
  - CORS is restricted to loopback origins (`http://localhost:5173`, `http://127.0.0.1:5173`, etc.) by default. Wildcard `*` is prohibited.
  - Custom origins can be specified via `KANBAN_ALLOWED_ORIGIN`. Untrusted origins receive no `Access-Control-Allow-Origin` header.
- **Input Sanitization (A03)**:
  - All untrusted input from agents (task titles, descriptions, and log messages) is escaped to prevent Stored XSS.

---

## Design System

The visual interface is styled to the editorial-minimalist design system in `DESIGN.md`:
- **Hairlines**: Depth is achieved solely through 1px hairlines (`border-line`); shadows and heavy gradients are banned.
- **Typography**: System sans-serif for body UI, display serif (`Instrument Serif`) for titles, and monospace (`JetBrains Mono` / system mono) with `tabular-nums` for all metrics, IDs, counts, and timestamps.
- **Form + Colour**: Status is encoded in form as well as colour: left 3px severity stripe, text badge, status glyphs (`▲` for review), and active pulsing indicators.
- **No Inter/Roboto**: Typography conforms strictly to system and curated fonts.

---

## Multi-Agent Headless Demo

With the server running, run:

```bash
node scripts/test-agents.js
```

This simulates two autonomous agents collaborating headlessly:
1. **Agent-Alpha** claims a task, moves it to `BLOCKED`, and logs the blocker reason.
2. **Agent-Beta** claims another task, transitions it through `BUILDING → IN_REVIEW → IN_TEST → DONE` using the proper role identities, and logs completion notes.

All mutations broadcast instantaneously to the open browser dashboard over SSE.

---

## API Reference

| Method | Endpoint | Description | Auth / Role Gated |
|---|---|---|---|
| `GET` | `/api/tasks` | List all tasks | Public |
| `POST` | `/api/tasks` | Create task (`id` and `title` required) | Auth required |
| `GET` | `/api/tasks/:id` | Get single task details | Public |
| `PATCH` | `/api/tasks/:id` | Update task status or fields | Auth + Role gated |
| `POST` | `/api/tasks/:id/claim` | Claim task for agent (`agent_id` body) | Auth + Contention gated |
| `POST` | `/api/tasks/:id/logs` | Append operational log entry | Auth required |
| `GET` | `/api/events` | Server-Sent Events stream of task snapshots | Public |

---

## Development & Verification

```bash
# Run test suite (Node.js test runner)
make test
# or: npm test

# Build client production bundle
make build
# or: npm run build

# Run security checks (no hardcoded secrets or absolute paths)
make sec
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.
