# Agent Kanban Board — File-by-File Technical Reference

This document provides a comprehensive, exhaustive walkthrough of every source, configuration, script, and documentation file across the entire `agent-kanban-board` repository.

---

## 1. Codebase Dependency & Architecture Topology

![Codebase Dependency & Architecture Topology](../images/07-codebase-dependency-topology.svg)

<details>
<summary>View Mermaid Source Code</summary>

```mermaid
flowchart TD
    subgraph Root ["Root Configuration & Tooling"]
        PackageJson["package.json\n(npm workspace scripts)"]
        Makefile["Makefile\n(test, build, sec)"]
        CI["CI Workflow\n(.github/workflows/ci.yml)"]
    end

    subgraph Server_Module ["Server Subsystem (Node.js ESM)"]
        ServerEntry["server.js\n(Express App & SSE Broadcaster)"]
        RoutesTasks["routes/tasks.js\n(REST API Router)"]
        Store["store.js\n(State Engine, RBAC, Persistence)"]
        AuthMiddleware["middleware/auth.js\n(Token & Role Auth)"]
        CorsMiddleware["middleware/cors.js\n(CORS Origin Lockdown)"]
        SanitizeServer["utils/sanitize.js\n(HTML Entity Escaper)"]
        ServerTest["test/kanban.test.js\n(Integration Test Suite)"]
        TasksJSON["tasks.json\n(JSON Storage File)"]
    end

    subgraph Client_Module ["Client Subsystem (Vite + React 18 + Tailwind)"]
        ClientEntry["main.tsx\n(React Root Mount)"]
        App["App.tsx\n(App Shell & State Coordinator)"]
        APIClient["api.ts\n(Fetch Client & EventSource SSE)"]
        BoardModel["board-model.js\n(Task Grouping Algorithm)"]
        StatusHelper["status.js / lib/status.ts\n(Status Normalizer & Styles)"]
        SignalStats["lib/signalStats.ts\n(Metric Rollup Pure Function)"]
        PriorityHelper["priority.ts\n(Triage Rank Normalizer)"]
        SanitizeClient["sanitize.ts\n(HTML Entity Escaper)"]
        
        subgraph Components ["React Components (components/)"]
            ErrorBoundary["ErrorBoundary.tsx\n(Render Crash Shield)"]
            Board["Board.tsx\n(Horizontal Column Grid)"]
            Column["Column.tsx\n(Column Card Container)"]
            TaskCard["TaskCard.tsx\n(Card Component)"]
            StatusBadge["StatusBadge.tsx\n(Editorial Status Tag)"]
            TaskSheet["TaskSheet.tsx\n(Slide-Over Inspector Drawer)"]
            SignalRail["SignalRail.tsx\n(Metrics & Activity Stream)"]
        end
    end

    subgraph Scripts_Module ["Operational Scripts (scripts/)"]
        TestAgents["test-agents.js\n(Headless Multi-Agent Swarm Simulation)"]
        TestClientStatus["test-client-status.js\n(Client Helper Resilience Test)"]
    end

    PackageJson --> Server_Module
    PackageJson --> Client_Module
    PackageJson --> Scripts_Module

    ServerEntry --> AuthMiddleware
    ServerEntry --> CorsMiddleware
    ServerEntry --> RoutesTasks
    ServerEntry --> Store

    RoutesTasks --> Store
    Store --> SanitizeServer
    Store --> TasksJSON

    ClientEntry --> App
    App --> ErrorBoundary
    App --> Board
    App --> SignalRail
    App --> TaskSheet
    App --> APIClient

    Board --> Column
    Column --> TaskCard
    TaskCard --> StatusBadge
    TaskCard --> StatusHelper
    TaskSheet --> StatusBadge
    TaskSheet --> PriorityHelper
    SignalRail --> SignalStats

    TestAgents --> ServerEntry
    TestClientStatus --> StatusHelper
    TestClientStatus --> BoardModel
```
</details>

---

## 2. Server Request Pipeline & Execution Flow

![Server Request Pipeline & Execution Flow](../images/08-server-request-pipeline.svg)

<details>
<summary>View Mermaid Source Code</summary>

