# ADR-001 — Pluggable Storage Backend, Loop State Machine, and Access Controls

**Task:** PI-03 (KB-01, KB-02, KB-03, KB-04, KB-05, KB-08, KB-09)  
**Status:** accepted

## Context

The initial kanban board implementation provided an open JSON-backed API without transition constraints or multi-agent safeguards. Probing the running service confirmed several structural gaps (spec Sec 9.4.3):
- **KB-01**: No state machine — `PATCH /api/tasks/:id {status:"done"}` succeeded from any state.
- **KB-02**: No role ownership — any caller could move cards to `DONE` or modify assignments without permission checks.
- **KB-03**: No claim contention — a second claim silently stole a task from an active worker.
- **KB-04**: Unauthenticated mutation (OWASP A07) — `agent_id` was purely self-asserted in request bodies.
- **KB-05**: Non-atomic persistence — whole-file writes without temp-files risked corrupting the store on mid-write crashes, and in-memory state was updated before disk writes succeeded.
- **KB-08**: Statuses did not match the loop protocol, and there was no issue register.
- **KB-09**: Hardcoded JSON storage prevented pointing a running instance at a consuming project's git-tracked `ops/kanban/` cards.

## Decisions

### 1. Canonical Loop Statuses & Transitions (KB-01, KB-08)

The board adopts the loop statuses: `BACKLOG`, `BUILDING`, `IN_REVIEW`, `IN_TEST`, `BLOCKED`, `DONE` (normalizing legacy lowercase values).
The transition graph is strictly enforced:
- `BACKLOG → BUILDING`
- `BUILDING → IN_REVIEW`, `BLOCKED`
- `IN_REVIEW → IN_TEST`, `BUILDING`, `BLOCKED`
- `IN_TEST → DONE`, `BUILDING`, `BLOCKED`
- `BLOCKED → BUILDING`, `IN_REVIEW`, `IN_TEST`, `BACKLOG`
- `DONE` is terminal

Any transition outside this graph is refused with `409 Conflict`.

### 2. Role Ownership Rules (KB-02)

Role identity is passed via `X-Agent-Role` header or request body:
- **Builder**: may transition to `BUILDING` and `IN_REVIEW`. Transitioning to `IN_TEST` or `DONE` is refused with `403 Forbidden`.
- **Reviewer**: may transition to `IN_TEST` (PASS) or `BUILDING` (CHANGES_REQUESTED). Transitioning to `DONE` is refused with `403 Forbidden`.
- **Tester**: may transition to `DONE` (PASS) or `BUILDING` (FAIL).
- **Runner / System / Human**: controls `BLOCKED` (which is automated from `depends_on` per spec Sec 3.2) and administrative operations.
- A missing role is refused for status changes; it is never treated as `human`.

### 3. Claim Contention (KB-03)

`POST /api/tasks/:id/claim` requires `agent_id`. If the task is currently held by another agent, the request is refused with `409 Conflict`. Re-claiming by the current holder is idempotent (200). Claiming transitions an unstarted task from `BACKLOG` to `BUILDING`.

### 4. API Authentication (KB-04 / OWASP A07)

All mutating endpoints (`POST`, `PATCH`, `PUT`, `DELETE`) require `KANBAN_AUTH_TOKEN` and a valid `Authorization: Bearer <token>` or `X-API-Token: <token>`. Unauthenticated or invalid requests receive `401 Unauthorized`; if the token is not configured, mutations fail closed with `503`. Read routes remain open for monitoring.

### 5. Atomic Persistence (KB-05)

All file writes use `writeAtomic`: content is written to a unique temporary file (`.tmp_<timestamp>_<random>`) in the same directory and atomically moved into place using `fs.rename`. In-memory state and SSE event broadcasts update only after the disk write successfully resolves.

### 6. Pluggable Storage (KB-09)

Configured via `KANBAN_STORAGE_BACKEND`:
- **`json`**: Maintains single-file JSON storage (`KANBAN_DATA_FILE` or `server/tasks.json`) for standalone runs when explicitly selected.
- **`git`**: Writes individual YAML task cards to `KANBAN_GIT_DIR` or `ops/kanban/<ID>.yml` matching spec Sec 3.2 schema. When inside a git repository, each state transition creates an atomic git commit: `ops(<ID>): kanban <STATUS>`.

This desk checkout selects `git` by default and resolves its sibling desk cards
at `../../agent-based-investment/ops/kanban`; a reusable clone selects `json`
explicitly or supplies its own `KANBAN_GIT_DIR`.

## Consequences

- Standalone use continues to work without configuration.
- Desk repos can point an independent clone at `ops/kanban/` via `KANBAN_STORAGE_BACKEND=git` without data cross-wiring (ADR-005).
- Prevents race conditions and unauthorized card movements across multi-agent swarms.
