# Changelog

All notable changes to the Agent Kanban Board are documented here. This project
follows [Semantic Versioning](https://semver.org/). The displayed version in the
UI header is read live from `server/package.json` via `GET /api/health`, so a
version bump here is what the running board reports.

Release boundaries are also tagged in git (`v0.1.0`, `v1.0.0`, `v2.0.0`,
`v2.1.0`, `v2.1.1`, `v2.1.2`, `v2.2.0`, `v2.3.0`, `v2.3.1`, `v2.3.2`, `v2.3.3`, `v2.3.4`, `v2.3.5`, `v2.3.6`, `v2.3.7`, `v2.3.8`, `v2.3.9`, `v2.3.10`, `v2.3.11`) — see `git tag -n`.

**Versioning policy.** Every user-visible change bumps `server/package.json`
(the UI reads it live), with the same number mirrored into the root
`package.json`. Additive features bump the **minor** version; backwards-
compatible fixes and polish bump the **patch** version; breaking changes bump
the **major** version. Each release gets a `## [x.y.z] — YYYY-MM-DD` section
here **and** an annotated git tag. Do not let work accumulate under
`## [Unreleased]` across a shipped change.

## [2.3.11] — 2026-09-24

### Changed

- **Default claim TTL raised 300 s → 600 s** (`getClaimTtlMs`, `KANBAN_CLAIM_TTL_MS`).
  Measured production evidence: across 2,066 gaps between worker progress logs the
  median gap was 46 s but the p95 was 315 s, so a 5-minute TTL was reaping leases
  from live workers mid-build — 6.0% of heartbeating claims at 300 s versus 2.6% at
  600 s. Headless workers report progress with `POST /logs` and never call
  `/heartbeat`, so the lease was the only thing keeping the card alive.
- **Orphan grace decoupled from the TTL** (`getOrphanGraceMs`,
  `KANBAN_ORPHAN_GRACE_MS`). The grace default was "fall back to the claim TTL",
  which meant raising the TTL would have silently doubled the orphan window to
  10 minutes. The orphan grace now defaults to a fixed **300 s** — the two knobs
  answer different questions (how long a live worker may pause vs. how long an
  ownerless card may sit untouched).
- **A holder PATCH now extends the lease** (`patchTask`). Progress logs already
  extended the holder's lease (`appendLog`); a status transition did not, so a
  worker that only moved the card (the documented orchestrator flow) could lose
  its lease mid-flight. Any committed write by the lease holder — log, heartbeat,
  or status/field PATCH — now re-arms the full TTL. A non-holder write still never
  extends or steals the lease.

### Quality gates

- Server suite 226 tests / 36 suites / 0 fail (adds `lease hardening (v2.3.11)`:
  default-TTL probe, holder-PATCH extension, stranger/admin PATCH leaves the lease
  untouched; `kanban.notify.test.js` pins its own TTL so the default raise cannot
  drift its 6-minute sweeps). Client suite 77 / 0 fail. `make sec` clean; `tsc -b`
  and the production build clean.

## [2.3.10] — 2026-09-23

### Fixed

- **Stored HTML entities reached the user as visible noise.** The server escapes
  untrusted text on write (`escapeHtml`: `& < > " '`), but the client rendered
  the stored value verbatim, so a log saying "it's done" displayed as
  "it&#039;s done" — on cards, in the task sheet's title/description, in the
  agent-log panel, and in the signal rail. `client/src/sanitize.ts` (previously
  dead code) now carries `decodeStored`, mirroring `server/notifier.js`'s
  `DECODE_ORDER` with the same load-bearing invariant: the specific entities
  decode first and `&amp;` LAST, so a stored `&amp;lt;` decodes exactly once and
  can never become a real tag. Applied at every render site: `TaskSheet` title /
  description / log message, `TaskCard` title, `SignalRail` message + title.
  XSS-safe by construction: the decoded value is still rendered as a JSX text
  node, so `<script>` stays inert text; the server-side escape (the real
  defense) is untouched, and `kanban.test.js`'s XSS contract now asserts the
  decode wrapper is present alongside the `dangerouslySetInnerHTML` ban.

- **The agent-log panel read backwards.** `TaskSheet` sorted log entries
  newest-first, but the log is a narrative — entries are appended in
  chronological order, so the panel now reads oldest-first (writing order).
  The SignalRail "recent activity" feed is unchanged: it is a live ticker, where
  newest-first is correct.

### Quality gates

- Server suite **223 tests / 35 suites / 0 fail** (the XSS contract test now
  asserts the decode wrapper); client suite **77 tests / 0 fail** (adds the
  `sanitize.test.mjs` decode/round-trip suite and updates the responsive +
  About source-contract guards to the new call shape); `tsc -b` and the
  production build clean.

## [Unreleased]

### Added

- **Version-bump guard in CI** (`scripts/check-version-bump.sh`). `kanban.version.test.js`
  asserts that the current version is *internally consistent* — manifests agree, a CHANGELOG
  section exists for it, docs declare the same number — but it cannot see the *previous*
  version, so a user-visible change can ship completely unbumped and stay green. That is exactly
  how the branch-field fix reached `main` while the live board still reported `2.3.5`. Answering
  "has this changed since the base branch?" needs git history, so the rule now lives in the
  workflow, at the gate that blocks the merge. The job checks out with `fetch-depth: 0` so the
  merge base is reachable, and runs before dependency install so a missing bump fails fast.

  Scope is deliberate: `server/**/*.js` (excluding `server/test/`) and `client/src/**`
  (excluding tests) require a bump; docs-only, test-only, tooling-only and manifest-only changes
  do not. A naive "any commit must bump" rule would fail most of this repo's history — most of
  `v2.3.0`–`v2.3.6` were documentation syncs — and would be disabled within a week.

- **`README.md` → Releasing** documents the guard, its scope, and how to run it locally
  (`./scripts/check-version-bump.sh origin/main`).

### Quality gates

- Guard verified against 13 scenarios in a scratch clone: source-change-without-bump fails;
  source-change-with-bump passes; docs-only, test-only (server and client), tooling-only,
  manifest-only and no-change all pass; nested runtime dirs (`server/routes/`,
  `server/middleware/`) and `server/utils/` correctly count as source; a missing base ref and a
  missing argument each exit 2 with a clear message rather than a silent pass.
- No runtime code changed in this release. Server suite 222 tests / 34 suites / 0 fail; client
  68 / 0 fail; `make sec` clean; `tsc -b` and the production build clean.

## [2.3.9] — 2026-09-23

### Fixed

- **2.3.8 regression: long task ids were squashed into a ~30px sliver.** The 2.3.8 fix
  put `overflow-wrap:anywhere` on the card's id `<span>`. That class lowers an element's
  **min-content size** — which is exactly why it was chosen (it stops a long token widening
  the lane) — but the span sits in the header's flex row (`justify-between`, `nowrap`) with
  `min-width:auto` and `flex-shrink:1`. With a near-zero min-content size the span absorbed
  nearly all the shrink: `init-agent-investment-advisor` rendered **30px wide × 176px tall,
  wrapping character-by-character over 11 lines** (`ini/t-/age/ntc/inv/est/men/t-/adv/iso/r`),
  against a normal card's 86px × 16px one-liner. 64 of 142 live cards had a multi-line header.

  Verified this was introduced by 2.3.8, not pre-existing, by reverting the class live:
  before, 3 cards wrapped (max 3 lines) with 1 row overflowing 55px; after, the overflow was
  gone but 3 cards squashed, one to 11 lines.

  The rule is now: **prose wraps, identifiers ellipsise.** Task ids, project slugs, agent ids
  and log agent ids are identifiers and must stay on ONE line — `min-w-0` + `truncate`, with
  the full value in a `title` tooltip, and their flex siblings pinned `shrink-0` so they cannot
  squeeze them. Titles, descriptions, log messages and raw error text stay wrapped with
  `overflow-wrap:anywhere`, which is where that class belongs.

  Corrected in `TaskCard.tsx` (header id, assigned agent, issues badge) and `TaskSheet.tsx`
  (id, project badge, assigned-agent badge, stage owners, log agent id, log timestamp).

- **CI gap that let the regression ship.** No unit test could catch it: asserting a className
  string cannot know how the browser lays that class out. Added
  `scripts/check-card-layout.mjs`, which drives a real headless Chrome over CDP, loads the
  built board, and measures **every** card's header-row height and id line count — failing if
  any card's header wrapped. It seeds its own worst-case fixture (the id that regressed plus a
  long unbreakable token) so an empty board cannot pass vacuously, and runs as a CI step after
  the client build.

