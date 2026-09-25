# Agent Kanban Board

A local-first, real-time Kanban state dashboard designed for swarms of autonomous AI agents. Headless agents claim tasks, move them through a deterministic state machine (`BACKLOG → BUILDING → IN_REVIEW → IN_TEST → DONE`), and append structured operational logs via a lightweight HTTP API. Human operators monitor swarm progress live over Server-Sent Events (SSE) with zero page refreshes.

Agents drive the board state over HTTP, while operators enjoy rich supervisory tools: real-time substring search, multi-criteria quick filters, persisted column sorting, effort sizing badges, a live metrics summary dashboard, JSON export, and inline title editing.

Everything runs locally on `localhost` with zero cloud dependencies, accounts, or telemetry.

> **Connecting a new client or project?** See [ONBOARDING.md](ONBOARDING.md) for the
> project-implicit model, token distribution, and a curl walkthrough.

---

## Project Layout

```
.
├── client/           Vite + React + Tailwind frontend (editorial-minimalist design system)
│   └── public/landing/  Screenshots served to the in-app About view
├── server/           Node/Express API with atomic JSON & git-backed YAML storage
├── docs/             System design, architecture, file reference, and operator manual
├── scripts/          test-agents.js — headless multi-agent workflow demo
├── .github/          CI workflow for automated testing and builds
├── render.yaml       Render.com deploy blueprint (Node service + persistent disk)
├── railway.json      Railway deploy config (Railpack + healthcheck)
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

Open `http://localhost:5173` in your browser to view the board. The header switches between three top-level views — **Board**, **Portfolio** (cross-project rollup), and **About** (the in-app product overview with the headless-first pitch, an architecture & code-flow walkthrough — the stack, the next-claim path through the code, the three safety layers around every write — plus the reclaim-alert path and live screenshots).

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
   | `KANBAN_DATA_DIR` | `server/data` | Root for `tasks/<project>.json` and `tasks/archive/<project>.json`. When unset, defaults to an in-repo `server/data` (with a one-time warning) — never a sibling checkout. |
   | `KANBAN_GIT_DIR` | `server/data` | Git root; `<project>/<id>.yml`, flat root used for default. Same in-repo default as `KANBAN_DATA_DIR`. |
   | `KANBAN_GIT_COMMIT` | `true` | `false` disables auto-commit. |
   | `KANBAN_DEFAULT_PROJECT` | `default` | Name of the implicit single-project. |
   | `KANBAN_ARCHIVE_AFTER_DAYS` | `30` | Age after which `DONE` tasks archive (`0` disables). |
   | `KANBAN_TRASH_DAYS` | `30` | Age after which soft-deleted tasks are permanently removed from the trash sink (`0` disables the sweep; trash rows persist until then). |
   | `KANBAN_TELEGRAM_BOT_TOKEN` / `KANBAN_TELEGRAM_CHAT_ID` | *(unset)* | Both required to enable Telegram alerts when a lease reaper returns a task to `BACKLOG`. Off when either is unset. |
   | `KANBAN_NOTIFY_EVENTS` | `lease_expired,orphan_normalized` | Which reclaim reasons alert. |
   | `KANBAN_NOTIFY_PROJECTS` | *(all)* | Optional project allow-list for alerts. |
   | `KANBAN_NOTIFY_INCLUDE_DESC` | `true` | Include a truncated task description in the alert. |
   | `KANBAN_NOTIFY_MIN_INTERVAL_MS` | `1000` | Minimum gap between Telegram alerts. |
   | `KANBAN_CLAIM_TTL_MS` | `600000` | Lease TTL (10 min); expired leases are auto-reclaimed. |
   | `KANBAN_ORPHAN_GRACE_MS` | `300000` | How long an ownerless ACTIVE task may sit untouched before the reaper normalizes it to BACKLOG. Decoupled from the claim TTL (raising the TTL does not stretch this window). Anchored on `updated`, so any later write resets it. `0` reaps orphans immediately. |
   | `KANBAN_BOARD_URL` | `https://agent-kanban.riazrahaman.com` | Base URL used in the alert's deep link (`?project=`). |
   | `KANBAN_READ_AUTH` | `off` | Set to `token` to require a credential on every read (GET/SSE). `EventSource` cannot set headers, so browsers exchange their token for a 60 s single-use ticket via `POST /api/auth/stream-ticket` and append `?ticket=`. Unset/`off`/`0` keeps reads open. Health probes stay open. |
   | `KANBAN_MAX_SSE_STREAMS` | `100` | Cap on concurrent `/api/events` streams. Over-cap requests get a 503 (before any SSE headers). A negative value disables the cap. |
   | `KANBAN_AUTH_RATE_LIMIT_PER_MIN` | *(falls back to `KANBAN_RATE_LIMIT_PER_MIN`)* | Per-IP ceiling on FAILED auth attempts (401/403) on mutations and the session/ticket handshakes; exceeding it returns 429 with `retry_after_ms`. Inert when both this and `KANBAN_RATE_LIMIT_PER_MIN` are unset. |

   ---

