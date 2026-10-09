# ADR-004 — Migration to AgentOS 8-State Workflow

**Task:** AgentOS 8-State Lifecycle Migration  
**Status:** accepted  
**Date:** 2026-10-09  

## Context

The board previously enforced a 5-state lifecycle (`BACKLOG → BUILDING → IN_REVIEW → IN_TEST → DONE` plus `BLOCKED`). AgentOS (PRD §11) specifies an 8-state workflow. Decision D2 of the AgentOS PRD review mandates upgrading the board directly to the 8 canonical states rather than maintaining an impedance-mismatch translation layer.

The 8 canonical states are:
`BACKLOG → READY → PLANNING → IN_PROGRESS → IN_REVIEW → VALIDATION → READY_TO_SHIP → DONE` (plus side state `BLOCKED`).

## Key Decisions

### 1. Claim Target
`POST /claim` targets `IN_PROGRESS` from `READY`. When a builder agent issues `POST /claim` on a task in `READY`, the task transitions to `IN_PROGRESS` and leases the task to the claiming agent.
`PLANNING` is an active stage that may be entered via an explicit role-gated `PATCH` by a `planner` (or system/admin/human) or via `POST /claim` if an agent specifies `target_status: "PLANNING"` (or planner role). By default, `POST /claim` lifts `READY → IN_PROGRESS`.

### 2. Can BACKLOG Be Claimed Directly?
No. `BACKLOG` cannot be claimed directly by builder agents. Only tasks in `READY` are claimable.
Promotion from `BACKLOG → READY` is a transition gated to `planner`, `human`, `system`, or `admin`. Additionally, when task dependencies are satisfied, automated unlock promotes eligible tasks to `READY` (rather than remaining in `BACKLOG`).

### 3. Is PLANNING Mandatory?
No, `PLANNING` is optional. Direct transition from `READY → IN_PROGRESS` is fully legal, enabling simple or pre-specified tasks to bypass planning without artificial friction.

### 4. READY_TO_SHIP Ownership & Lease Semantics
`READY_TO_SHIP` is a queue state representing work that is validated and awaiting deployment, merge, or release.
- It carries **no lease** and is **not claim-gated**.
- Only a `releaser`, `admin`, `system`, or `human` role may transition a task from `READY_TO_SHIP → DONE` (or return it to `IN_PROGRESS`).

### 5. Versioning and Backwards Compatibility
- Version bump: **Major version 3.0.0** due to the breaking change in canonical state vocabulary.
- Backwards compatibility aliases: The server's `normalizeStatus` accepts legacy names on input:
  - `BUILDING` maps to `IN_PROGRESS`
  - `IN_TEST` maps to `VALIDATION`
  - `TODO` maps to `BACKLOG`
- Historical audit logs and journals are not retroactively rewritten; consumers read through normalization.
- In-memory/storage load migrations idempotently rewrite task status strings and `stage_owners` keys without incrementing task entity `version` numbers.
