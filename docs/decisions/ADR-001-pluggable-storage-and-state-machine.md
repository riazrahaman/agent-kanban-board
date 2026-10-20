# ADR-001 — Pluggable Storage Backend, Loop State Machine, and Access Controls

**Task:** PI-03 (KB-01, KB-02, KB-03, KB-04, KB-05, KB-08, KB-09)  
**Status:** accepted — **partially superseded** by [ADR-004](ADR-004-agentos-8-state-workflow-migration.md) (§1 statuses) and [ADR-005](ADR-005-role-bound-roles.md) (§2 role ownership, §4 role-bearing authentication). See the notes on each section.

> **Superseded in part.** This ADR remains in force for its storage, atomicity and
> claim-contention decisions (§3, §5, §6). Two areas have since been replaced:
> - **§1 Canonical Loop Statuses & Transitions** — replaced by
>   [ADR-004](ADR-004-agentos-8-state-workflow-migration.md) (the AgentOS 8-state
>   workflow: `BACKLOG → READY → PLANNING → IN_PROGRESS → IN_REVIEW → VALIDATION →
>   READY_TO_SHIP → DONE`, `+ BLOCKED`).
> - **§2 Role Ownership Rules and §4 API Authentication** — replaced by
>   [ADR-005](ADR-005-role-bound-roles.md) (credential-bound roles, shipped in
>   v3.8.0). The role is derived from the credential, not from a self-declared
>   header; the header is the role source only for legacy unbound credentials.

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

Role identity is passed via `X-Agent-Role` header or request body (superseded below — see §2 note):
- **Builder**: may transition to `BUILDING` and `IN_REVIEW`. Transitioning to `IN_TEST` or `DONE` is refused with `403 Forbidden`.
- **Reviewer**: may transition to `IN_TEST` (PASS) or `BUILDING` (CHANGES_REQUESTED). Transitioning to `DONE` is refused with `403 Forbidden`.
- **Tester**: may transition to `DONE` (PASS) or `BUILDING` (FAIL).
- **Runner / System / Human**: controls `BLOCKED` (which is automated from `depends_on` per spec Sec 3.2) and administrative operations.
- A missing role is refused for status changes; it is never treated as `human`.

> **Superseded in v3.8.0 (ADR-005, credential-bound roles):** the role used by `canRoleTransition` is derived from the credential (role-bound `KANBAN_PROJECT_TOKENS` credentials) or from the credential-derived privileged path (admin token → `admin`, server-issued sessions) — never from the caller-declared header alone. `X-Agent-Role` still declares the role only for legacy unbound credentials; a body `role` on a `PATCH` is rejected with `400`.

### 3. Claim Contention (KB-03)

`POST /api/tasks/:id/claim` requires `agent_id`. If the task is currently held by another agent, the request is refused with `409 Conflict`. Re-claiming by the current holder is idempotent (200). Claiming transitions an unstarted task from `BACKLOG` to `BUILDING`.

### 4. API Authentication (KB-04 / OWASP A07)

All mutating endpoints (`POST`, `PATCH`, `PUT`, `DELETE`) require `KANBAN_AUTH_TOKEN` and a valid `Authorization: Bearer <token>` or `X-API-Token: <token>`. Unauthenticated or invalid requests receive `401 Unauthorized`; if the token is not configured, mutations fail closed with `503`. Read routes remain open for monitoring.

> **Superseded in v3.8.0 (ADR-005, credential-bound roles):** authentication is
> unchanged, but the *role* is no longer part of the request. A per-project
> credential may carry a bound role (`{"token": "...", "role": "builder"}`), and
> the server derives the caller's role from that credential. `X-Agent-Role`
> remains meaningful only for legacy unbound credentials; a body `role` on a
> `PATCH` is refused with `400`. Privileged roles (`runner`/`system`/`human`/
> `admin`) cannot be bound to a shared credential — they come from the admin
> token or a server-issued session.

### 5. Atomic Persistence (KB-05)

All file writes use `writeAtomic`: content is written to a unique temporary file (`.tmp_<timestamp>_<random>`) in the same directory and atomically moved into place using `fs.rename`. In-memory state and SSE event broadcasts update only after the disk write successfully resolves.

### 6. Pluggable Storage (KB-09)

Configured via `KANBAN_STORAGE_BACKEND`:
- **`json`**: Maintains single-file JSON storage (`KANBAN_DATA_FILE` or `server/tasks.json`) for standalone runs when explicitly selected.
- **`git`**: Writes individual YAML task cards to `KANBAN_GIT_DIR` or `ops/kanban/<ID>.yml` matching spec Sec 3.2 schema. When inside a git repository, each state transition creates an atomic git commit: `ops(<ID>): kanban <STATUS>`.

This desk checkout selects `git` by default and resolves its sibling desk cards
at `KANBAN_GIT_DIR` (or `KANBAN_DATA_DIR`). When neither env var is set, storage
defaults to an in-repo `server/data` directory (with a one-time warning nudging
operators to set one explicitly in production); a reusable clone selects `json`
explicitly or supplies its own `KANBAN_GIT_DIR`.

## Consequences

- Standalone use continues to work without configuration.
- Desk repos can point an independent clone at `ops/kanban/` via `KANBAN_STORAGE_BACKEND=git` without data cross-wiring.
- Prevents race conditions and unauthorized card movements across multi-agent swarms.