## Security & Authentication

- **Authentication (A07)**:
  - Configure `KANBAN_AUTH_TOKEN=<secret>` in your environment; there is no default or fallback token.
  - Mutating endpoints (`POST`, `PATCH`, `PUT`, `DELETE`) require `Authorization: Bearer <token>` or `X-API-Token: <token>`. If the token is not configured, mutations fail closed with `503`.
  - Per-project isolation via `KANBAN_PROJECT_TOKENS` (JSON map `{"project":"token"}`); an admin token (`KANBAN_ADMIN_TOKEN`) spans every project and is audited as `admin_write`.
  - HMAC session tokens are available when `KANBAN_AUTH_SECRET` is set — clients negotiate a stateless 24h token via `POST /api/auth/session` instead of holding a static secret. See [ONBOARDING.md](ONBOARDING.md).
  - Identity is sent as `X-Agent-Id` + `X-Agent-Role` (or `body.role`), lowercased, validated against `VALID_ROLES`.
  - Read-only endpoints (`GET /api/tasks`, `GET /api/events`) remain open for non-blocking monitoring.
- **CORS Lockdown (A05)**:
  - CORS is restricted to `http://localhost:5173` by default. Set `KANBAN_ALLOWED_ORIGIN` (a comma-separated list) to allow other client origins; wildcard `*` is prohibited.
  - Untrusted origins receive no `Access-Control-Allow-Origin` header.
- **Input Sanitization (A03)**:
  - All untrusted input from agents (task titles, descriptions, and log messages) is escaped to prevent Stored XSS.

---

## Design System

The visual interface follows an editorial-minimalist design system:
- **Hairlines**: Depth is achieved solely through 1px hairlines (`border-line`); shadows and heavy gradients are banned.
- **Typography**: System sans-serif for body UI, display serif (`Instrument Serif`) for titles, and monospace (`JetBrains Mono` / system mono) with `tabular-nums` for all metrics, IDs, counts, and timestamps.
- **Form + Colour**: Status is encoded in form as well as colour: left 3px severity stripe, text badge, status glyphs (`▲` for review), and active pulsing indicators.
- **No Inter/Roboto**: Typography conforms strictly to system and curated fonts.
- **Theming**: A warm-cream light palette and a green-charcoal dark palette (matching riazrahaman.com), toggled in the header; the explicit choice wins over the OS preference and native controls follow via `color-scheme`.
- **Responsive**: The shell wraps instead of overflowing, board columns snap-scroll at `85vw` on mobile (`w-72` from `md` up), and the Signal Rail collapses into a slide-over drawer below `md`.

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
| `POST` | `/api/tasks/purge` | Bulk-delete selected or filtered tasks (soft into trash by default; `{"hard": true}` = permanent) | Auth + privileged role required |
| `GET` | `/api/tasks/trash` | List soft-deleted tasks in the trash sink (project-scoped) | Read |
| `POST` | `/api/tasks/trash/:id/restore` | Restore a soft-deleted task to BACKLOG | Auth (admin) |
| `DELETE` | `/api/tasks/trash/:id` | Permanently remove a task from the trash sink | Auth + privileged role required |
| `GET` | `/api/tasks/:id` | Get single task details (composite `atlas:task-1` or `?project=` accepted) | Public |
| `DELETE` | `/api/tasks/:id` | Delete one task | Auth + privileged role required |
| `PATCH` | `/api/tasks/:id` | Update task status or fields (`project` is immutable) | Auth + Role gated |
| `POST` | `/api/tasks/:id/claim` | Claim task for agent (`agent_id` body) | Auth + Contention gated |
| `POST` | `/api/tasks/:id/heartbeat` | Renew the claimant's task lease | Auth required |
| `POST` | `/api/tasks/:id/logs` | Append operational log entry | Auth required |
| `GET` | `/api/tasks/:id/issues` | List task issue IDs | Public |
| `POST` | `/api/tasks/:id/issues` | Append a task issue ID | Auth required |
| `POST` | `/api/tasks/next-claim` | Claim next available task (`?project=` scopes; role from header) | Auth required |
| `GET` | `/api/projects` | Per-project summary (`task_count`, `done_count`, `live_count`, `archived_count`, `updated`) | Public |
| `GET` | `/api/tasks/archive` | List archived tasks (`?project=` scopes to one project) | Public |
| `POST` | `/api/tasks/archive/sweep` | Run the archive sweep now (returns `{ moved, projects }`) | Auth required |
| `GET` | `/api/events` | Server-Sent Events stream of task snapshots | Public |
| `GET` | `/api/metrics` | Cross-project metrics (`?project=` scopes; cycle time, `by_status`, contention) | Public |
| `GET` | `/api/health`, `/healthz` | Read-only liveness probe (always 200) | Public |
| `GET` | `/api/health/ready` | Readiness probe — 200 once the store has loaded, 503 before (used by the deploy healthcheck) | Public |
| `POST` | `/api/auth/session` | HMAC session-token handshake (requires `KANBAN_AUTH_SECRET`) | Proof-of-secret |

