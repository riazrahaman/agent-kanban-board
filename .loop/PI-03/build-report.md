# PI-03 Builder report

## What I independently checked

I read the immutable `AGENT_BUILD_SPEC.md` (version 3.10) before editing and
started from `main` on branch `task/PI-03`. The inherited implementation already
had the basic JSON store, temp-file rename helper, canonical status constants,
claim conflict check, issue arrays/endpoints, YAML card serialization, and a
Git commit path. Its existing test file did not adequately prove the task:
mutations were unprotected when no token was configured, missing roles became
`human`, concurrent claims were not serialized, Git commit errors were swallowed,
and the default backend did not select the desk's Git store. The UI also had no
issues swimlane.

## Changes made

- Made `KANBAN_AUTH_TOKEN` mandatory for every mutating HTTP method. Missing
  configuration fails closed with `503`; invalid credentials remain `401`.
  Removed the `API_TOKEN` fallback.
- Removed implicit `human` role elevation. Status changes require an explicit
  role; Builder, Reviewer, Tester, and runner/system/admin ownership is enforced
  against the state machine.
- Allowed `BLOCKED` from `BACKLOG` as well as all other non-terminal states.
- Serialized all store mutations so concurrent claims cannot both win. Memory
  and SSE state are updated only after persistence succeeds.
- Made Git-backed commit failures visible instead of silently treating them as
  success, selected Git YAML storage by default for this desk, and documented
  the explicit JSON standalone mode.
- Added an `ISSUES` client lane containing every task with registered issues.
- Rewrote `server/test/kanban.test.js` around adversarial acceptance probes for
  KB-01..05/08/09, including a simulated persistence failure and concurrent
  claims. No network or external service is used by the tests.
- Updated the existing ADR and README to match the implemented contract.

## Invariants

- I1: not applicable; this board has no investment decision path or LLM output.
- I2: not applicable; board cards are workflow records, not market facts.
- I3: relevant to loop evidence and Git history. I did not rewrite existing
  audit/message records; Git transitions append commits, and this report is new.
- I4: not applicable; there is no backtest/live execution path.
- I5: relevant. Missing authentication and missing roles are refused rather than
  assigned defaults. The context percentage below is a self-estimate because
  this manual session has no external usage meter; it is not a fabricated
  application value. Ordinary card-schema conveniences (for example a new
  card's BACKLOG status) are workflow defaults, not market data.
- I6: not applicable; no instrument universe exists here.
- I7: relevant. Tests use ephemeral local HTTP servers, temporary directories,
  and a temporary local Git repository only; they do not call the network.
- I8: not applicable; the board performs no money arithmetic.

## Deliberately not done

I did not implement PI-04's KB-06/07/10/11/12 work, redesign the inherited API,
change `AGENT_BUILD_SPEC.md`, touch `tests/gates/`, merge or push the branch, or
pretend that a shared token uniquely identifies an individual agent. The latter
is the explicit shared-token contract; `agent_id` remains the caller-supplied
workflow label after token authentication.

## Uncertainty and verification notes

The default Git path is intentionally desk-specific (`../../agent-based-investment/ops/kanban`)
when no `KANBAN_GIT_DIR` is supplied; a stranger clone should select the JSON
backend explicitly or configure its own Git directory. The implementation
commit is `ae9a105552567b5c3859e055d7dcb4b7433007af`; this report was
committed in `16df26b77f40544593c89300ec94cc07987056db`.

Validation personally run: `npm test` (7 passing suites), `npm run build`,
`node --check` on the changed server modules, and `git diff --check`.

Context percentage: 38% is my genuine self-estimate for this manual session,
not an externally verified runner measurement.
