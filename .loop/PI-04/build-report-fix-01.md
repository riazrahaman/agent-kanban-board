# PI-04 Builder Fix Report — Round 1

## Commit

`b95703918a9037b149b71fc29cca0e519ed61139` — `fix(PI-04): share safe status styling for task cards`

## ISS-PI04-01 — FIXED

`client/src/components/TaskCard.tsx` no longer calls `task.status.toUpperCase()` directly. It passes the runtime value through `statusStyle`, whose shared `normalizeStatus` accepts `unknown` and returns `UNKNOWN` for null, undefined, blank, or otherwise absent input. The card therefore renders its neutral stripe and the `StatusBadge` renders explicit `UNKNOWN` text instead of throwing. This prevents one malformed card from taking down the board render.

The regression test in `scripts/test-client-status.js` directly exercises null, undefined, and unknown values. The client build also type-checks the component integration.

## ISS-PI04-02 — FIXED

`client/src/status.js` now owns the single status normalization and style mapping. `TaskCard` derives its outer stripe from `statusStyle(task.status)`, while `StatusBadge` derives its normalized label, stripe, and badge colors from the same helper. The duplicated TaskCard ternary and the separate StatusBadge map are removed, so BUILDING/IN_TEST and future status additions cannot drift between the card row and status badge.

The direct helper regression test asserts the shared mappings for malformed status, BUILDING/IN_TEST, and IN_REVIEW.

## Verification

`npm test` passes: the existing 16 server tests, the new client status helper test, and the client TypeScript/Vite build all pass. `git diff --check` passes.

Only the two Reviewer issues were addressed. The issue register is updated to `FIXED`; it is intentionally not advanced to `REVIEWED`, `VERIFIED`, or `CLOSED`.

