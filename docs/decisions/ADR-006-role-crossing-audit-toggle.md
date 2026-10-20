# ADR-006 — Per-Deployment Toggle for the `role_crossing` Audit Signal

**Task:** Optional kill switch for the multi-role audit signal  
**Status:** proposed (deferred — not implemented)  
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

## Decision (deferred)

No toggle in the first release of the signal. If a deployment needs to
suppress the noise, add a per-deployment kill switch with the same flag shape
as `KANBAN_AUDIT_LOG` (`server/auditLog.js:23` — `off` / `0` / `false` disable,
anything else enables):

```
KANBAN_ROLE_CROSSING_AUDIT=off
```

| | Behaviour | Cost |
| :-- | :-- | :-- |
| **A — no knob (planned default)** | Signal always on; operators filter by `actor`. | None. |
| **B — `KANBAN_ROLE_CROSSING_AUDIT=off`** | Per-deployment suppression. | New config surface: a description in `scripts/gen-config-reference.mjs` + regenerated `docs/CONFIGURATION.md`, a docs row, a test, and boot/health reporting in the `credential_map` style. |

**Trigger to revisit.** A deployment reports audit noise it cannot filter —
e.g. an orchestrator holding several role-bound credentials produces a crossing
on every mutation — or an operator wants the signal suppressed outside
production without a code change.

## Scope when picked

One env read in the mutation path, one config description in the generator
script, one test, and a `docs/CONFIGURATION.md` regeneration. **No schema
change**: the event shape stays `{kind: 'role_crossing', project, task, actor,
reason}`, and the audit log is only written when `KANBAN_AUDIT_LOG` is enabled
— the toggle governs *emission*, not the log file.

## Consequences

- The signal's value is its prompt, not its alarm: a human decides whether a
  crossing was legitimate. Suppressing it removes that prompt for a whole
  deployment, which is why it is a deliberate, per-deployment decision rather
  than a default.
- Nothing about the **client-side severity rule** depends on this signal: the
  dots are derived read-side from `stage_owners` and re-color regardless of
  whether the audit signal is enabled.

## Related

- ADR-005 (credential-bound roles) — the signal is the server-side counterpart
  of the client-side solo-run severity marks; both key on identity, not token.
- ADR-001 §2 (KB-02) — the caller-declared role rules this work supersedes.
