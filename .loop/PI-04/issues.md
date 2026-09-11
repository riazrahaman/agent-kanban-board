ID        opened_round  severity  status  fixed_in  reviewed_in  verified_in
ISS-PI04-01  round 1       major     FIXED   b957039  —            —
ISS-PI04-02  round 1       minor     FIXED   b957039  —            —

# ISS-PI04-01 (major, review)
TaskCard.tsx:14-18 KB-11 refactor dropped the null-guard on task.status. task.status.toUpperCase() now throws on a
null/undefined status. TaskStatus types.ts is a strict union (no null), but the json/git store can return a card
without a status and StatusBadge explicitly guards UNKNOWN — so this is an in-system inconsistency. A single
missing-status card unmounts the whole board (one ErrorBoundary, App.tsx:95) into a Rendering-Error box: silent,
board-wide blank. Contradicts I5 fail-loud-but-recoverable. Fix: guard as StatusBadge does (status?.toUpperCase()
?? 'UNKNOWN') or fold the stripe into StatusBadge.

# ISS-PI04-02 (minor, review)
TaskCard.tsx:14-18 stripe cascade duplicates StatusBadge STATUS_STYLES and has already drifted. Card stripe is a
second source of truth for status-in-form; a status added to StatusBadge will be unstyled on the card. Fix: derive
the stripe from one shared helper so card / sheet / badge cannot drift.
