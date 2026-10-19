# ADR-005 — Credential-Bound Roles

**Task:** Credential-bound roles (make `canRoleTransition` check a server-verified role)  
**Status:** accepted  
**Date:** 2026-10-19

## Context

ADR-001 §2 (KB-02) introduced role ownership, but the role it checked was **caller-declared**: `req.caller.role` came from the `X-Agent-Role` header or a `body.role` fallback, and auth only validated that it was a *known* role name. A credential proved *that* a request was authenticated; it never proved *who was acting*.

Consequence (observed live on the hosted board, 83% of 413 tasks): one agent holding one valid token could walk a card through every stage — builder → reviewer → releaser — by re-declaring a different role on each `PATCH`. The role gate (`canRoleTransition`, 403) was never lied to; it just was never told who was doing the declaring. Two side doors widened the hole: a body-supplied `role` was a fallback in `patchTask`, and the admin-token path kept the header role instead of deriving `admin`. The precedent of SEC-02 (destructive privilege derived from the credential, not the header) had never been extended to roles.

## Decision

Bound the role to the credential that proved the request; enforce it server-side. Fully backward compatible per deployment: existing values keep working, and roles only become forced when an operator opts in per credential.

1. **`KANBAN_PROJECT_TOKENS` value shapes extended** (`parseProjectTokens`):
   - `"tok-a"` — legacy string, **unbound** (header role kept).
   - `{"token":"tok-a"}` — explicit unbound, same behavior.
   - `{"token":"tok-b","role":"builder"}` — **role-bound**: the server derives the role from the credential (`roleSource: 'credential'`). Only functional roles (planner, builder, reviewer, tester/validator, releaser) may be bound; the privileged set `{runner, system, human, admin}` cannot — they come only from the admin token or server-issued sessions.
   - `{"credentials":[{token, role}, …]}` — several bound credentials per project (a real pipeline needs one per role, on distinct tokens).
   - Mixed shapes in one env var are allowed; the same token may appear in several projects (role resolves per project match). Any malformed variant (empty token, unknown role, privileged role, empty credentials array) is a config failure → existing 503 fail-closed path.
2. **Mutation middleware derives the role** (`middleware/auth.js`): a bound credential forces `req.caller.role` from the credential; the `X-Agent-Role` header on a bound credential is ignored, and a *conflicting* header is served-with-override but audited as `role_binding_mismatch` (declared vs bound). Unbound credentials keep the header role (`roleSource: 'header'`). The `KANBAN_ADMIN_TOKEN` bearer now derives `caller.role = "admin"` instead of leaving the header role. Legacy single-token mode (`KANBAN_AUTH_TOKEN`) is unchanged — a documented limitation whose migration path is per-project tokens. Session tokens already carried server-issued roles and are unchanged.
3. **Side doors closed** (`store.js`): the `patch.role` fallback in `patchTask` is removed and a body `role` field on a `PATCH` is rejected with `400` (the role used by the state machine is `caller.role`, never the body).
4. **Observability**: `checkCredentialCoverage` reports `bound_credentials` / `unbound_credentials` on `GET /api/health` (`credential_map`) and boots with a warning when per-project tokens are configured but 100% unbound — the exact observed failure mode. Enabling the audit log (`KANBAN_AUDIT_LOG`, `GET /api/audit`) is the recommended operator step, since `role_binding_mismatch` and `admin_write` land there.

## Consequences

- **Breaking for orchestrators that shared one token** and switched roles per stage on one credential: they must migrate to **per-role credentials** (or per-role tokens swapped per phase). Silent role-switching is impossible either way; a "delegate on behalf of" flow would need an explicit ownership-transfer design and is out of scope.
- Legacy deployments see zero behavior change until they role-bind a credential; the header remains the role source only for unbound credentials and legacy `KANBAN_AUTH_TOKEN`.
- `X-Agent-Role` is no longer security-relevant for bound credentials; browsers keep server-issued session roles. An eventually-global "require bound roles" fail-closed switch was deferred as an easy follow-up.
- Operator migration: issue one credential per role per project, put them in `KANBAN_PROJECT_TOKENS`, restart, and verify via `GET /api/health` `credential_map` bound counts plus the curl matrix (a builder credential gets 403 on the `VALIDATION` hop).
- Related: ADR-001 §2/§4 (caller-declared roles, header-based auth semantics), ADR-004 (the 8-state lifecycle the roles gate).