### Quality gates

- The layout guard was verified **both ways**: against the reintroduced 2.3.8 code it fails
  naming `init-agent-investment-advisor` (`headerH=80px, idLines=5`); against the fix it passes
  across every card (≤26px, zero horizontal overflow).
- `responsive.test.mjs` now splits its 16 sites into prose vs identifier contracts, so a
  regression to either behaviour fails. Proved non-vacuous: reverting the id span to the 2.3.8
  classes fails it (72 → 70 pass / 2 fail).
- Server suite 223 / 0 fail; client 72 / 0 fail; production build clean; `make sec` clean.

## [2.3.8] — 2026-09-23

### Fixed

- **Long unbreakable tokens overflowed task cards and widened the board column.** A title
  carrying a slash-joined path with no break opportunity (e.g.
  `AOV_BUILD_PROGRESS/TEST_REPORT/HANDOVER/CLAUDE.md/CHANGELOG`) painted straight out of its
  card. Measured live at 1280px: the title `<p>` was 242px wide but overflowed by 278px, and the
  DONE lane's list was `clientWidth 286 / scrollWidth 543` — the column silently scrolled
  sideways. Length alone was never the cause: control titles of 45/52/79 characters with a
  longest token of 29 characters never overflowed.

  Fixed with `break-words [overflow-wrap:anywhere]`. `overflow-wrap:break-word` alone is
  insufficient — only `anywhere` also shrinks the element's *min-content* size, which is what
  stops a token from forcing its flex parent wider. The card's id `<span>` proved load-bearing,
  not cosmetic: with only the title fixed, the lane still overflowed `321` vs `286`, because a
  different card's header row (id span + project badge) shrank its flex child to min-content.