```mermaid
sequenceDiagram
    autonumber
    participant Client as HTTP Client (Agent / Browser)
    participant Express as server.js
    participant CORS as middleware/cors.js
    participant Auth as middleware/auth.js
    participant Router as routes/tasks.js
    participant Queue as store.js (withMutationLock)
    participant Domain as store.js (State Machine & RBAC)
    participant Storage as JsonStorage / GitYamlStorage
    participant Broadcast as SSE (/api/events)

    Client->>Express: Incoming HTTP Request
    Express->>CORS: Evaluate Origin Header
    alt Disallowed Origin
        CORS-->>Client: Refuse Access-Control-Allow-Origin
    else Valid Origin or Server-to-Server
        CORS->>Auth: Pass to Auth Middleware
    end

    alt Mutating Request (POST, PATCH, PUT, DELETE)
        Auth->>Auth: Check KANBAN_AUTH_TOKEN configured?
        alt Token not configured
            Auth-->>Client: HTTP 503 Service Unavailable
        end
        Auth->>Auth: Validate Bearer or X-API-Token
        alt Invalid Token
            Auth-->>Client: HTTP 401 Unauthorized
        end
        Auth->>Auth: Validate Caller Role
        alt Role missing or invalid
            Auth-->>Client: HTTP 403 Forbidden
        end
    end

    Auth->>Router: Hand off to Router handler
    Router->>Queue: Enqueue Async Store Operation

    Note over Queue,Domain: Sequential Promise chain prevents race conditions
    Queue->>Domain: Execute Task Logic (Create / Patch / Claim)
    Domain->>Domain: Check ID, Valid Transitions, Role Permissions
    alt Validation / State / RBAC Check Fails
        Domain-->>Router: Error { status: 400 | 403 | 409, error: msg }
        Router-->>Client: HTTP 400 / 403 / 409 JSON response
    else Valid Operation
        Domain->>Storage: saveTask(candidate, allTasks)
        Storage->>Storage: writeAtomic() -> temp file -> rename
        opt Git Storage Backend Active
            Storage->>Storage: git add & git commit
        end
        Storage-->>Domain: Storage write confirmed
        Domain->>Domain: Update in-memory tasks array
        Domain->>Broadcast: notify(tasksSnapshot)
        Broadcast-->>Client: Push updated snapshot over SSE
        Domain-->>Router: Success { status: 200 | 201, task: candidate }
        Router-->>Client: HTTP 200 / 201 JSON response
    end
```
</details>

---

## 3. Client Component Hierarchy & Data Flow

![Client Component Hierarchy & Data Flow](../images/09-client-component-hierarchy.svg)

<details>
<summary>View Mermaid Source Code</summary>

```mermaid
flowchart TD
    App["App.tsx\nState: tasks, openTaskId, theme, loading, error\nEffect: getTasks() & subscribeToEvents()"]
    
    Header["Header Bar\nLive indicator, task count, theme toggle"]
    ErrorBoundary["ErrorBoundary.tsx\nCatches render crashes, displays fallback"]
    
    Board["Board.tsx\nReceives tasks array;\nComputes grouped tasks via groupTasks()"]
    SignalRail["SignalRail.tsx\nReceives tasks array;\nComputes signalStats & 20 recent activities"]
    TaskSheet["TaskSheet.tsx (Modal Drawer)\nReceives active task object or null;\nLive agent log feed & manual log submission form"]

    ColBacklog["Column: BACKLOG"]
    ColBuilding["Column: BUILDING"]
    ColReview["Column: IN_REVIEW"]
    ColTest["Column: IN_TEST"]
    ColBlocked["Column: BLOCKED"]
    ColDone["Column: DONE (opacity-70)"]
    ColUnknown["Column: UNKNOWN (Quarantine)"]
    ColIssues["Column: ISSUES (Swimlane)"]

    TaskCard["TaskCard.tsx\nID, StatusBadge, Title, Assigned Agent, Issue pill\nClick triggers onOpen(task.id)"]
    StatusBadge["StatusBadge.tsx\nNormalized label + glyphs (▲, •)"]

    App --> Header
    App --> ErrorBoundary
    ErrorBoundary --> Board
    ErrorBoundary --> SignalRail
    App --> TaskSheet

    Board --> ColBacklog
    Board --> ColBuilding
    Board --> ColReview
    Board --> ColTest
    Board --> ColBlocked
    Board --> ColDone
    Board --> ColUnknown
    Board --> ColIssues

    ColBacklog --> TaskCard
    ColBuilding --> TaskCard
    ColReview --> TaskCard
    ColTest --> TaskCard
    ColBlocked --> TaskCard
    ColDone --> TaskCard
    ColUnknown --> TaskCard
    ColIssues --> TaskCard

    TaskCard --> StatusBadge
    TaskSheet --> StatusBadge
```
</details>

