# PI-03 Review — round 02 (fix round)

VERDICT: PASS

Reviewer: reviewer-pi03-glm (glm-5.2, different family from the Codex/gpt builder).
Commit reviewed: `3f97fb9` (fix) over `1f2ee9a` (the round-1 diff).
Forbidden-file check: `git diff main...task/PI-03 -- tests/gates/ AGENT_BUILD_SPEC.md` is
empty; the fix commit touched only `.loop/`, `docs/decisions/ADR-002|003`,
`server/store.js`, `server/test/kanban.test.js`. Clean.

This is a fix round, so each original finding is rendered per-issue; the commit passes
only because every one is ADDRESSED, verified by re-reading the code (not the report).

---

## Per-finding verdict

**ISS-PI03-01 (PATCH claim bypass, `store.js:429`) — ADDRESSED.**
`assigned_agent` is removed from `patchTask`'s `allowed` list (`server/store.js:429-437`);
ownership now changes only through the guarded `claimTask` path (`store.js:475-483`).
The new test (`kanban.test.js:186-191`) PATCHes `{assigned_agent:"thief"}` and asserts
`200` with `assigned_agent` still `winner` — proving the field is ignored on PATCH, not
that a steal succeeded. Verified by read.

**ISS-PI03-02 (commit-failure untested) — ADDRESSED.**
The new test `kanban.test.js:277-300` installs a **real** git pre-commit hook
(`#!/bin/sh\nexit 1`) and forces an actual failing `git commit` via `GitYamlStorage` /
`createTask`, then asserts: (a) the store throws `/Git-backed persistence commit failed/`,
(b) `store.getTask('commit-failure')` is `null` (no in-memory mutation — the KB-05
invariant), and (c) `git log -1` itself rejects (nothing actually committed). This is a
real commit failure, not a mock. Verified by read.
Cosmic nit (non-blocking): the test's first `assert.rejects` (the `bad-round` case,
`kanban.test.js:282`) actually exercises the new round guard, not a commit failure, so it
is misfiled under the commit-failure test title. The substantive commit-failure assertions
are present and correct, so the finding is addressed; the mislabel is test hygiene only.

**ISS-PI03-03 (I5: silent `status` default, `store.js:354`) — ADDRESSED.**
`createTask` now does `const status = normalizeStatus(data.status); if (!status) return 400`
with `status` written directly into the task (no `|| existing?.status || BACKLOG`). A blank
`' '` normalizes to `null` → `400`. `kanban.test.js:60-74` covers missing and blank. Verified.

**ISS-PI03-04 (I5: fabricated `round`, `store.js:207`) — ADDRESSED.**
`createTask` now rejects a missing/non-positive `round` with `400`
(`store.js:349-351`), writes `round: data.round` with no `?? 1`, and
`GitYamlStorage.saveTask` throws on a non-positive round (`store.js:193`). `kanban.test.js:72`
covers the missing-round refusal. I5-correct: the value is refused, not fabricated. Verified.

**ISS-PI03-05 (git torn-write window) — ADDRESSED (documented).**
`docs/decisions/ADR-002-git-commit-failure-and-recovery.md` honestly documents the exact
two-phase window I flagged (crash after card rename, before `git commit` → an uncommitted,
recoverable-but-uncommitted card; the next commit folds it in), states the recovery
procedure, and records why a cross-store transaction is out of PI-03 scope. This is the
documented-without-closing route, which the findings explicitly allowed. Verified substantive.

**ISS-PI03-06 (missing ADRs) — ADDRESSED.**
`ADR-002` (commit-failure behaviour + recovery) and
`ADR-003-process-local-mutation-serialization.md` (the `withMutationLock` queue, its
rejected-op-fails-open behaviour, and its single-process boundary) both carry context /
choice / consequence rather than one-line stubs. Verified substantive.

Also added: the two minor tests flagged in round 1 — duplicate issue id
(`kanban.test.js:239-241`) and a malformed-but-present role → 403
(`kanban.test.js:242-244`).

---

## Re-walk of invariants on the fixed code

- **I5 (no fabricated values):** now holds at the creation boundary — a card must supply a
  valid `status` and a positive-integer `round`, both refused rather than defaulted. This is
  the central I5 fix and it is real. Note the tradeoff: `createTask` now requires `round`
  and `status` on every create, which tightens the "stranger clone runs standalone with no
  configuration" expectation (KB-12, PI-04) — but that is I5-correct and out of PI-03
  scope, and the build report flags it.
- **I3 / append-only:** git transitions still append commits; the failing-storage and
  commit-failure tests confirm in-memory state is not mutated on a failed write. Holds.
- **I7 (no network in tests):** the new commit-failure test uses a local `git init` + a
  local hook; no external service. Holds.
- I1/I2/I4/I6/I8: N/A for the board (reasons unchanged from review-01).

---

## New-code adversarial re-check (not a regression, but noted)

- **Creation-time `assigned_agent` is still accepted** (`store.js:371-373`). This is *not*
  a KB-03 regression: at create time there is no holder to steal from, and `createTask` is
  behind the token gate. A token-holder can seed an agent at creation but cannot hijack an
  existing claim via PATCH (finding 1's actual gap, now closed). Noted, not a blocker.
- **Create is upsert semantics:** a second `createTask` for an existing id overwrites via
  `tasks.map`. Pre-existing behaviour, serialized by the mutation lock, and not introduced
  by this fix — out of scope for the fix round. Noted only.

---

## Findings (file:line — what — why), all resolved

1. `server/store.js:429` — `assigned_agent` removed from the PATCH allowlist; ownership via
   `claimTask` only. ADDRESSED.
2. `server/test/kanban.test.js:277-300` — real git commit-failure test (failing hook),
   asserts throw + no state mutation + no landed commit. ADDRESSED.
3. `server/store.js:346-351` — missing/blank `status` → 400, no BACKLOG fallback. ADDRESSED.
4. `server/store.js:193` + `store.js:349-351` — `round` required as a positive integer; no
   fabricated `1`. ADDRESSED.
5. `docs/decisions/ADR-002-…md` — torn-write window documented, not hidden. ADDRESSED.
6. `docs/decisions/ADR-002`, `ADR-003` — both substantive (context/choice/consequence).
   ADDRESSED.

---

## Verdict rationale

All six round-1 findings are genuinely resolved in the code itself, each confirmed by
re-reading the diff rather than trusting the fix report. The two I5 loud nulls are now
hard refusals, the KB-03 PATCH bypass is closed and tested, the commit-failure path is
proven with a real failing hook (not a mock), and the two non-obvious decisions carry
substantive ADRs. The remaining notes (test-title hygiene at `kanban.test.js:282`; the
create-time `assigned_agent` upsert; the new create-time `round`/`status` requirement) are
non-blocking observations, not gaps, and none regresses a prior finding. No invariant is
violated; the forbidden-file check is clean. This passes and goes to the Tester — the
Reviewer is the only door to it, and the door is open.

VERDICT: PASS