---

## Deployment

The server is a stateful long-running process (in-memory store, background lease reaper, open SSE connections), so it needs a host that runs a persistent process — **not** a serverless/FaaS platform. Two deploy blueprints ship in the repo:

- **Render** — [`render.yaml`](render.yaml): a single Node web service that builds the client and serves API + SPA on one port, with a persistent disk at `/data`. The healthcheck probes `GET /api/health/ready`, which returns 503 until the store has loaded, so the platform will not route traffic to a half-booted instance.
- **Railway** — [`railway.json`](railway.json): Railpack build, `npm --prefix server start`, healthcheck at `/api/health`. The production instance lives at **<https://agent-kanban.riazrahaman.com>** (custom domain on Railway).

For either host, attach a **persistent volume/disk** and point the storage env vars at it (`KANBAN_DATA_FILE=/data/tasks.json` for the default project, `KANBAN_DATA_DIR=/data` for named projects + archives), set an auth token (`KANBAN_AUTH_TOKEN`, or scoped `KANBAN_PROJECT_TOKENS`), and set `KANBAN_ALLOWED_ORIGIN` to the public URL. Without a disk, data is lost on every redeploy. The server auto-binds `0.0.0.0` when `PORT` is injected.

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

`npm test` runs the server suite (354 tests, including the v2.7.0 server-robustness suite (archive-name collision, dependency-cycle validation, listen-error handling, in-repo storage default, readiness endpoint, Telegram truncation, CORS scheme), the v2.6.0 security-hardening suite (constant-time token compare, HMAC proof binding, purge-filter guard, SSE stream cap, auth-failure rate limiting, log/comment validation), the v2.5.7 read-auth/stream-ticket suite, the v2.5.6 trash-sink suite, the v2.5.5 backup-status suite, the Telegram reclaim-notifier guard, the branch-integrity regression guard, the v2.5.0 comments/settings suites, and the v2.5.2 purge-scope/privilege + corrupt-file fail-closed suites, and the v2.5.4 field-type validation suite; About tour screenshots refreshed in 2.5.1), the client status check, the client unit suite (107 tests, including the mobile-responsive, mobile-toolbar, dashboard-metrics, column-colors, and About-page regression guards), and compiles the production bundle.

### Releasing

Every user-visible change ships a version bump so the header can never lag the
code:

1. Bump `version` in `server/package.json` (the UI reads it live via
   `GET /api/health`) and mirror the same number into the root `package.json`.
   Additive features bump the **minor** number; fixes and polish bump the
   **patch** number; breaking changes bump the **major** number.
2. Move the accumulated `## [Unreleased]` entries in [CHANGELOG.md](CHANGELOG.md)
   into a new `## [x.y.z] — YYYY-MM-DD` section.
3. Sync the version string wherever hardcoded in
   `docs/SYSTEM_DESIGN_AND_ARCHITECTURE.md` and
   `docs/USER_AND_OPERATOR_MANUAL.md` (and their `docs/with-images/` mirrors).
4. Merge the feature branch into `main` with `--no-ff`, tag the release
   (`git tag -a vX.Y.Z -m "..."`), and push both the commit and the tag.

CI enforces step 1: `scripts/check-version-bump.sh` fails the build when
user-visible source changed but `server/package.json` still carries the base
branch's version. It is scoped deliberately — docs-only, test-only and
tooling-only changes do **not** require a bump, since those are not user-visible
behaviour. `kanban.version.test.js` cannot catch a missing bump (it only asserts
that the current version is internally consistent), which is why the rule lives
in the workflow.

Run it locally against your base branch:

```sh
git fetch origin main
./scripts/check-version-bump.sh origin/main
```

---

## Roadmap / Future Enhancements

Ideas captured from community feedback (formerly `kanban_recommendations.md` /
`kanban_handover.md`) that are deliberately **not** built yet. They are also
tracked as `opt-*` backlog cards on the live board. Honest status per item:

