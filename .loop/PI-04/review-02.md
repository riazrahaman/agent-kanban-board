# PI-04 Review — Round 2 (reviewer-findings fix)

- Task: PI-04
- Repo: agent-based-investment-kanban-board
- Branch: task/PI-04
- Range reviewed: `8fdff25..b957039` (fix commit `b957039` `fix(PI-04): share safe status styling for task cards`; bookkeeping `fa5514d`)
- Reviewer: reviewer-pi04-glm (model glm-5.2)
- spec_version: 3.10 (sha 7479a3714ea78296794bc8aa615f8d56a39ac89b)

## VERDICT: PASS

Both round-1 findings are fixed, verified by reading the diff (not by trusting "tests pass"). No regressions. This was a Reviewer-findings fix round, so a single overall verdict line, not per-issue.

## ISS-PI04-01 — ADDRESSED

New shared helper `client/src/status.js`:
- `normalizeStatus(status)` — `if (typeof status !== 'string' || !status.trim()) return 'UNKNOWN'`; otherwise `status.toUpperCase()`. Guards null, undefined, blank, and non-string input to `'UNKNOWN'` (status.js:11-14).
- `statusStyle(status)` — derives `{ normalized, stripe, badge }` from the single `STATUS_STYLES` map, falling back to `UNKNOWN` for unmapped values (status.js:16-21).
- `TaskCard` now calls `const stripe = statusStyle(task.status).stripe` (TaskCard.tsx:11) and the old unguarded `task.status.toUpperCase()` ternary is deleted. Grep confirms **no `.toUpperCase()` remains in TaskCard** — the crash path is gone.
- Regression test `scripts/test-client-status.js` (wired into `npm test`, package.json) exercises the real edge cases: `normalizeStatus(null)`, `normalizeStatus(undefined)`, `normalizeStatus('not-a-loop-state')`, and `statusStyle(null)` full deep-equal to the UNKNOWN style. This is a genuine edge-case test, not a happy-path assertion.

## ISS-PI04-02 — ADDRESSED

Single source of truth established:
- `STATUS_STYLES` lives only in `client/src/status.js` (status.js:1-9).
- `StatusBadge` deleted its own `STATUS_STYLES` map and now derives both stripe and badge from `statusStyle(status)` (StatusBadge.tsx:2,7 → `style.stripe`, `style.badge`).
- `TaskCard` derives its outer stripe from the same `statusStyle(task.status).stripe` (TaskCard.tsx:11).
- The duplicated TaskCard ternary and the separate StatusBadge map are both removed, so a future status added to `status.js` cannot drift between the card stripe and the badge.

## Non-blocking observation (does not block, not a new issue)

`client/src/components/SignalRail.tsx:28-51` has its own `normalizedStatus` that defaults to `'BACKLOG'` (maps `IN_PROGRESS→BUILDING`, `TODO→BACKLOG`) and is used only for `.filter()` rollup counts (active/blocked/doneToday), not for styling. It is null-safe (uses `status?.toUpperCase() ?? ...`), so it does not reintroduce the ISS-PI04-01 crash, and because it is count-only rather than a styling source it does not reintroduce the ISS-PI04-02 drift. It is out of scope for the two findings (which were about the card render crash and the card/badge style duplication). Noted for the Tester/Builder to optionally consolidate later.

## Acceptance-in-spirit / invariants

- I5 (loud null, fail loud but recoverable): now satisfied on the path that previously broke it — a missing/non-string/blank status renders an explicit `UNKNOWN` badge + neutral stripe instead of throwing and taking down the board.
- No forbidden-file touches: `git diff main..b957039 -- tests/gates/ AGENT_BUILD_SPEC.md` is clean.
- No dependency or spec change; only `status.js`/`.d.ts`, the two components, `package.json` (test wiring), and the new test script.