- **The same defect at 10 further render sites, found by a codebase-wide sweep.** The whole
  task-detail drawer was affected, not just cards. Overflow measured against the parent's
  content-box edge, before → after (px painted past the parent):

  | site | before | after |
  |---|---|---|
  | `TaskSheet` id span | 213 | −6 |
  | `TaskSheet` title | 405 | −5 |
  | `TaskSheet` project badge | 81 | −9 |
  | `TaskSheet` assigned-agent badge | 81 | −9 |
  | `TaskSheet` description | 270 | −9 |
  | `TaskSheet` stage owners | 99 | −6 |
  | `TaskSheet` log agent badge | 121 | −87 |
  | `TaskSheet` log message | 205 | −8 |
  | `TaskCard` assigned agent | 266 | −4 |
  | `ErrorBoundary` error message | 336 | −2 |

  Applied **per site**, not as a global CSS rule. A systemic rule was measured and rejected: it
  fixed the targets but also re-wrapped unrelated elements, breaking the `BACKLOG` status badge
  mid-word (19px → 34px). A global rule cannot distinguish a leaf text node from a layout
  container. Per-site produced **0 geometry diffs** on normal content (171-element whole-tree
  diff).

  Deliberately not changed: the metadata `<pre>` (already `overflow-auto`; wrapping would
  reformat the JSON) and every `truncate` site (`white-space:nowrap` wins over `overflow-wrap`,
  so they stay ellipsised — verified: 7/7 still nowrap + ellipsis, none gained wrapping).

- **Board lanes rendered in raw array order, not recency order.** A lane draws top-to-bottom in
  the order the API returns, so "what just moved" sat wherever the record happened to land — the
  DONE lane opened on a day-old smoke test. `getTasks()` now orders by `updated` descending (the
  key stamped on create and on every mutation), falling back to `created_at`, with records
  carrying neither sorting last rather than throwing. Sorted on a **copy**: `tasks` is the live
  array the store mutates, and an in-place sort would have reordered the store's internals on
  every read. Verified against a live server (seed A,B,C,D then touch A): `D,C,B,A` → `A,D,C,B`,
  stable across repeated reads.

### Fixed (tooling)

- **The client test-count guard could not see node:test subtests.** `about.test.mjs` counted
  top-level `it(`/`test(` declarations with a line-anchored regex, so a nested
  `t.test(...)` subtest — which the runner *does* execute and count — was invisible. It counted
  68 while the runner executed 69, i.e. the About page displayed a stale number while the guard
  that exists to catch stale numbers reported green. The regex now allows a receiver
  (`(?:[\w$]+\.)?`), so the count matches the runner (server 223, client 72). This is the same
  defect class as the `203`-vs-`222` drift fixed in 2.3.7, one level down.

### Quality gates