1. ~~**Ticket Details Panel**~~ — **shipped in v2.5.0**: the task sheet now
   carries a comments thread (server-persisted `comments[]`,
   `POST /api/tasks/:id/comments`) beside the description and activity log.
2. **Operator Assignment** — an admin/operator can already work around this by
   claiming on an agent's behalf, but there is no explicit "assign to agent"
   action beyond agent self-claim, and no avatars.
3. ~~**Custom Column Colors**~~ — **shipped in v2.5.0**: per-column accent
   overrides via `PUT /api/settings`, persisted per project and applied live
   over SSE.
4. **Milestones / Goals** — group tickets under a milestone banner and show
   per-milestone progress.
5. **Integration Hooks** — outbound webhooks / API sync with GitHub, Jira, etc.
   (the Telegram reclaim notifier is the only outbound hook today).

### From the external security & quality review (Sep 2024)

A third-party review of the codebase identified 22 findings and 12
enhancement proposals. All are triaged and tracked as `rev-*` backlog cards on
the live board (metadata `source: claude-external-review-2026-09-24`). Top
priority items:

1. ~~**Purge cross-project scope bypass (SEC-01)**~~ / ~~**Role self-assertion
   via `X-Agent-Role` (SEC-02)**~~ / ~~**Corrupt-store fail-closed (BUG-01)**~~
   — **Shipped in v2.5.2** (purge scope clamped to the authorized project,
   destructive privilege derived from the credential, corrupt store refuses to
   boot rather than loading empty).
2. ~~**Field-type validation (BUG-02)**~~ — **Shipped in v2.5.4** (non-string
   title/priority/description rejected; priority normalised to low/medium/high).
3. ~~**Soft-delete trash sink (ENH-03)**~~ — **Shipped in v2.5.6** (`DELETE`
   parks tasks in a per-project trash sink; `GET/POST/DELETE /api/tasks/trash*`).
4. ~~**Optional read authentication (ENH-01)** — `KANBAN_READ_AUTH` to gate
   GETs/SSE, with single-use HMAC stream tickets for `EventSource`.~~
   **Shipped in v2.5.7** (`KANBAN_READ_AUTH=token`, `POST /api/auth/stream-ticket`,
   client re-mints on every SSE (re)connect).
5. ~~**Backups in the deploy blueprint (ENH-02)** — enable `KANBAN_BACKUP_*` in
   `render.yaml`/`railway.json` plus a restore runbook.~~ **Shipped in v2.5.5**
   (render.yaml defaults + `scripts/restore-backup.mjs` + `docs/RESTORE.md`
   + `backup` block on `/api/health`).
6. ~~**`createTask` input hardening (BUG-03/04/05 + SEC-04)** — direct creation
   in a work state bypassed the claim contract, a body-supplied owner created
   unclaimable orphans, audit fields were forgeable, and several shapes/lengths
   were unbounded.~~ **Shipped in v2.5.8** (privileged-only non-`BACKLOG`
   creation, owner always from `/claim`, empty audit fields, validated
   `depends_on`/`metadata` + length caps).

7. ~~**Security hardening batch (BUG-07, SEC-03, SEC-05, SEC-07, ENH-09)** —
   empty/typo'd purge filters wiped the board, the HMAC session proof was
   only nonce-bound (replayable across roles/projects), SSE streams were
   uncapped, token comparison leaked length, and failed auth was unthrottled.~~
   **Shipped in v2.6.0** (recognized-key purge guard, `client_nonce:role:project`
   proof binding, `KANBAN_MAX_SSE_STREAMS`, shared constant-time
   `server/utils/constantTime.js`, `KANBAN_AUTH_RATE_LIMIT_PER_MIN`).

8. ~~**Server robustness batch (BUG-06, BUG-08, BUG-10, BUG-11, IMPL-01, IMPL-02,
   ENH-05)** — an `archive`-named project disappeared on restart, dependency
   cycles were accepted, a port-bind failure crashed the process, a stale
   sibling-repo storage path could be used when unconfigured, the deploy
   healthcheck hit an always-200 endpoint, Telegram alerts lost their critical
   rows under truncation, and the deploy CORS origin lost its scheme.~~
   **Shipped in v2.7.0** (archive skip removed, depth-capped dependency-cycle
   DFS, `server.on('error')` in `startServer`, in-repo `server/data` default,
   `GET /api/health/ready` + `render.yaml` healthcheck, protected-row Telegram
   truncation, `RENDER_EXTERNAL_URL` + scheme-normalising CORS).

The full list (SEC-01..07, BUG-01..11, PERF-01/02, IMPL-01/02,
ENH-01..12) lives on the `kanbann` project of the live board.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
