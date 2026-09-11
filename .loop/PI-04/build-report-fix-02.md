# PI-04 Builder Fix Report — Round 2

## ISS-PI04-03 — FIXED

Commit `15dd13725580677b3beed9a922baac43dd0b9d57` addresses the Tester’s finding in `client/src/components/Board.tsx`.

The local permissive `normalizeStatus` function was removed. `client/src/status.js` is now the single status
normalizer: canonical loop statuses and legacy `TODO`/`IN_PROGRESS` aliases are retained, while any other value
including null, undefined, blank, and garbage strings becomes `UNKNOWN`.

Board grouping now lives in `client/src/board-model.js`, which calls that shared normalizer. `Board.tsx` renders a
dedicated `Unknown` column alongside the existing loop columns. This is the clearest fit for the current kanban UI:
the malformed record remains in the board’s status model, is visibly labelled by `StatusBadge`, and does not get
mixed into the Issues swimlane, which already has a separate meaning for registered issues.

`SignalRail.tsx` was migrated to the same helper as part of the fix, eliminating the remaining independent status
normalizer and keeping rollup counts consistent with the board.

## Regression coverage

`scripts/test-client-status.js` now exercises the real `groupTasks` path with a task whose status is
`not-a-loop-state`, and asserts its id appears in the `UNKNOWN` group. It also verifies null/undefined handling and
the shared style mappings. The client build type-checks the Board integration.

The issue register is set to `FIXED` only. Reviewer and Tester-owned states remain untouched.