---

## 4. Detailed File-by-File Technical Directory

### 4.1 Root Manifests & Orchestration

#### `package.json`
- **Path:** [`package.json`](../package.json)
- **Type:** Root npm configuration (`"type": "module"`).
- **Scripts:**
  - `npm test`: Runs server tests, client status tests, client unit tests, and compiles the client bundle.
  - `npm start`: Runs the backend API on port 4000.
  - `npm run build`: Produces production client bundle in `client/dist`.

#### `Makefile`
- **Path:** [`Makefile`](../Makefile)
- **Targets:**
  - `all`: Runs `test` and `build`.
  - `test`: Invokes `npm test`.
  - `build`: Invokes `npm run build`.
  - `start`: Launches backend server via `npm start`.
  - `sec`: Security audit target:
    1. Verifies that no personal absolute user home paths are leaked into tracked repository files.
    2. Enforces that `dangerouslySetInnerHTML` is never used inside `client/src/`.

#### `README.md`
- **Path:** [`README.md`](../README.md)
- **Content:** System description, quickstart guide, state machine transitions, storage engine modes, security/auth model, design system, API table, and headless demo instructions. Links to `ONBOARDING.md`.

#### `ONBOARDING.md`
- **Path:** [`ONBOARDING.md`](../ONBOARDING.md)
- **Content:** "Connect a new project" guide: the project-implicit model (no registration endpoint), the four token mechanisms, project-tagging channels, and a curl walkthrough.

#### `render.yaml`
- **Path:** [`render.yaml`](../render.yaml)
- **Content:** Render.com blueprint — a single Node web service that builds the client and serves both API + SPA, with a persistent disk mounted at `/data` and auto-generated auth tokens.

#### `railway.json`
- **Path:** [`railway.json`](../railway.json)
- **Content:** Railway config-as-code — Railpack builder, `npm --prefix server start`, and `/api/health` healthcheck.

#### `LICENSE`
- **Path:** [`LICENSE`](../LICENSE)
- **License:** MIT License.

#### `.gitignore`
- **Path:** [`.gitignore`](../.gitignore)
- **Entries:** Ignores `node_modules`, `dist`, build artifacts, and local environments.

---

### 4.2 Backend Server (`server/`)

#### `server/package.json`
- **Path:** [`server/package.json`](../server/package.json)
- **Dependencies:** `express` (^4.19.2), `cors` (^2.8.5), `yaml` (^2.9.0), with `qs` (^6.16.0) security override.
- **Scripts:** `"start": "node server.js"`, `"test": "node --test"`.

#### `server/server.js`
- **Path:** [`server/server.js`](../server/server.js)
- **Functions:**
  - `createApp()`: Instantiates Express, mounts CORS, the `/api/auth` handshake router (before auth), the auth middleware and the rate-limit middleware, mounts `/api/tasks`, `/api/projects`, `/api/metrics` and `/api/health`, handles the `/api/events` Server-Sent Events stream, serves the built client (`client/dist`) with an SPA fallback, and configures the global 500 error handler.
  - `startServer(port, host)`: Asynchronously loads tasks from storage into memory, logs the startup configuration (auth posture, CORS, rate limit), and binds the HTTP server. Host defaults to `0.0.0.0` whenever `PORT` is set (hosted) and `127.0.0.1` otherwise (local dev).
  - CLI Auto-runner: Detects direct execution and launches the server.

#### `server/store.js`
- **Path:** [`server/store.js`](../server/store.js)
- **Core Domain State & Engine:**
  - `STATUSES`: Dictionary of loop statuses (`BACKLOG`, `BUILDING`, `IN_REVIEW`, `IN_TEST`, `BLOCKED`, `DONE`).
  - `normalizeStatus(status)`: Normalizes casing and legacy aliases (e.g., `TODO` $\to$ `BACKLOG`).
  - `canTransition(fromStatus, toStatus)`: Verifies if the proposed state jump exists in `VALID_TRANSITIONS`.
  - `canRoleTransition(role, fromStatus, toStatus)`: Enforces role permissions.
  - `writeAtomic(filePath, content)`: Creates unique temp file (`.tmp_<timestamp>_<random>`), writes content, and executes `rename` for atomic POSIX replacement.
  - `withMutationLock(operation)`: Queues mutations on a sequential Promise chain to serialize asynchronous operations.
  - `JsonStorage`: Standalone single-file JSON persistence engine.
  - `GitYamlStorage`: Git-backed YAML storage engine with path traversal protection and automated `git commit`.
  - CRUD Methods: `createTask()`, `patchTask()`, `claimTask()`, `appendLog()`, `addIssue()`.