- Server suite **223 / 0 fail**; client **72 / 0 fail**; production build clean; `make sec` clean.
- Both new guards proven non-vacuous by mutation: removing a wrapping class fails the responsive
  guard (72 → 70 pass / 2 fail); removing the recency sort fails the ordering test
  (223 → 222 pass / 1 fail).
- Live verification on a locally served production build with a hostile fixture: page overflow
  `0`, lane `clientWidth/scrollWidth` `286/286`, drawer scroller `441/441`.

## [2.3.7] — 2026-09-23

### Fixed

- **The About page's proof strip showed a stale test count.** It read `203 server tests` when the
  suite was 222. The 2.3.6 branch-integrity guard added 19 tests and a 24th file, pushing the real
  total to 222; the docs and one-pager were refreshed at the time but this one spot inside the app
  was missed.
- **The guard that should have caught it was not a guard.** `about.test.mjs` contained a test
  literally named *"the trust metrics report the real suite sizes (no stale counts)"* that asserted
  a hardcoded `'203'`. It checked that the number had not changed from the number it asserted — it
  could never detect drift, and passed for as long as the metric was wrong. It now counts the test
  declarations in `server/test/*.test.js` and `client/src/**/*.test.mjs` and compares the metric
  against that, so the next drift fails the build. Both counts also assert `> 0`, so a silent
  discovery failure fails loudly instead of passing vacuously.

### Changed

- **`docs/with-images/FILE_BY_FILE_EXPLANATION.md` re-synced with its twin.** The 2.3.6 pass updated
  `docs/FILE_BY_FILE_EXPLANATION.md` to 222 tests / 24 files but left the `with-images/` mirror on
  203 / 23, and did not add `kanban.branch.test.js` to its coverage list. Both files now agree.
- **`docs/HANDOVER_MULTI_PROJECT.md`** "last verified" line corrected from server 203/203 to 222/222.
- Version strings bumped to 2.3.7 in `SYSTEM_DESIGN_AND_ARCHITECTURE.md`, `USER_AND_OPERATOR_MANUAL.md`
  and their `docs/with-images/` mirrors.

### Quality gates

- Server suite 222 tests / 34 suites / 0 fail; client suite 68 / 0 fail; client status check pass;
  `make sec` clean; `tsc -b` and the production build clean. The About bundle hash changed
  (`index-DNuh978L.js` → `index-Dj-XYvTS.js`), confirming the metric reached the shipped artifact
  rather than only the source.
- While fixing this, the new counted test immediately caught a missing `readdirSync` import in its
  own first run — evidence it exercises real behaviour rather than passing trivially.

## [2.3.6] — 2026-09-22

### Fixed

- **`branch` no longer fabricated as `task/<id>`.** An absent branch was invented as a ref
  that does not exist in git, and orchestrator-created tasks could silently inherit a *stale
  branch belonging to a previously created task*. Because `branch` is rendered to a human in
  reclaim alerts, a lease-expiry notification could advertise a branch that does not exist, or
  someone else's branch. Both sites are now pinned to the caller's own value, `null` when absent.
- **The PATCH path skipped normalisation.** `createTask` and `serializeCard` coerced blanks to
  `null` while the `patchTask` allow-list assigned verbatim, so the *same* task could report
  `"   "` or `123` over REST and persist it, yet read back as `null` from the git YAML card. All
  three write paths now call one shared exported `toBranch` so they cannot drift apart again.

  The rule, now a single definition in `server/store.js`: a string with non-whitespace content is
  kept **verbatim, untrimmed** (a ref is the caller's exact claim — `"  fix/padded  "` stays
  byte-for-byte as sent); everything else — absent, `null`, `""`, whitespace-only, and non-strings
  such as `123` — becomes `null`. `escapeHtml` is deliberately not applied to `branch`: it is a
  ref, not prose, and has never been HTML-escaped on any path.

- **Reclaim alerts omit the Branch row entirely when there is no branch**, rather than printing a
  dangling label.

### Added

- **Branch-integrity regression guard** (`server/test/kanban.branch.test.js`, 19 tests). It pins
  the invariant at every layer that matters — the HTTP API, both persisted sinks (JSON + git YAML
  card), and the notifier text a human actually reads — across hostile inputs including `""`,
  `"   "`, `"\t"`, `123`, `0`, `false`, `[]`, `{}`, and a `null`-vs-omitted distinction. The
  git-card cases run with `autoCommit: false`, so the suite stays hermetic.

### Known limitation

