# Agent Kanban Board — Multi-Project Enhancement Recommendations

**Status:** Historical implementation record — §2.1–§2.10 shipped; §2.11 (distributed lock) and §2.12 (WebSocket push channel) remain future scope.
**Scope:** Enable multiple parallel projects / agent swarms to safely share a single Kanban server instance.
**Author context:** Produced from a code review of `server/store.js`, `server/server.js`, `server/routes/tasks.js`, `server/middleware/auth.js`, `client/src/App.tsx`, and `client/src/types.ts` on the current `main` branch.

---

## 1. Why This Matters

The current implementation is solid for a **single-project, single-swarm** loop: it has atomic writes, a process-local mutation lock, an RBAC-gated state machine, claim contention handling, XSS sanitization, and fail-closed auth. However, it was never designed for **multi-tenancy**, and the gap is visible throughout the codebase:

- The `Task` schema (`client/src/types.ts`, `server/store.js`) has **no `project`/`workspace` field** — task IDs are globally unique, so two projects both using `task-1` will collide.
- `JsonStorage` and `GitYamlStorage` each point at **one file / one directory** — there is no per-project partitioning.
- `/api/events` (SSE) broadcasts the **entire task list** to every connected client on every mutation — there is no per-project channel, so Project A's dashboard re-renders on Project B's noise, and bandwidth grows with the total swarm count across *all* projects, not just the one being watched.
- `KANBAN_AUTH_TOKEN` is a **single global shared secret** — any agent from any project can mutate any other project's tasks.
- `withMutationLock` is a single **process-local** `Promise` chain — fine for one Node process, but there is no path to running this multi-instance/HA, and no optimistic-concurrency (version/ETag) check for safety if that ever changes.
- Claimed tasks have **no lease/TTL** — a crashed agent leaves a task stuck in `BUILDING` forever, silently blocking that project's pipeline.
- The `depends_on` field exists in the schema but **nothing enforces it** — an agent can claim a task whose dependencies are not yet `DONE`.
- There is **no archiving** — `DONE` tasks accumulate forever in the same file/list across every project, and the client renders and diffs the *whole* array on every SSE tick.

---

## 2. Recommended Enhancements

### 2.1 Project/Workspace Namespacing — *highest priority*
- Add `project` (or `workspace_id`) as a **required** field on every task.
- Scope task IDs internally as `project:id` to prevent cross-project collisions while keeping human-friendly short IDs per project.
- Add `GET /api/tasks?project=X` filtering.
- Add `GET /api/projects` to list active projects with task counts.
- Partition storage per project:
  - JSON backend: `KANBAN_DATA_DIR/tasks/<project>.json`
  - Git backend: `ops/kanban/<project>/<id>.yml`

### 2.2 Scoped Real-Time Channel
- Support `/api/events?project=X` so SSE subscribers receive only their project's snapshot/diffs, not the global list.
- Switch from full-snapshot broadcast to **diff/delta events** (`task.created`, `task.updated`, `task.claimed`, etc.) so bandwidth does not scale with total swarm size across all projects.

### 2.3 Per-Project Auth & Isolation
- Replace the single global `KANBAN_AUTH_TOKEN` with **per-project tokens** (or a JWT/API key carrying a `project` claim), so a compromised agent in one project cannot mutate another project's board.
- Add per-project rate limiting so one runaway swarm cannot starve others sharing the server.

### 2.4 Claim Lease + Stale-Task Reaper
- Add `claim_expires_at` at claim time; require agents to heartbeat/renew via `POST /:id/heartbeat`, or the claim auto-expires.
- Run a background sweep that returns expired `BUILDING` / `IN_REVIEW` / `IN_TEST` tasks to `BACKLOG` and logs the reclaim event.
- This is critical for parallel swarms, where individual agent processes can die without any notification to the server.

### 2.5 Dependency-Gated Claiming
- Enforce `depends_on` at claim time: reject `POST /:id/claim` with `409` if any dependency is not `DONE`.
- Optionally auto-promote a task from `BLOCKED` → `BACKLOG` when its last dependency completes (event-driven rather than polling).

### 2.6 Optimistic Concurrency
- Add a `version` integer to each task.
- `PATCH` requests should accept an `If-Match` / `expected_version` value and return `409` on mismatch.
- Cheap safety net for running more than one server instance per project, or for CAS-style updates from multiple orchestrators.

### 2.7 Fair Claim Queue / Assignment Endpoint
- Add `POST /api/tasks/next-claim?project=X&role=builder` that atomically returns and assigns the highest-priority unclaimed, dependency-satisfied task.
- Removes the need for every agent to race `GET`+`POST /claim` and eat `409`s.
- Priority-aware FIFO within a project reduces claim-contention noise under many parallel agents.

### 2.8 Archiving & Storage Hygiene
- Auto-move `DONE` tasks older than N days to `archive/<project>/` after a grace period, keeping the live/working set small per project.
- Add `GET /api/tasks/archive?project=X` for historical/reporting queries.

### 2.9 Cross-Project Observability
- Add `GET /api/metrics?project=X` returning cycle time (`BACKLOG`→`DONE`), reclaim count, claim-contention rate, and active-agent count — per project and aggregated across all projects.
- Replace ad hoc `console.warn`/`console.error` calls with a structured audit log per mutation: who, what, project, before/after status. This becomes necessary once multiple teams' agents share one server.

### 2.10 Client UI for Multi-Project
- Add a project switcher/filter in the header (dropdown or tabs) instead of a single flat 8-column board mixing everything together.
- Consider a cross-project "Portfolio" view: one row per project showing WIP/blocked/done counts, so a human operator watching multiple swarms does not have to flip between boards.

### 2.11 Horizontal Scale Readiness
- Move `withMutationLock` from a process-local `Promise` chain to a proper lock (file lock, Redis, or DB row lock) once throughput from many projects' agents on one server exceeds a single Node process.

### 2.12 WebSocket Option for Agent-Side Push
- SSE is server→client only. If agents themselves want a push channel (e.g., "someone just claimed the task you wanted") rather than polling `GET /api/tasks`, a WebSocket upgrade path would reduce polling load generated by N parallel agent processes.

---

## 3. Suggested Implementation Order

For the highest leverage against "multiple parallel projects sharing one server" specifically, implement in this order:

1. **§2.1 Project/workspace namespacing** — without this, nothing else in this document is meaningful; it is the structural prerequisite.
2. **§2.4 Claim lease + stale-task reaper** — prevents one project's crashed agent from silently stalling that project's pipeline indefinitely.
3. **§2.7 Fair claim queue** — removes claim-contention noise once many agents across many projects are polling/claiming concurrently.
4. Remaining items (§2.2, §2.3, §2.5, §2.6, §2.8–§2.12) can follow incrementally as scale and team count grow.

---

## 4. Non-Goals / Out of Scope for This Pass

- Full multi-tenant billing/quota enforcement.
- Cross-project task dependencies (dependencies are assumed to stay within a project for now).
- Migrating storage engines away from JSON/Git-YAML (the pluggable storage design from ADR-001 is retained; this document only adds project-scoping on top of it).