#### `server/routes/tasks.js`
- **Path:** [`server/routes/tasks.js`](../server/routes/tasks.js)
- **Endpoints:**
  - `GET /`: Returns all tasks.
  - `POST /`: Creates a new task card (Status: 201).
  - `GET /archive`: Lists archived tasks (`?project=` scopes).
  - `POST /archive/sweep`: Runs the archive sweep now.
  - `POST /purge`: Bulk-deletes selected or filtered tasks; declared before `/:id` and gated by `isPrivilegedRole`.
  - `POST /next-claim`: Claims the next available task (role from header, `?project=` scopes).
  - `GET /:id`: Retrieves single task or returns 404.
  - `DELETE /:id`: Deletes one task; privileged-role gated via `isPrivilegedRole`.
  - `PATCH /:id`: Updates status or task attributes.
  - `POST /:id/claim`: Claims task for an agent ID.
  - `POST /:id/heartbeat`: Renews a task lease.
  - `POST /:id/logs`: Appends structured operational log.
  - `GET /:id/issues`: Lists issue IDs associated with the task.
  - `POST /:id/issues`: Appends an issue ID to the task.

#### `server/routes/projects.js`
- **Path:** [`server/routes/projects.js`](../server/routes/projects.js)
- **Endpoint:** `GET /` — per-project summary (task/live/done/archived counts + `updated`).

#### `server/routes/metrics.js`
- **Path:** [`server/routes/metrics.js`](../server/routes/metrics.js)
- **Endpoint:** `GET /` — cross-project metrics (`?project=` scopes; cycle time, `by_status` histogram, claim contention, active agents).

#### `server/routes/health.js`
- **Path:** [`server/routes/health.js`](../server/routes/health.js)
- **Endpoint:** `GET /` (and `/healthz` alias) — read-only liveness/readiness probe: store state, task counts, listener counts, reaper status, version.

#### `server/routes/auth.js`
- **Path:** [`server/routes/auth.js`](../server/routes/auth.js)
- **Endpoint:** `POST /session` — HMAC session-token handshake (gated by `KANBAN_AUTH_SECRET`).

#### `server/sessionAuth.js`
- **Path:** [`server/sessionAuth.js`](../server/sessionAuth.js)
- **Functions:** `authSecret()`, `createSessionToken()`, `verifySessionToken()` — stateless HMAC-SHA256 session tokens (24h expiry, role+project bound).

#### `server/notifier.js`
- **Path:** [`server/notifier.js`](../server/notifier.js)
- **Purpose:** §2.11 outbound Telegram alerts when the lease reaper returns a task to `BACKLOG`.
- **Functions:** `notifierConfig()`, `shouldNotify()`, `formatReclaimMessage()`, `startNotifier()`, `stopNotifier()`, `isNotifierRunning()`.
- **Design:** a pure subscriber on `store.onDiff` (no mutation-path surface). It filters `kind === 'reclaimed'` events by `reason` (`lease_expired` / `orphan_normalized`) and by project, renders a full-detail HTML message (project, task, title, work context, branch, dependencies, issues, truncated description, reason, previous owner, lease expiry, last activity, reclaim count, stage owners, last log, deep link), and POSTs it to the Bot API with the global `fetch` — **no new dependency**. Sends are serialized with a minimum interval and honour `429 retry_after`. Delivery is fail-silent: an outage is logged and never affects the reclaim. Off unless both `KANBAN_TELEGRAM_BOT_TOKEN` and `KANBAN_TELEGRAM_CHAT_ID` are set; the token is redacted from logs.

