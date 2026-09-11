# PI-04 Review — Round 1

- Task: PI-04
- Repo: agent-based-investment-kanban-board
- Branch: task/PI-04
- Base: main
- Range reviewed: `git diff main...task/PI-04` (commits `cc23bd8`, `8219055`, `8fdff25`)
- Reviewer: reviewer-pi04-glm (model glm-5.2, family distinct from the Codex/gpt builder and the tester — satisfies §1.2 role separation)
- spec_version: 3.10 (sha 7479a3714ea78296794bc8aa615f8d56a39ac89b)

## VERDICT: CHANGES_REQUESTED

Two findings, both fixable, neither an escalation (no spec conflict, no dependency change, no forbidden-file touch). Everything else in KB-06/07/10/11/12 is correct and the security acceptance tests exercise real attacks, not config existence.

## Findings

1. `client/src/components/TaskCard.tsx:14-18` — the KB-11 refactor removed the null-guard on `task.status`.
   What: the old `getStatusStyle` did `status?.toUpperCase() ?? 'BACKLOG'`; the new inline ternary calls
   `task.status.toUpperCase()` directly, four times, so a null/undefined status throws `TypeError` at render.
   Why: `TaskStatus` in `types.ts` is a strict union (no null/undefined), but the store/JSON backend can return a
   card without a status and the new `StatusBadge` explicitly guards for `UNKNOWN` — so this is an in-system
   inconsistency, not a theoretical one. The whole board is wrapped in a single `ErrorBoundary`
   (`App.tsx:95`, `columns` render is inside it at `App.tsx:99-102`), so one bad card unmounts every column into a
   "Rendering Error" box — a silent, board-wide blank. The boundary makes it non-fatal but it still hides all
   cards from one missing-status card, and it directly contradicts the I5 intent of "fail loud but recoverable";
   this is fail-loud-but-destructive. Fix: guard the same way `StatusBadge` does (`status?.toUpperCase() ??
   'UNKNOWN'` or fold the stripe into `StatusBadge`), so an unmapped status renders a visible UNKNOWN card instead
   of taking the board down.

2. `client/src/components/TaskCard.tsx:14-18` — the stripe logic is duplicated and already drifted from
   `StatusBadge`. What: `TaskCard` hard-codes its own `border-l-*` cascade while `StatusBadge` owns the canonical
   `STATUS_STYLES` map (`StatusBadge.tsx:5-13`). Why: the two now disagree for the `BUILDING`/`IN_TEST`/`IN_REVIEW`
   rows (e.g. `IN_REVIEW` → warn-stripe in both, but the badge pill uses `bg-warn-bg text-warn` while the card
   stripe is a separate constant), and any future status added to `StatusBadge` will silently be unstyled on the
   card's stripe. This is the KB-11 "status-in-form" goal half-met: form is in the badge, but the card's own stripe
   is a second source of truth. Fix: derive the stripe from one shared source (pass status through `StatusBadge` /
   a shared `statusStyle(status)` helper) so card + sheet + badge cannot drift.

## What is correct (verified by reading the diff, not by trusting "tests pass")

- KB-06 (CORS): `server/middleware/cors.js` is now fail-closed. Empty or `*` throws at startup; a missing
  `KANBAN_ALLOWED_ORIGIN` falls back to exactly `http://localhost:5173`, never to a permissive list — the old
  6-entry loopback allowlist is deleted. No origin → no ACAO header (`origin === allowedOrigin` exact match).
  This directly satisfies the I5 concern: missing/empty config does NOT silently fall back to permissive; it either
  throws (empty/`*`) or lands on the single safe local default.
- KB-07 (stored XSS): `server/store.js` escapes agent log text; `TaskSheet.tsx` renders `{log.message}` as JSX
  text and the new test posts the real payload `<script>alert("owned")</script><img src=x onerror=alert(1)>`
  and asserts it is stored escaped and that no `dangerouslySetInnerHTML` exists. This is a genuine attack
  simulation, not a config assertion — good.
- KB-10 (no drag): no `sortablejs` in either package.json or lockfile; no `onDrag/onDrop/draggable` in any
  component source; the test asserts all of these. No new human card-move UI was added.
- KB-11 (design): `index.css` tokens match the DESIGN.md contract (`--bg:#fbfbfa`, `--ink 16.7:1`,
  `--block` grey, `--live` blue, no Inter/Roboto, system font stacks). `tabular-nums` used on ids/counts/timestamps;
  status rendered as a text `StatusBadge` + semantic left stripe (form, not only color); the user emoji was removed
  (no `👤` residual); square corners (no `rounded-full`/`shadow-`); the live dot lost `rounded-full`.
- KB-12 (public hygiene): README quickstart now defaults the JSON backend to no-config (git backend explicit),
  client default API URL corrected 4100→4000 to match the documented server; MIT LICENSE, both committed
  lockfiles (`client/`, `server/`), and `.github/workflows/ci.yml` all present; CI runs `make sec`, server tests,
  and the client build. No personal absolute paths observed. `store.js` default backend flipped git→json so a
  fresh clone boots with zero config.
- §1.2 forbidden-file check: `git diff main...task/PI-04 -- tests/gates/ AGENT_BUILD_SPEC.md` is clean (those
  paths do not exist in this repo).

## Invariants walkthrough

- I1 N/A — board carries workflow records only; no LLM output or decision values introduced.
- I2 N/A — no point-in-time facts; cards are workflow, not corrections.
- I3 holds — append-only audit/store behavior was not weakened; only the default backend flipped to json.
- I4 N/A — no execution path in the board.
- I5 relevant & mostly satisfied — CORS refuses empty/`*` (throws) and falls back only to the single safe local
  origin; missing status now surfaces as `UNKNOWN` in `StatusBadge` (good), EXCEPT the `TaskCard` regression in
  finding #1 silently drops the guard. Loud-null is honored in the badge/badge-path, broken in the card path.
- I6 N/A — no universe data.
- I7 holds — new tests use in-process HTTP + fs fixtures only; no network.
- I8 N/A — no monetary arithmetic.

§5.2 layer rule is Python-specific (`src/desk`), not this Node/Express board (§9.4.2 carve-out); §5.1 visual
rules are out of PI-04 scope.
