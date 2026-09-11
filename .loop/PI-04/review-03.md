# PI-04 Reviewer Report — Round 3

- Task: PI-04
- Commit reviewed: `15dd13725580677b3beed9a922baac43dd0b9d57` (fix) + `59b143c` (bookkeeping)
- Role: Reviewer
- Model: `glm-5.2`
- Spec: 3.10, sha `7479a3714ea78296794bc8aa615f8d56a39ac89b`
- Scope: `ISS-PI04-03` (Tester T1 finding, round T1)

## Verdict

VERDICT: PASS

`ISS-PI04-03` is ADDRESSED. Verified by reading the `15dd137` diff and the current
source — not by trusting the build report or by running the test suite (per §1.2 the
reviewer does not run tests and does not approve on "tests pass").

## Finding under review

ISS-PI04-03 (major): a garbage/unknown `status` value was normalized to
`NOT-A-LOOP-STATE` (a string `Board.tsx` did not render), so the malformed card was
grouped under an unrendered key and silently dropped from the visible board,
contradicting I5 (fail-loud-but-recoverable). Null/empty already rendered UNKNOWN,
so the board did not crash — only unknown strings were dropped.

## Verification (5 required checks, all PASS)

1. `status.js` `normalizeStatus` now canonicalizes *any* unrecognized value.
   `KNOWN_STATUSES` (status.js:11) is derived from the style map excluding UNKNOWN;
   the tail returns `KNOWN_STATUSES.has(normalized) ? normalized : 'UNKNOWN'`
   (status.js:18). Garbage strings, not just null/blank, now map to UNKNOWN.
   Legacy aliases `TODO->BACKLOG`, `IN_PROGRESS->BUILDING` retained (status.js:16-17).
2. `Board.tsx` no longer owns a local normalizer — its `normalizeStatus` was deleted
   in `15dd137`; grouping now delegates to `groupTasks` (Board.tsx:2,22), whose
   `grouped[normalized]` push (board-model.js:16-17) uses the shared
   `normalizeStatus` (board-model.js:1). Single source of truth.
3. A real rendered UNKNOWN column exists: `Board.tsx:12` adds
   `{status:'UNKNOWN', title:'Unknown'}` to `COLUMNS`, and `groupTasks`
   pre-populates `UNKNOWN` (board-model.js:11), so a malformed card lands in
   `grouped.UNKNOWN` and is rendered rather than dropped. The column is visible.
4. `SignalRail.tsx` now uses the shared `normalizeStatus` — its local
   `normalizedStatus` was deleted; it imports `normalizeStatus` (SignalRail.tsx:3)
   for all three rollups (active/blocked/doneToday at :46,51,58). The third
   independent normalizer is gone.
5. A genuine regression test proves appearance in grouped output, not just a
   string: `scripts/test-client-status.js:18-21` runs the real `groupTasks` on a
   task with `status: 'not-a-loop-state'` and asserts
   `grouped.UNKNOWN.map(t => t.id)` deep-equals `['garbage-status']`; line 9 flipped
   the expectation from `'NOT-A-LOOP-STATE'` to `'UNKNOWN'`. Wired into `npm test`
   (package.json). This is the real grouped/render path, not a bare helper assertion.

## Adversarial regression check

- No re-introduced silent drop: UNKNOWN is in `COLUMNS`, so the test's UNKNOWN group
  is rendered.
- `SignalRail` counts are unchanged for canonical states: garbage never matched
  BUILDING/BLOCKED/DONE before or after; alias behavior is identical to the prior
  local function for known states.
- `types.ts` gained `'UNKNOWN'` so `COLUMNS` type-checks; `board-model.d.ts`
  type-declares `groupTasks`.

## Invariants

- I5 hold: malformed statuses now surface as a visible UNKNOWN column instead of
  vanishing — fail-loud-but-recoverable.
- I3 append-only: unaffected (issue register only appended).
- I7 no-network: unaffected (client status logic).
- I1/I2/I4/I6/I8 N/A (no LLM, cards are workflow, no exec path, no universe, no money).

## Forbidden-file check

`git diff main..15dd137` touches only `.loop/PI-04/*`, `client/src/*`,
`server/*`, `package*.json`, `README.md`. No `tests/gates/`, no
`AGENT_BUILD_SPEC.md` (neither path exists in the board repo). CLEAN.

## Result

ISS-PI04-03 → REVIEWED (fixed_in `15dd137`, reviewed_in `15dd137`;
VERIFIED/CLOSED remain Tester-owned). No open findings, no escalation.
Kanban → IN_TEST, round 7.