#### `server/middleware/auth.js`
- **Path:** [`server/middleware/auth.js`](../server/middleware/auth.js)
- **Enforcement:**
  - Permits open read-only access for `GET` requests.
  - Fails closed with 503 if no auth mechanism (`KANBAN_AUTH_TOKEN`, `KANBAN_PROJECT_TOKENS`, or `KANBAN_AUTH_SECRET`) is configured.
  - Tries HMAC session tokens first, then falls back to static tokens: per-project (`KANBAN_PROJECT_TOKENS`), admin (`KANBAN_ADMIN_TOKEN`, audited as `admin_write`), or global (`KANBAN_AUTH_TOKEN`). Returns 401 on mismatch.
  - Validates caller role against `VALID_ROLES`. Missing/unauthorized role returns 403.
  - Optional redacted auth-failure logging via `KANBAN_AUTH_LOG`.

#### `server/middleware/projectScope.js`
- **Path:** [`server/middleware/projectScope.js`](../server/middleware/projectScope.js)
- **Enforcement:** Extracts every project a request references (body, query, header, composite path) and guards invalid `?project=` as 400 — never a silent widening to the whole portfolio.

#### `server/middleware/rateLimit.js`
- **Path:** [`server/middleware/rateLimit.js`](../server/middleware/rateLimit.js)
- **Enforcement:** Per-project fixed-window rate limiting on mutations, off unless `KANBAN_RATE_LIMIT_PER_MIN` is set.

#### `server/middleware/cors.js`
- **Path:** [`server/middleware/cors.js`](../server/middleware/cors.js)
- **Enforcement:** Enforces an explicit allow-list of origins (`KANBAN_ALLOWED_ORIGIN`, comma-separated, defaults to `http://localhost:5173`). Forbids wildcard `*` and empty entries.

#### `server/utils/sanitize.js`
- **Path:** [`server/utils/sanitize.js`](../server/utils/sanitize.js)
- **Function:** `escapeHtml(str)` escapes HTML characters (`&`, `<`, `>`, `"`, `'`) to prevent Stored XSS.

#### `server/test/` (Node.js built-in test runner)
- **Paths:** `server/test/kanban.*.test.js`
- **Coverage:** The server suite (196 tests across 23 files) covers duplicate prevention and CRUD (`kanban.test.js`), state transitions + role gating, claim leases and the reaper (`kanban.lease.test.js`), dependency-gated unblocking (`kanban.deps.test.js`), metrics aggregation (`kanban.metrics.test.js`), projects/portfolio summaries (`kanban.projects.test.js`), archive sweep (`kanban.archive.test.js`), SSE diff events (`kanban.events.test.js`), concurrency/mutation-lock behavior (`kanban.concurrency.test.js`), per-project token isolation (`kanban.projectauth.test.js`), cross-project scoping (`kanban.scoping.test.js`), next-claim role binding (`kanban.nextclaim.test.js`), fail-closed auth, HMAC session tokens (`kanban.sessionauth.test.js`), redacted auth logging (`kanban.authlog.test.js`), CORS allow-list (`kanban.cors.test.js`), the health endpoint (`kanban.health.test.js`), periodic backups (`kanban.backup.test.js`), the IPv6/HOST resolution fix (`kanban.host.test.js`), ownerless-active task normalization (`kanban.orphan.test.js`), admin delete + bulk purge (`kanban.purge.test.js`), per-stage ownership (`kanban.stageowners.test.js`), the release-version guard (`kanban.version.test.js`), and Telegram reclaim notifications (`kanban.notify.test.js`).

#### `server/tasks.json`
- **Path:** [`server/tasks.json`](../server/tasks.json)
- **Role:** Default-project JSON store (created/updated at runtime); the file also ships sample/seeded tasks.

---

### 4.3 Frontend Client (`client/`)

#### `client/package.json`
- **Path:** [`client/package.json`](../client/package.json)
- **Dependencies:** `react` (^18.3.1), `react-dom` (^18.3.1).
- **DevDependencies:** `vite`, `@vitejs/plugin-react`, `typescript`, `tailwindcss`, `postcss`, `autoprefixer`, `esbuild`.
- **Scripts:** `dev`, `build` (`tsc -b && vite build`), `preview`, `test`.

#### `client/vite.config.ts`
- **Path:** [`client/vite.config.ts`](../client/vite.config.ts)
- **Settings:** Configures the Vite dev server port (`VITE_PORT`, default 5173), the React plugin, and a dev proxy forwarding `/api` to `http://localhost:4000` (changeOrigin) so same-origin `/api` calls reach the backend during local development.