- **Existing records are not migrated.** Normalisation happens on *write*, not on *read*: a card
  written by an older build keeps its dirty value until something rewrites it. A pre-fix card
  holding `branch: "   "` or a fabricated `task/<id>` is still served verbatim by `GET`, and can
  still render a blank `Branch:` row in a reclaim alert. On a git-backed board an unrelated write
  re-serialises that card, so its card value becomes `null` while memory/REST still hold the raw
  value. Cleaning is a data operation, not a code one — patch the card (`PATCH {branch: null}`) or
  migrate the sink. Treat a branch as fabricated only when it exactly equals `task/` + **that
  task's own id**; a looser "starts with `task/`" rule destroys real refs.

### Quality gates

- Server suite **222 tests / 34 suites / 0 fail**; client suite 68 tests / 0 fail; `make sec`
  clean; `tsc -b` and the production build are clean. Verified on Node 20.x and 22.x via CI.

## [2.3.5] — 2026-09-21

### Changed

- **Documentation sync for the 2.3.4 reclaim fix.** The standalone one-pager
  (`docs/Agent_Kanban_Board_OnePager_v5.html`) was left behind by the 2.3.4 release: its nav badge
  still read `v2.3.3` and its proof strip still claimed **196** server tests. Both are corrected to
  `v2.3.5` and **203**.
- **`ONBOARDING.md` reclaim wording corrected.** It described an ownerless active task as
  normalized "the same way" as an expired lease, i.e. immediately. That is no longer true — the
  orphan grace window (`KANBAN_ORPHAN_GRACE_MS`, default = the lease TTL) now applies. The section
  says so explicitly, including that a status-only `PATCH` into an active stage is not instantly
  reverted.

### Quality gates

- Server suite 203 tests / 33 suites / 0 fail; client suite 68 tests / 0 fail; `tsc -b` and the
  production build are clean. Documentation-only change — no runtime code was touched.

## [2.3.4] — 2026-09-21

### Fixed

- **Reclaim false-positives.** Two features added days apart contradicted each other:
  per-stage ownership (`c75a881`) deliberately made `patchTask` write only `stage_owners`
  and leave `assigned_agent` as the lease holder, while orphan normalization (`a0b8980`)
  then declared any *ownerless active* task "structurally stuck, always reclaim" with no
  grace period. The documented orchestrator flow enters a stage with a status-only `PATCH`,
  so every card driven into `BUILDING`/`IN_REVIEW`/`IN_TEST` was reverted to `BACKLOG` by
  the next 30 s sweep (one live card was reclaimed 16 s after a write). Two changes:
  - **Orphan grace window** — `KANBAN_ORPHAN_GRACE_MS` (default = `KANBAN_CLAIM_TTL_MS`,
    i.e. 5 min): an ownerless active task is only normalized once it has been untouched
    for the window, anchored on `updated`, so any later write resets the clock. `0`
    restores immediate reaping. A genuinely abandoned orphan is still cleaned up.
  - **Holder progress-log extends the lease** — `appendLog` now renews `claim_expires_at`
    when the caller is the lease holder. Headless builders/reviewers report progress with
    `POST /logs` and never call `/heartbeat` (only the browser client does, every 5 s), so
    long builds were losing their lease at the TTL and being reaped mid-flight. A
    non-holder log never extends or steals the lease.

### Changed

- **`riaz` orchestration skill v1.2.1** (outside this repo, at
  `~/.agents/skills/riaz/SKILL.md`) — Stage B now enters an active stage by **claiming**
  (`POST /claim` writes owner + lease and promotes `BACKLOG → BUILDING`) instead of a
  status-only `PATCH`; added an explicit heartbeat cadence (every TTL/2) and a
  lease-loss recovery rule, and clarified that `expected_version` guards the CAS check
  but not the state machine.

### Quality gates

- Server suite 203 tests / 33 suites / 0 fail (was 196); new coverage in
  `kanban.orphan.test.js` (grace window, clock reset, opt-out) and `kanban.lease.test.js`
  (holder vs non-holder log). Falsification confirmed the new tests fail without the fixes.
- Client suite 68 tests / 0 fail; `tsc -b` and the production build are clean.

## [2.3.3] — 2026-09-21

### Changed

- **Documentation sync** — corrected markdown rendering and stale About copy; completed
  code-flow coverage for purge/delete/heartbeat/issues, `stage_owners`, project deep
  links, and `RECLAIM_FLOW`; corrected presentation counts; synchronized the HANDOVER
  living state and recommendations status.

