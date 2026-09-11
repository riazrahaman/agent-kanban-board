# PI-03 Review — round 03 (Tester-fix round)

VERDICT: PASS

Reviewer: reviewer-pi03-glm (glm-5.2, different family from the Codex/gpt builder
and the Tester). Read-only: no code written, no tests run by the Reviewer. This
round re-verifies the Tester's three findings (ISS-PI03-07/08/09) that the Builder
claims to have fixed in `b0094bf9` (report `build-report-fix-02.md`). Each is
judged by re-reading the diff, not by trusting the fix report.

Commit reviewed: `b0094bf99123528873a6fbfc00d9a846c025f476` on `task/PI-03`
(fix) over `3f97fb9` (the round-2 diff). `df4fc7a` is the tester/build-report
recording commit.
Forbidden-file check: `git diff main...df4fc7a -- tests/gates/ AGENT_BUILD_SPEC.md`
is empty. The fix commit touched only `server/middleware/auth.js`,
`server/routes/tasks.js`, `server/store.js`, `server/test/kanban.test.js`. Clean.

---

## Per-issue verdict

### ISS-PI03-07 — duplicate task id overwrites the original — ADDRESSED
`server/store.js:346-348` now short-circuits before validation/persistence:
`if (getTask(data.id)) return { error: 'Task ${id} already exists', status: 409 };`
The original card is preserved because the create never reaches the write. The check
is inside `withMutationLock` (`store.js:334`), so two concurrent duplicate creates
serialize and both observe the first insert — no race re-opens the overwrite.
Test `kanban.test.js:63-74` POSTs the same id twice, asserts `201` then `409`, and
confirms `GET /api/tasks/duplicate` still returns the original title. This is the
exact behavior the Tester's reproduction expected. Verified.

### ISS-PI03-08 — unknown roles can mutate / claim / log — ADDRESSED
`server/middleware/auth.js:8-16` defines an allowlist `VALID_ROLES`
(builder/reviewer/tester/runner/system/human/admin), and `auth.js:58-65` returns
`403` for a missing or unknown role on **any mutating method**, after token
validation (order: 503 no-token → 401 bad token → 403 bad role). The gate is
mutation-only (`auth.js:26-29` early-returns for GET), so the browser's
`GET /api/tasks`, `GET /api/events` SSE stream, and card reads stay open — only
writes are role-gated. Test `kanban.test.js:209-228` proves `X-Agent-Role:
unknown` is refused on create, claim, and log (all `403`) while a no-role create
still `201`s the *other* path — confirming the gate is role-specific, not a
blanket 403. Verified.

### ISS-PI03-09 — git-add failure crashes the HTTP server — ADDRESSED
`server/routes/tasks.js:6-8` adds an `asyncHandler` adapter
(`Promise.resolve(handler(...)).catch(next)`) and every mutating async route uses
it, so a rejected `saveTask` (e.g. a failing `git add`) is forwarded to
`next(err)` instead of becoming an unhandled rejection that kills the process.
`server/server.js:37` has the 4-arg error handler that turns it into a controlled
`500` with a stack-omitted body (A05). Test `kanban.test.js:337-357` makes
`.git/index` a directory so `git add` fails *through the HTTP route*, asserts `500`
with `/Internal Server Error/`, asserts `store.getTask('route-failure') === null`
(no state mutation), and then asserts the server still answers `GET /api/tasks`
(`200`) — proving liveness. This is the precise repro the Tester reported. Verified.

---

## Adversarial re-check (the fix is itself re-examined, not just the findings)

- **Role gate vs. legit callers:** the gate 403s any mutation without a valid
  `X-Agent-Role`. The board's own UI (`kanban-client/src`) performs **no**
  mutations, so it is unaffected. The only mutating callers are the agent
  harnesses, which send a role. The desk repo's kanban updates go through the file
  store locally (`ops/runner.py` `transition_kanban` → `ops/kanban/*.yml`, not
  HTTP POSTs), so the gate does not break the desk either. No regression.
- **New `status`/`round` requirements vs. the desk's own schema:** `createTask`
  now requires a valid `status` and a positive-integer `round`. The desk runner
  independently treats both as required and validated
  (`ops/runner.py:390` missing status → `RunnerRefusal`;
  `ops/runner.py:412-419` missing/non-positive round → `RunnerRefusal`), so the
  board and the desk agree on the schema. No cross-repo mismatch.
- **Duplicate-check race:** the 409 guard is under `withMutationLock`
  (`store.js:334` → `254`), so it is linearized; a concurrent duplicate pair
  cannot both pass the check. Correct.
- **Error handler completeness:** `server.js:37` registers the handler last, after
  all routes, matching Express 4's 4-arg convention; asyncHandler routes every
  async rejection to it. No swallowed-throw paths remain.

---

## Invariant re-walk on the fixed code

- **I3 / append-only:** the git commit-failure and git-route-failure tests confirm
  in-memory state is not mutated on a failed write; transitions still append.
  Holds.
- **KB-02 role ownership:** unknown-role mutation refusal now enforced at the
  transport boundary for all writes, not just status transitions. Holds — this is
  the gap the Tester found, now closed.
- **I5:** unchanged and intact from round 2 — `status`/`round` are required with no
  fallback. The duplicate-create change introduced no new silent default.
- I1/I2/I4/I6/I8: N/A for the board (no LLM, no facts-in-cards, no exec path, no
  universe, no money). I7 (no network in tests) holds — the git-route-failure test
  is a local `git init` + local failing index, no external service.

---

## Note (non-blocking)

The board's HTTP mutators now require `X-Agent-Role`. This is correct for an
agent-driven board, but it means a future human or external tool driving the board
over HTTP must supply a valid role — worth a line in the board's README/deploy
notes, not a code defect. Not a finding.

---

## Findings (file:line — what — why), all resolved

1. `server/store.js:346-348` — duplicate id now returns `409` and preserves the
   original (under the mutation lock). ADDRESSED.
2. `server/middleware/auth.js:58-65` — missing/unknown role returns `403` on every
   mutating route, mutation-only so reads/SSE/UI stay open. ADDRESSED.
3. `server/routes/tasks.js:6-8` + `server/server.js:37` — async route rejections
   route to a controlled `500`; the server stays alive. ADDRESSED.

---

## Verdict rationale

All three Tester findings are genuinely resolved in the code itself, each confirmed
by re-reading the diff and the new tests (which assert the exact status the Tester
expected, not just that the suite is green). I did not trust the fix report's
claims — the role gate, duplicate guard, and async handler were checked for the
regressions they could introduce (legit caller lockout, race re-open, broken
reads), and none fired. No invariant is violated; the forbidden-file check is
clean. The Tester's issues are all `REVIEWED`. PASS.

VERDICT: PASS
