# ADR-006 — Per-Deployment Toggle for the `role_crossing` Audit Signal

**Task:** Optional kill switch for the multi-role audit signal  
**Status:** accepted (implemented v3.9.0 — the signal ships **off by default**)  
**Date:** 2026-10-20

## Context

The `role_crossing` audit signal (planned with the v3.9.0 severity-rule work)
fires when one `agent_id` presents **bound credentials for more than one role**
on a project. Its meaning is deliberately narrow: the server can prove that an
agent *held* several role-bound credentials; it cannot prove intent. A
crossing is a **review prompt, not a violation** — an orchestrator working
under an admin credential, a CI runner, or an agent that legitimately does
planner+builder work all produce crossings that are perfectly fine.

The signal ships **always-on**, consistent with `role_binding_mismatch`
(ADR-005 §2.4), which has no configuration knob either. `role_binding_mismatch`
is *rare by construction* — it needs a header that conflicts with the bound
role. `role_crossing` is not: a deployment whose agents hold several role-bound
credentials on purpose will emit an event on each such mutation.

## Decision

**The signal ships OFF by default, behind a per-deployment kill switch.** The
switch uses the same flag shape as `KANBAN_AUDIT_LOG` (`server/auditLog.js:23`
— `off` / `0` / `false` disable, anything else enables):

```
KANBAN_ROLE_CROSSING_AUDIT=off
```

A deployment opts in by setting the flag to anything truthy. The default is
therefore the *quieter* behaviour: a deployment whose agents legitimately hold
several role-bound credentials emits nothing until an operator asks for the
signal.

| | Behaviour | Cost |
| :-- | :-- | :-- |
| **A — no knob** | Signal always on; operators filter by `actor`. | None. |
| **B — `KANBAN_ROLE_CROSSING_AUDIT`** ✅ **chosen** | Per-deployment opt-in, **off by default**. | A config description in `scripts/gen-config-reference.mjs` + regenerated `docs/CONFIGURATION.md`, a `.env.example` row, and tests. |

**Why B over A:** the operator's choice is kept, but the *default* is the
conservative one. `role_binding_mismatch` is rare by construction (it needs a
header that conflicts with the bound role); `role_crossing` is not. A
deployment that never asked for the signal should not get it by default, and
the client-side severity marks — which do the same job visually, read-side,
with no server involvement — keep working regardless.

## Implementation (v3.9.0)

- `server/utils/roleCrossing.js` — `roleCrossingAuditEnabled()` (flag shape
  above, default off) and `noteRolePresentation(project, agentId, role)`,
  which records the bound roles an agent has presented per project in a
  process-local map and reports a **crossing** when the same agent presents a
  *different* bound role on the same project.
- `server/middleware/auth.js` — the bound-credential branch calls
  `noteRolePresentation()` and, on a crossing, `emitRoleCrossing()`: one
  redacted console line and one `role_crossing` audit entry
  (`{kind, project, task: null, actor, reason}`). It is **never** an auth
  failure, so it never touches the failed-auth rate limiter, and it never
  blocks the request.
- The admin-token path and legacy unbound credentials are **not tracked**:
  the admin token is privileged by design, and an unbound credential has no
  bound role to speak of.
- Tests: `server/test/kanban.rolecrossing.test.js` (12 cases — flag shape,
  default-off, same-role repeat, different agents, legacy credential, admin
  path, per-project scoping, and token redaction).

## Scope when picked

One env read in the mutation path, one config description in the generator
script, one test, and a `docs/CONFIGURATION.md` regeneration. **No schema
change**: the event shape stays `{kind: 'role_crossing', project, task, actor,
reason}`, and the audit log is only written when `KANBAN_AUDIT_LOG` is enabled
— the toggle governs *emission*, not the log file.

## Consequences

- The signal's value is its prompt, not its alarm: a human decides whether a
  crossing was legitimate. Because it is opt-in, a deployment that has not
  enabled it keeps the previous behaviour exactly — which is why the default
  is off rather than on.
- Nothing about the **client-side severity rule** depends on this signal: the
  dots are derived read-side from `stage_owners` and re-color regardless of
  whether the audit signal is enabled.

## Related

- ADR-005 (credential-bound roles) — the signal is the server-side counterpart
  of the client-side solo-run severity marks; both key on identity, not token.
- ADR-001 §2 (KB-02) — the caller-declared role rules this work supersedes.
