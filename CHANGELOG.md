# Changelog

All notable changes to the Agent Kanban Board are documented here. This project
follows [Semantic Versioning](https://semver.org/). The displayed version in the
UI header is read live from `server/package.json` via `GET /api/health`, so a
version bump here is what the running board reports.

Release boundaries are also tagged in git (`v0.1.0`, `v1.0.0`, `v2.0.0`) — see
`git tag -n`.

## [Unreleased]

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

- Server suite: 181 tests. Client suite: 59 tests. CI runs the full matrix on
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
