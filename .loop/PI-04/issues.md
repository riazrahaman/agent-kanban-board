ID        opened_round  severity  status  fixed_in  reviewed_in  verified_in
ISS-PI04-01  round 1       major     REVIEWED  b957039  b957039     —
ISS-PI04-02  round 1       minor     REVIEWED  b957039  b957039     —
ISS-PI04-03  T1            major     REVIEWED  15dd137  15dd137      —

# ISS-PI04-01 (major, review)
TaskCard.tsx:14-18 KB-11 refactor dropped the null-guard on task.status. task.status.toUpperCase() now throws on a
null/undefined status. TaskStatus types.ts is a strict union (no null), but the json/git store can return a card
without a status and StatusBadge explicitly guards UNKNOWN — so this is an in-system inconsistency. A single
missing-status card unmounts the whole board (one ErrorBoundary, App.tsx:95) into a Rendering-Error box: silent,
board-wide blank. Contradicts I5 fail-loud-but-recoverable.
FIX b957039: shared client/src/status.js normalizeStatus guards non-string/blank to 'UNKNOWN'; TaskCard uses
statusStyle(task.status).stripe, unguarded .toUpperCase() removed (grep-clean). scripts/test-client-status.js
exercises null/undefined/unknown. REVIEWED b957039.

# ISS-PI04-02 (minor, review)
TaskCard.tsx:14-18 stripe cascade duplicated StatusBadge STATUS_STYLES and had drifted. Two sources of truth for
status-in-form.
FIX b957039: STATUS_STYLES now lives only in status.js; StatusBadge and TaskCard both derive from statusStyle(),
duplicated ternary and separate badge map removed. REVIEWED b957039.

# ISS-PI04-03 (major, T1)
Garbage status values are not normalized to UNKNOWN and are silently omitted from the visible board. Reproduction:
`node --input-type=module` probe injected null, empty-string, and `not-a-loop-state` records directly into a JSON
store, then called the real client helper and reproduced Board grouping. Observed: null-status -> UNKNOWN and was
visible; empty-status -> UNKNOWN and was grouped into BACKLOG; garbage-status -> `statusStyle().normalized` was
`NOT-A-LOOP-STATE` and Board visible card IDs contained only `null-status`. Expected: all three malformed records
remain on the board and render an explicit UNKNOWN badge/neutral style without taking down the board. Evidence:
`normalizeStatus` returns `status.toUpperCase()` for nonblank garbage (`client/src/status.js:11-14`), while
`Board.tsx:37-55` creates an unrendered ad-hoc group for unknown keys and renders only the declared columns.
FIX 15dd137: status normalization now canonicalizes unrecognized values to UNKNOWN; Board groups through the shared
board model and renders a persistent Unknown column. REVIEWED/VERIFIED/CLOSED remain owned by later roles.