#### `client/tailwind.config.js`
- **Path:** [`client/tailwind.config.js`](../client/tailwind.config.js)
- **Configuration:** Defines semantic color variables (`bg`, `surface`, `line`, `ink`, `muted`, `pass`, `fail`, `warn`, `block`, `live`) and editorial font stacks (`serif`, `mono`, `sans`).

#### `client/postcss.config.js`
- **Path:** [`client/postcss.config.js`](../client/postcss.config.js)
- **Settings:** Tailwind and Autoprefixer plugin registration.

#### `client/tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`
- **Paths:** [`client/tsconfig.json`](../client/tsconfig.json), [`client/tsconfig.app.json`](../client/tsconfig.app.json), [`client/tsconfig.node.json`](../client/tsconfig.node.json)
- **Settings:** Strict TypeScript type checking rules for browser and build environments.

#### `client/index.html`
- **Path:** [`client/index.html`](../client/index.html)
- **Content:** Single-page entry HTML, Google font preloading, responsive `<meta name="viewport">`, and an inline pre-paint theme script that applies the stored/OS theme before React mounts (avoids a flash of the wrong theme).

#### `client/src/index.css`
- **Path:** [`client/src/index.css`](../client/src/index.css)
- **Styles:** Light (warm cream) and dark theme CSS variable definitions meeting WCAG AA contrast standards, explicit `color-scheme` per theme (so native form controls match), `@supports (height:100dvh)` shell-height override, `.board-scroll` visible-scrollbar rules, tabular numeric font setup, and minimal global scrollbars.

#### `client/src/main.tsx`
- **Path:** [`client/src/main.tsx`](../client/src/main.tsx)
- **Execution:** Mounts `<App />` into the DOM root under `<React.StrictMode>`.

#### `client/src/App.tsx`
- **Path:** [`client/src/App.tsx`](../client/src/App.tsx)
- **Components & Hooks:** App shell and state coordinator. Manages `tasks`, `openTaskId`, `project` filter, `view` (Board/Portfolio/About), `theme`, `railOpen`, and the agent-id/api-token identity. Fetches `getTasks` + subscribes to SSE scoped by project, fetches `/api/health` for the header version chip. Renders a wrapping responsive header (with the three-way Board/Portfolio/About segmented switcher), `<Board />`, `<About />`, `<SignalRail />` (docked at `md`+, slide-over drawer below), `<TaskSheet />`, and `<ErrorBoundary />`.

#### `client/src/types.ts`
- **Path:** [`client/src/types.ts`](../client/src/types.ts)
- **Definitions:** Core data types (`TaskStatus`, `TaskPriority`, `AgentLog`, `Task`).

#### `client/src/api.ts`
- **Path:** [`client/src/api.ts`](../client/src/api.ts)
- **Functions:** HTTP client for REST operations (`getTasks`, `getTask`, `patchTask`, `claimTask`, `appendLog`) and `subscribeToEvents(onTasks)` for native `EventSource` SSE integration.

#### `client/src/status.js` & `status.d.ts`
- **Paths:** [`client/src/status.js`](../client/src/status.js), [`client/src/status.d.ts`](../client/src/status.d.ts)
- **Functions:** `normalizeStatus()` and `statusStyle()` resolving status strings to border stripes and badge color combinations.

#### `client/src/board-model.js` & `board-model.d.ts`
- **Paths:** [`client/src/board-model.js`](../client/src/board-model.js), [`client/src/board-model.d.ts`](../client/src/board-model.d.ts)
- **Function:** `groupTasks(tasks)` categorizing tasks into column arrays by status (`BACKLOG`, `BUILDING`, `IN_REVIEW`, `IN_TEST`, `BLOCKED`, `DONE`, `UNKNOWN`) and aggregating issues into a dedicated `ISSUES` array.

#### `client/src/priority.ts`
- **Path:** [`client/src/priority.ts`](../client/src/priority.ts)
- **Function:** `normalizePriority()` safely mapping triage ratings (`P0-critical`, etc.) to `'high' | 'medium' | 'low'`.

#### `client/src/sanitize.ts`
- **Path:** [`client/src/sanitize.ts`](../client/src/sanitize.ts)
- **Function:** Client-side HTML string escaping.