### Quality gates

- Server and client release checks pass with the version guard validating this changelog
  section and the synchronized documentation version strings.

## [2.3.2] — 2026-09-20

### Changed

- **About page now tells the reclaim-alert story** — the in-app product
  overview explained the lease + reaper mechanism but never said that a human
  actually gets *alerted*. Added additively (no existing section removed):
  a fourth "why a normal board isn't enough" card for the silent-reclaim
  failure mode; a new **"What happens when an agent disappears"** code-flow
  subsection walking stalled heartbeat → `reapExpiredClaims` →
  `reclaimTaskInner` → `notify()` → `notifier.js` → Telegram, including the
  fail-silent delivery guarantee; and an FAQ entry documenting
  `KANBAN_TELEGRAM_BOT_TOKEN` / `KANBAN_TELEGRAM_CHAT_ID` and the
  off-by-default behaviour. The client regression guard was extended to cover
  all three (client suite 65 → 68 tests).
- **Documentation sync** — the User & Operator Manual §5.7 (and its
  `with-images` mirror) now describes the reclaim-alert subsection.

## [2.3.1] — 2026-09-20

### Changed

- **Onboarding guide** — `ONBOARDING.md` §7 ("Storage notes for the owner") now
  covers reclaim notifications: the two required env vars, the off-by-default
  behaviour, the delivery guarantees, and a pointer to the full setup
  walkthrough in the User & Operator Manual. Documentation only — no code or
  behaviour change.

## [2.3.0] — 2026-09-20

### Added

- **Telegram alerts when a task is reclaimed to `BACKLOG`** — when the lease
  reaper returns an idle task to `BACKLOG`, the server now posts a full-detail
  alert to a Telegram group or chat.
  - New `server/notifier.js` — a pure subscriber on the `store.onDiff` stream
    (`kind === 'reclaimed'`), covering both `lease_expired` (a dead agent) and
    `orphan_normalized` (an active task found with no owner). No mutation-path
    surface: the reaper's write has already committed before the alert is sent.
  - Full-detail HTML message: project, task id, title, priority + round, branch,
    dependencies, issues, a truncated description, reason, previous owner, lease
    expiry, last activity, reclaim count, per-stage owners, the last agent log
    entry, and a deep link back to the board.
  - **No new dependency** — the Bot API is a plain HTTPS `POST` using the global
    `fetch` already available on Node 20/22 (the CI matrix).
  - **Fail-silent delivery** — sends are fire-and-forget and wrapped, so a
    Telegram outage is logged (`[kanban notify] send failed: …`) and can never
    break a reclaim; the task still returns to `BACKLOG`.
  - **One message per task**, serialized with a configurable minimum gap and
    `429 retry_after` support, so a sweep reclaiming several tasks cannot trip
    Telegram's per-chat rate limit.
  - **Off by default** — inert unless both `KANBAN_TELEGRAM_BOT_TOKEN` and
    `KANBAN_TELEGRAM_CHAT_ID` are set. The token is server-side only and redacted
    from logs.
  - Config: `KANBAN_NOTIFY_EVENTS`, `KANBAN_NOTIFY_PROJECTS`,
    `KANBAN_NOTIFY_INCLUDE_DESC`, `KANBAN_NOTIFY_MIN_INTERVAL_MS`,
    `KANBAN_BOARD_URL`.
- **Deep-linkable project scope** — the client now honours `?project=<id>` on
  load, so a reclaim alert's link opens the board already scoped to that task's
  project (falling back to the persisted scope, then "all projects"). The query
  param is consumed and dropped via `history.replaceState`.

### Quality gates

- Server suite: 196 tests (33 suites) — adds `kanban.notify.test.js` (10 tests:
  config gating, event/project filtering, full-detail rendering, single-escape
  of stored entities, description truncation, one-send-per-reclaim end to end,
  a failing webhook never breaking the reclaim, no-op when unconfigured, and
  token redaction in logs).
- Client suite: 65 tests. `tsc -b` clean; `vite build` clean.
- Live end-to-end proof: a real server with a 2.5 s lease TTL delivered
  `[kanban notify] delivered 1 reclaim alert to telegram` and the task returned
  to `BACKLOG` with `reclaim_count` 1.

## [2.2.0] — 2026-09-19

### Added

