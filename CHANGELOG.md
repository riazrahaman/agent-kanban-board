# Changelog

All notable changes to the Agent Kanban Board are documented here. This project
follows [Semantic Versioning](https://semver.org/). The displayed version in the
UI header is read live from `server/package.json` via `GET /api/health`, so a
version bump here is what the running board reports.

Release boundaries are also tagged in git (`v0.1.0`, `v1.0.0`, `v2.0.0`,
`v2.1.0`, `v2.1.1`, `v2.1.2`, `v2.2.0`, `v2.3.0`, `v2.3.1`, `v2.3.2`, `v2.3.3`, `v2.3.4`) — see `git tag -n`.

**Versioning policy.** Every user-visible change bumps `server/package.json`
(the UI reads it live), with the same number mirrored into the root
`package.json`. Additive features bump the **minor** version; backwards-
compatible fixes and polish bump the **patch** version; breaking changes bump
the **major** version. Each release gets a `## [x.y.z] — YYYY-MM-DD` section
here **and** an annotated git tag. Do not let work accumulate under
`## [Unreleased]` across a shipped change.

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