#### Components (`client/src/components/`)
- **`Board.tsx`:** Renders the horizontally snap-scrolling column container for all 8 columns including `UNKNOWN`, with edge-fade gradients and paging chevrons that appear when columns are off-screen.
- **`Column.tsx`:** Renders a column header with task count badge and vertically scrolling card container. Responsive: `85vw` with snap alignment below `md`, fixed `w-72` from `md` up. Memoized.
- **`TaskCard.tsx`:** Renders card ID, status stripe, title, project chip (unscoped board only), agent assignment, and issues badge. Memoized.
- **`StatusBadge.tsx`:** Renders status glyphs (`▲`, `•`) and styling.
- **`TaskSheet.tsx`:** Slide-over modal displaying card details (including the project), metadata, logs timeline, and human log submission form.
- **`SignalRail.tsx`:** Right sidebar rendering Signal Overview metric tiles and recent activity feed. Docked at `md`+, rendered as a mobile slide-over drawer below `md`.
- **`Portfolio.tsx`:** Cross-project aggregate view with per-project summary rows.
- **`About.tsx`:** In-app product overview (third top-level view). Renders the elevator pitch, a headless-first curl snippet, a trust strip, the "why a normal board isn't enough" cards, the lifecycle walk, capabilities, an **Architecture & code flow** section (the stack table, the step-by-step next-claim code path, the three safety layers around every write, and a six-layer summary — all data-driven and mobile-first, with the stack table collapsing to labelled cards below `sm`), a curated tour of `/landing/*.png` screenshots, an FAQ, and the community CTA. Takes the live server `version` as a prop so the page can never show a stale version.
- **`HeaderHelp.tsx`:** Header `i` button opening a popover that explains the agent-id (auto-claim) and api-token header fields.
- **`ErrorBoundary.tsx`:** React Class Error Boundary containing card render errors.

#### Client Libraries (`client/src/lib/`)
- **`theme.ts`:** Pure theme resolution helpers (`resolveTheme`, `nextTheme`, `isDark`, `THEME_STORAGE_KEY`).
- **`status.ts`:** `CANONICAL_STATUSES` and `ACTIVE_STATUSES` matching backend definitions.
- **`signalStats.ts`:** `computeSignalStats(tasks)` calculating active/blocked/done counts.
- **`portfolioMetrics.ts`:** Cross-project rollup calculations for the Portfolio view.
- **`claimCoordinator.ts` / `useClaimCoordinator.ts`:** Client-side lease heartbeat + auto-claim coordination bound to the operator's agent identity.
- **`authToken.ts`:** Browser-local storage/wiring of the operator's API token.
- **`aboutContent.ts`:** Pure data for the About view (trust metrics, why-cards, lifecycle steps, capabilities, FAQ, curl snippet, tour-shot list, `RECLAIM_INTRO` / `RECLAIM_FLOW`, and the architecture data — stack rows, claim flow, safety layers, six-layer summary) — no JSX, so it is unit-testable and keeps the copy out of the component.
- **Test files (`*.test.mjs`):** `signalStats`, `boardModel`, `memoComparator`, `portfolioMetrics`, `claimCoordinator`, `theme`, `authToken`, `stageOwners`, `about`, and `responsive` — run under `node:test` (TypeScript compiled on the fly via `esbuild`). The `memoComparator` and `reactStubForMemoTest` pair use a React stub to exercise the `React.memo` comparators directly; `responsive.test.mjs` is the mobile-layout regression guard.

---

### 4.4 Scripts & CI Workflows

#### `scripts/test-agents.js`
- **Path:** [`scripts/test-agents.js`](../scripts/test-agents.js)
- **Role:** Headless multi-agent workflow demo script simulating Agent-Alpha and Agent-Beta claiming, transitioning, and logging against cards via REST calls.

#### `scripts/test-client-status.js`
- **Path:** [`scripts/test-client-status.js`](../scripts/test-client-status.js)
- **Role:** Test validating client status normalizer resilience against malformed inputs.

#### `.github/workflows/ci.yml`
- **Path:** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
- **Pipeline:** Automated CI running discrete steps — security checks (`make sec`), server tests (`npm --prefix server test`), client status tests, client unit tests (`npm --prefix client test`), and the production build — across Node 20.x and 22.x, using `actions/checkout@v4` and `actions/setup-node@v4`.