- **About view: Architecture & code flow section** — the in-app About view gains
  an additive "Architecture & code flow" section that goes deeper than the
  capability list:
  - **The stack, in one table** — layer → choice → why → code location.
  - **What happens when an agent claims a task** — a step-by-step walk of the
    real `next-claim` path (route → auth middleware → `withMutationLock` →
    `dependencyGate` eligibility → `applyClaim` → persist-before-memory →
    SSE `notify`).
  - **Three safety layers around every write** — optimistic concurrency
    (`version` + `If-Match`), the deterministic state machine
    (`canTransition` / `canRoleTransition`), and lease ownership, with the
    persist-first footer.
  - **Six layers, top to bottom** — a compact mirror of the system-design
    chapter.
  - New data exports in `client/src/lib/aboutContent.ts` (`STACK_ROWS`,
    `CLAIM_FLOW`, `SAFETY_LAYERS`, `SAFETY_FOOTER`, `ARCH_LAYERS`,
    `ARCH_INTRO`), rendered by `client/src/components/About.tsx`. The section is
    mobile-first: the stack table collapses into labelled cards on narrow
    screens (verified at 360/390/1280).

### Changed

- **About trust strip** — corrected stale test counts from `181` server / `48`
  client to the real `186` / `59`.
- Docs synced: README, `docs/FILE_BY_FILE_EXPLANATION.md` (+ `with-images`
  mirror), and §5.7 of the User & Operator Manual (+ mirror) now describe the
  architecture section.

### Quality gates

- Server suite: 186 tests. Client suite: 65 tests (was 59; adds the
  architecture-content + additive-preservation guards in `about.test.mjs`).

## [2.1.2] — 2026-09-19

### Changed

- **Custom production domain** — the live board is now reachable at
  **<https://agent-kanban.riazrahaman.com>** (a custom domain on Railway, in
  addition to the `*.up.railway.app` hostname). Pointed the in-app About view's
  live-demo link (`ABOUT_LIVE_URL`), the README deployment section, `ONBOARDING.md`
  examples, the presentation notes, and the standalone one-pager at the new
  domain; the one-pager's stale `v1.0.0` badge was also corrected.

## [2.1.1] — 2026-09-19

### Changed

- **Documentation sync** — the in-app **About view** is now documented in the
  User & Operator Manual (new §5.7, plus the header switch relabelled
  "Board / Portfolio / About Switcher" in the UI diagram) and in the System
  Design & Architecture frontend table (new "Top-Level Views" row). The same
  edits were mirrored into the `docs/with-images/` copies.
- **Corrected stale test counts** — the docs now report the real figures:
  the server suite is 186 tests across 22 files (was listed as 151/17), and the
  new coverage is named (`kanban.host`, `kanban.orphan`, `kanban.purge`,
  `kanban.stageowners`, `kanban.version`). README and CHANGELOG server counts
  updated from 181 to 186.

## [2.1.0] — 2026-09-19

### Added

- **In-app About view** — a third top-level view alongside Board and Portfolio.
  It presents the product pitch (a headless-first state register for agent
  swarms), a curl walkthrough, a trust strip, the "why a normal board isn't
  enough" cards, the lifecycle walk, a capabilities table, a curated tour of
  screenshots served from `client/public/landing/`, an FAQ, and community CTAs.
  The header now shows a single segmented Board / Portfolio / About switcher,
  and the page reads the live server `version` so it can never show a stale one.
  Content is data-driven (`client/src/lib/aboutContent.ts`) and guarded by
  `client/src/lib/about.test.mjs`.

### Changed

- **Softer dark theme** — replaced the near-black dark palette
  (`--bg: #0c0d0f`) with a warm charcoal one (`--bg: #1a1b1e`, `--surface:
  #232428`) so the dark theme mirrors the cream light palette and reads as the
  same product. Text/state tints were lifted for warmth while keeping WCAG AA
  contrast. Defined solely in `client/src/index.css`.

### Quality gates

- Client suite: 59 tests (Adds the About-page source-contract + content tests.)

## [2.0.0] — 2026-09-19

The third hardening + feature round ("R3") plus the accessibility/UX work. This
is the first tagged release with the full operator surface (delete/purge,
per-stage ownership) and the custom, Safari-safe project picker.

### Added

- **Admin delete + bulk purge** — `DELETE /api/tasks/:id` and
  `POST /api/tasks/purge` (by `ids[]` or a `filter` of `status` / `project` /
  `older_than_days` / `assigned_agent`). Privileged-role gated (runner / system /
  human / admin), fully audited, persisted before memory is mutated.
