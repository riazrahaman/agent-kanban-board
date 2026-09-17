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

The REST API and Server-Sent Events stream run on `http://localhost:4000`. The default JSON store is local to this clone, so the server starts with no configuration. Read-only monitoring works immediately; configure `KANBAN_AUTH_TOKEN` before sending mutations. The optional git-backed YAML store is selected explicitly with `KANBAN_STORAGE_BACKEND=git` and `KANBAN_GIT_DIR=/path/to/cards`.

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
  - Callers provide their role via request body (`{"role": "builder"}`) or header (`X-Agent-Role: builder`); a missing role cannot pass a status transition. Unauthorized role transitions return `403 Forbidden`.
- **Claim Contention**: Once an agent claims a task (`POST /api/tasks/:id/claim`), a second agent cannot claim or hijack it (`409 Conflict`) until released.

---

## Storage Backends

The board features pluggable persistence:

1. **Standalone JSON Storage**:
   - Persists all tasks in `server/tasks.json`.
   - Writes are atomic: writes land in a temporary file and atomically rename into place (`rename`), preventing corruption from crashes mid-write.
2. **Git-Backed YAML Storage**:
   - Enabled explicitly via environment variables:
     ```bash
     KANBAN_STORAGE_BACKEND=json
     KANBAN_DATA_FILE=server/tasks.json
     ```
   - Persists each task as an individual YAML card (`<ID>.yml`).
   - Automatically commits git transitions on disk (`ops(<ID>): kanban <STATUS>`), eliminating state drift between the board and version control.

   3. **Multi-Project Partitioning (§2.1)**:
   - Every task carries a `project` field (default `default`). Tasks are keyed internally by the composite `project/id`; two projects may share a short `id`.
   - The default project **reuses the legacy location** (`KANBAN_DATA_FILE` / `server/tasks.json`, or the flat git root), so single-project deployments are byte-for-byte unchanged with no migration.
   - A *named* project is stored separately: JSON at `KANBAN_DATA_DIR/tasks/<project>.json`, Git at `KANBAN_GIT_DIR/<project>/<id>.yml` and committed as `ops(<project>/<id>): kanban <STATUS>`.
   - Scope any request with `?project=` (or the `workspace_id` body alias on create, or the `X-Kanban-Project` header); composite ids of the form `atlas:task-1` are accepted on detail lookups.
   - `GET /api/projects` returns a per-project summary: `{ project, task_count, done_count, live_count, archived_count, updated }`.

   4. **Archiving & Storage Hygiene (§2.8)**:
   - `DONE` tasks whose `completed_at` (falling back to `created_at`/`updated`) is older than `KANBAN_ARCHIVE_AFTER_DAYS` (default `30`; set to `0` to disable) are moved to an archive sink (JSON `tasks/archive/<project>.json`, Git `archive/<project>/<id>.yml`) and tagged with `archived_at`.
   - The sweep runs at boot and lazily before list/archive reads; `GET /api/tasks/archive?project=` returns archived tasks. Archived tasks leave the live set but stay queryable.

   | Env var | Default | Purpose |
   |---|---|---|
   | `KANBAN_STORAGE_BACKEND` | `json` | `json` or `git`. |
   | `KANBAN_DATA_FILE` | `server/tasks.json` | Default-project JSON file. |
   | `KANBAN_DATA_DIR` | — | Root for `tasks/<project>.json` and `tasks/archive/<project>.json`. |
   | `KANBAN_GIT_DIR` | — | Git root; `<project>/<id>.yml`, flat root used for default. |
   | `KANBAN_GIT_COMMIT` | `true` | `false` disables auto-commit. |
   | `KANBAN_DEFAULT_PROJECT` | `default` | Name of the implicit single-project. |
   | `KANBAN_ARCHIVE_AFTER_DAYS` | `30` | Age after which `DONE` tasks archive (`0` disables). |

   ---

## Security & Authentication

- **Authentication (A07)**:
  - Configure `KANBAN_AUTH_TOKEN=<secret>` in your environment; there is no default or fallback token.
  - Mutating endpoints (`POST`, `PATCH`, `PUT`, `DELETE`) require `Authorization: Bearer <token>` or `X-API-Token: <token>`. If the token is not configured, mutations fail closed with `503`.
  - Read-only endpoints (`GET /api/tasks`, `GET /api/events`) remain open for non-blocking monitoring.
- **CORS Lockdown (A05)**:
  - CORS is restricted to `http://localhost:5173` by default. Set one explicit `KANBAN_ALLOWED_ORIGIN` to use another client origin; wildcard `*` is prohibited.
  - Untrusted origins receive no `Access-Control-Allow-Origin` header.
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
| `GET` | `/api/tasks` | List all tasks (`?project=` scopes to one project; unfiltered spans all) | Public |
| `POST` | `/api/tasks` | Create task (`id` and `title` required; `project`/`workspace_id`/`?project=` scopes the card) | Auth required |
| `GET` | `/api/tasks/:id` | Get single task details (composite `atlas:task-1` or `?project=` accepted) | Public |
| `PATCH` | `/api/tasks/:id` | Update task status or fields (`project` is immutable) | Auth + Role gated |
| `POST` | `/api/tasks/:id/claim` | Claim task for agent (`agent_id` body) | Auth + Contention gated |
| `POST` | `/api/tasks/:id/logs` | Append operational log entry | Auth required |
| `GET` | `/api/projects` | Per-project summary (`task_count`, `done_count`, `live_count`, `archived_count`, `updated`) | Public |
| `GET` | `/api/tasks/archive` | List archived tasks (`?project=` scopes to one project) | Public |
| `POST` | `/api/tasks/archive/sweep` | Run the archive sweep now (returns `{ moved, projects }`) | Auth required |
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