- **Per-stage ownership** — each task now records `stage_owners`
  (`BUILDING` / `IN_REVIEW` / `IN_TEST` / `DONE` → acting agent), stamped on
  every real transition from the authenticated caller. Surfaced on the task card
  and in the task sheet. `assigned_agent` remains the lease holder.
- **Custom `ProjectPicker`** — replaces the native `<select>` with a keyboard-
  and ARIA-accessible listbox, fixing unreliable native dropdown behaviour in
  Safari.
- **Stale-scope auto-recovery** — if the saved project scope no longer exists on
  the board, the client resets to "all projects" and clears the bad key instead
  of showing an empty board.
- **Explicit empty state** — an empty board now explains what to do next rather
  than rendering blank.
- **`/api/health`** reporting `store_loaded`, task counts, listeners, reaper
  state, and the live version.
- **Presentation notes + live product tour screenshots** (`docs/PRESENTATION_NOTES.md`).

### Changed

- **Ownerless active tasks are normalized** — a task created directly in an
  active status with no owner is now reclaimed to `BACKLOG` by the reaper
  instead of being permanently stuck.
- **Bracketed IPv6 `HOST` values** (`[::]`) are normalized before `listen()`,
  fixing Railway deploys.
- **Mobile-friendly layout** — wrapping header, snap-scrolling columns
  (`85vw` below `md`), slide-over Signal Rail drawer, larger touch targets,
  `100dvh` handling.
- **Discoverable horizontal scroll** — edge fades + paging chevrons on the board.
- **Warm cream light palette** replacing the near-white light theme (WCAG AA).
- **Header help popover** explaining the agent-id and API-token fields.

### Fixed

- Stale project scope silently emptying the board.
- Native dropdown unusable in Safari.
- Ownerless `BUILDING` cards showing "unassigned" forever.
- Concurrent-write retry bug in the mutation lock (round 1 carry-over).
- Stored-XSS gap on task `issueId` (round 1 carry-over).

### Quality gates

- Server suite: 186 tests. Client suite: 59 tests. CI runs the full matrix on
  Node 20.x and 22.x.

## [1.0.0] — 2026-09-18

The second round ("round 2") — hardening + observability + security. The board
became deployable to a persistent host and gained a real operator surface.

### Added

- **HMAC session-token auth** (variant B) — `POST /api/auth/session` handshake
  issuing stateless, scoped, expiring bearer tokens, additive to static tokens;
  enabled by `KANBAN_AUTH_SECRET`.
- **`/api/health`** + `/healthz` alias (reports store reaper + counts).
- **Admin-token audit trail** — admin writes emit an auditable `admin_write`
  event.
- **Auth-failure logging** gated by `KANBAN_AUTH_LOG` (redacted).
- **CORS allow-list** as a comma-separated list via `KANBAN_ALLOWED_ORIGIN`.
- **Rate-limit headers** (`X-RateLimit-Limit` / `-Remaining`).
- **Opt-in periodic backup** of task data (`KANBAN_BACKUP_*`).
- **GitHub Actions CI** (`.github/workflows/ci.yml`) on push/PR to `main`.

### Fixed

- `next-claim` role smuggling — the claim role now comes from the authenticated
  caller, never a query parameter.
- `addIssue` stored-XSS (escapes `issueId`).
- Bracketed-host and client API-base deploy issues.

### Changed

- Incremental aggregate caching for `getMetrics` / `getProjectSummaries`.
- `React.memo` on `Column` / `TaskCard` + memoized grouping.

## [0.1.0] — 2026-09-18

The first round of review-driven fixes and the initial deployable build.

### Added

- Dark/light theme toggle (explicit choice beats OS preference, pre-paint).
- Horizontal scroll affordance on the board.
- Header version chip sourced from `/api/health`.

### Fixed

- Mutation-lock retry passing an error object into operations (race/corruption).
- Client hardcoded `localhost` API base (broke deployed UI).

## [0.0.0] — 2026-09-17

Initial system: strict `BACKLOG → BUILDING → IN_REVIEW → IN_TEST → DONE`
state machine (+ `BLOCKED`), role-based access control, process-local mutation
lock, lease-based ownership with a background reaper, pluggable JSON /
git-backed YAML persistence with atomic writes, and SSE push to the client.
