# Changelog

All notable changes to the Agent Kanban Board are documented here. This project
follows [Semantic Versioning](https://semver.org/). The displayed version in the
UI header is read live from `server/package.json` via `GET /api/health`, so a
version bump here is what the running board reports.

Release boundaries are also tagged in git (`v0.1.0`, `v1.0.0`, `v2.0.0`,
`v2.1.0`, `v2.1.1`, `v2.1.2`, `v2.2.0`, `v2.3.0`, `v2.3.1`, `v2.3.2`, `v2.3.3`, `v2.3.4`, `v2.3.5`, `v2.3.6`, `v2.3.7`, `v2.3.8`, `v2.3.9`, `v2.3.10`, `v2.3.11`, `v2.3.12`, `v2.3.13`, `v2.4.0`, `v2.5.0`, `v2.5.1`, `v2.5.2`, `v2.5.3`, `v2.5.4`, `v2.5.5`, `v2.5.6`, `v2.5.7`, `v2.5.8`, `v2.5.9`, `v2.5.10`, `v2.6.0`, `v2.7.0`, `v2.8.0`, `v2.9.0`, `v2.9.1`, `v2.10.0`, `v2.11.0`, `v2.12.0`, `v2.13.0`, `v2.14.0`, `v2.14.1`) — see `git tag -n`.

**Versioning policy.** Every user-visible change bumps `server/package.json`
(the UI reads it live), with the same number mirrored into the root
`package.json`. Additive features bump the **minor** version; backwards-
compatible fixes and polish bump the **patch** version; breaking changes bump
the **major** version. Each release gets a `## [x.y.z] — YYYY-MM-DD` section
here **and** an annotated git tag. Do not let work accumulate under
`## [Unreleased]` across a shipped change.

## [2.14.1] — 2026-09-26

Documentation patch: the bundled orchestrator skill now documents the reclaim
alerts that were already shipping in the app. Docs-only — no server or client
behaviour changed.

### Added
- **Reclaim alerts in `skills/kanban/SKILL.md` (§4, new "Reclaim Alerts"
  subsection).** The skill's lease-loss recovery path had referred to
  "re-claim alerts" without ever defining them. It now documents the optional
  Telegram alert the reaper fires on `lease_expired` / `orphan_normalized`
  (`KANBAN_TELEGRAM_BOT_TOKEN` + `KANBAN_TELEGRAM_CHAT_ID`, off by default;
  filters `KANBAN_NOTIFY_PROJECTS`, `KANBAN_NOTIFY_EVENTS`, `KANBAN_BOARD_URL`)
  and states that the notifier is a pure subscriber — never poll it, treat an
  alert as a prompt to inspect the card and re-claim. Skill version `1.1.0` →
  `1.2.0`.

### Changed
- The About view's orchestrator-skill entry, the README skill subsection, and
  the `skills/kanban/SKILL.md` entry in `docs/FILE_BY_FILE_EXPLANATION.md`
  (§4.1) and `docs/USER_AND_OPERATOR_MANUAL.md` (§6.4) now mention reclaim
  alerts. Both `docs/with-images/` mirrors updated in lockstep.

## [2.14.0] — 2026-09-26

The board now ships the orchestrator skill that drives it, and the design
contract that had only lived in code is written down. Docs-and-assets release;
no server behaviour changed.

### Added
- **`skills/kanban/SKILL.md`** — the opencode skill that turns a coding agent
  into a strict Kanban-first orchestrator is now bundled in the repo (it
  previously lived only outside it). It covers local deployment, mandatory
  `?project=` scoping, the claim-first lifecycle (claim to own, PATCH to move,
  `expected_version` on every write), role headers, lease/heartbeat rules,
  branch normalization and legacy-card cleanup. Copy it to `.opencode/skill/`
  or `~/.config/opencode/skill/` to install.
- **About page — "Bundled orchestrator skill" section.** The About view now
  documents the shipped skill: its path (`skills/kanban/SKILL.md`), the install
  commands, and the three rules it enforces. Backed by a new
  `ORCHESTRATOR_SKILL` export in `client/src/lib/aboutContent.ts` and asserted
  by a new data-contract test in `client/src/lib/about.test.mjs` that also
  reads the real file from disk.
- **`DESIGN.md`** — the visual contract now exists as a real document. It
  consolidates the design system that had only lived in code and prose:
  the full colour-token tables (`client/src/index.css`), typography stacks
  (`client/tailwind.config.js`), geometry, status/priority encoding
  (`client/src/status.js`, `client/src/priority.ts`), the component vocabulary,
  theming, motion, responsive rules, accessibility targets, the enforced
  anti-pattern bans, and instructions for changing any of it. The name was
  already referenced by `client/src/lib/responsive.test.mjs` and the
  `DESIGN.md visual contract` test in `server/test/kanban.test.js`; this makes
  that reference real.
- **`DESIGN_SYSTEM.md`** — a portable, project-agnostic edition of the same
  contract, intended to be handed to a build agent for a *different* project.
  It contains no references to this codebase: the kanban-specific status set is
  generalised into a state-role mapping method, file-path pointers become
  "your theme layer", and a new new-project quick-start checklist is added. All
  token values, contrast targets, font stacks, geometry rules, and the
  anti-pattern bans are preserved verbatim.

### Fixed
- **Corrected three factual errors in the bundled `SKILL.md`** (relative to the
  external copy it was ported from): the default server port is **4000**, not
  3000; the default claim TTL is **600,000 ms (10 min)**, not 300,000 ms/5 min,
  and the skill now documents the per-claim `lease_ms` override clamped to
  `KANBAN_MIN_LEASE_MS` (60,000) / `KANBAN_MAX_LEASE_MS` (7,200,000); and the
  auto-deploy steps now install per package (`npm --prefix server install`,
  `npm --prefix client install`, then `npm run build` + `npm start`), since
  there is no root `npm install` or root `npm run dev` script.

### Changed
- `README.md`, `docs/FILE_BY_FILE_EXPLANATION.md` (+ `with-images/` mirror) and
  `docs/USER_AND_OPERATOR_MANUAL.md` (+ mirror) now document the bundled skill
  (project-tree entry, a Quickstart step, a file-by-file entry, and a
  `6.4 Bundled Orchestrator Skill` section respectively).

## [2.13.0] — 2026-09-25

Post-release correctness pass on v2.12.0's lease-window work, from a deep-dive
code review (findings I-1 through I-8, cleanups C-1 through C-3) plus two of
the review's suggested enhancements. v2.12.0's core mechanism (a lease window
chosen at claim time, a bulk heartbeat, holder-write renewal) was sound; the
bugs were all in the *side effects* of renewal — version churn, cross-project
reach, event timing, and validation.

### Fixed
- **I-1 — a lease-only renewal no longer bumps `version`.** Renewing a sibling
  card's lease is not a content change; it was bumping `version` on every card
  a busy holder touched indirectly, which invalidated concurrent
  `expected_version`/CAS PATCHes on cards nobody was actually editing. Identity
  swap (already how the diff stream detects change) is enough of a signal.
- **I-2 — sibling renewal stays inside the writing project.** A write in
  project `alpha` could previously renew the same holder's lease in project
  `beta`, bypassing per-project token isolation. Every sibling-renewal call
  site now passes the writer's own project.
- **I-3 — the bulk heartbeat (`POST /api/agents/:agent_id/heartbeat`) now
  requires `?project=` for a non-privileged (self) caller.** Without a scope it
  previously swept every project on the board; only a privileged credential may
  omit it for the intentional all-projects sweep.
- **I-4 — bulk-heartbeat privilege is derived from the credential, not the
  self-asserted `X-Agent-Role` header.** A per-project worker token could send
  `X-Agent-Role: admin` and pass the old check; it now uses the same
  credential-derived `caller.privileged` flag destructive ops already use
  (exported as `store.callerIsPrivileged`).
- **I-5 — a holder PATCH's sibling renewals broadcast in the same tick.** They
  previously landed after `notify()` had already fired, so the sibling's new
  expiry only reached SSE clients on some later, unrelated mutation.
- **I-6 — a sibling-renewal failure can no longer fail (or half-commit) the
  caller's real write.** Each sibling is now renewed in its own try/catch
  inside `renewAllLeasesInner`; a failed save is logged and skipped, never
  thrown back through `appendLog`/`patchTask`/`applyClaim`.
- **I-7 — sibling renewals are tagged `renewed`, not a bare `updated`,** in the
  diff/audit/webhook stream (`lease_renewed_holder_write` / `lease_renewed_bulk`
  reasons), so they no longer masquerade as ordinary content edits.
- **I-8 — `lease_ms` validation rejects non-numeric-looking input** (a boolean,
  an array, a non-numeric string) with a 400 instead of silently coercing it —
  `lease_ms: true` previously coerced to `1` and clamped UP to the shortest
  possible lease, the opposite of what a malformed request should do. An empty
  `?lease_ms=` is now treated as absent rather than rejected.

### Added
- **`KANBAN_MAX_CLAIMS_PER_AGENT`** (E-2): caps how many active claims one
  agent may hold at once (0/unset = unlimited, unchanged default). A claim past
  the cap gets `409 { reason: 'claim_limit' }`. Privileged roles are exempt.
  `store.claimTask` now threads the authenticated `caller` through to
  `applyClaim` (previously silently dropped) so the cap-exemption check works
  the same way for `POST /:id/claim` as it already did for `next-claim`.
- **`last_progress_at`** (E-1): a new persisted field, set only by a write that
  targets that specific card (claim, log, PATCH) — never by a sibling-lease
  renewal. Answers "is this card actually moving" as a question distinct from
  "is the lease alive", which holder-write renewal otherwise conflates. Not
  yet surfaced in the UI or `/api/metrics` — see Follow-ups.

### Changed
- `renewAllLeases` (the bulk-heartbeat store function) now reuses
  `renewAllLeasesInner` instead of a duplicated copy of the same loop (C-2).
- `server/routes/agents.js` resolves its project scope through the shared
  `rawProjectScope` helper instead of re-implementing it inline (C-3).

### Follow-ups (reviewed, deliberately deferred)
- **E-3** — `assignTask` (operator assignment) does not yet accept `lease_ms`.
- **E-4** — the browser `useClaimCoordinator` hook still heartbeats one card at
  a time instead of adopting the bulk endpoint; its cancellation/lost-lease
  handling is delicate enough that this needs its own dedicated pass rather
  than folding into this fix.
- **E-5** — claim/next-claim responses don't yet report whether a requested
  `lease_ms` was clamped.
- `store.renewLease`'s non-holder check (`POST /:id/heartbeat`) still reads
  the self-asserted role header, the same pattern fixed in I-4 for the bulk
  endpoint — it predates v2.12.0 and is out of scope for this pass.
- `last_progress_at` has no UI treatment yet (a "no progress for Xm" hint).

### Quality gates
Server suite: 447 tests (67 suites) — 14 new tests in
`server/test/kanban.leasewindow2.test.js` covering I-1 through I-8 and E-1/E-2,
plus two `kanban.leasewindow.test.js` assertions updated for the new (correct)
unpinned-default and project-scope-required behavior. Client suite unchanged
(120 tests; no client logic changed beyond an additive `last_progress_at` type).

## [2.12.0] — 2026-09-25

Lease-window root-cause fix. Claimed tasks were being reclaimed to BACKLOG as
false alarms because (RC-1) every lease window was pinned to the one fixed global
TTL, and (RC-2) renewal was per-task, so an orchestrator holding N cards had to
make N heartbeat calls and any job longer than the TTL lost its lease.

### Added
- **Per-task lease windows.** `POST /api/tasks/:id/claim`, `/next-claim`, and
  `/:id/heartbeat` accept an optional `lease_ms`; the chosen window is persisted
  on the task as `claim_lease_ms` and every later renewal keeps it, so a 30-minute
  lease is no longer shrunk back to the 10-minute default by the next heartbeat.
  `KANBAN_MIN_LEASE_MS` (default 60000) and `KANBAN_MAX_LEASE_MS` (default
  7200000) clamp the request; a non-numeric/negative value is a 400.
- **Bulk lease renewal.** `POST /api/agents/:agent_id/heartbeat` renews EVERY
  active lease that agent holds in one call. A non-privileged caller may only
  heartbeat its own id (`403` otherwise); a privileged role may renew on another
  agent's behalf; `?project=` narrows the sweep. Lapsed leases are deliberately
  not revived.
- **Holder-write renews all.** A holder's `appendLog`, `patchTask`, or `applyClaim`
  also re-arms that holder's other leases (excluding the card just written), so
  ordinary progress keeps every held card alive. Disable with
  `KANBAN_HOLDER_WRITE_RENEWS_ALL` (default on).
- Notifier reclaim alerts gained a **Lease window** row.

### Changed
- `client/src/lib/claimCoordinator.ts` heartbeat scheduling now honours a task's
  own `claim_lease_ms`, falling back to the observed/configured window (stale
  300000 default corrected to 600000).

### Quality gates
Server suite: 433 tests (66 suites). Client suite: 120 tests. New coverage in
`server/test/kanban.leasewindow.test.js` (25 tests) plus `kanban.lease.test.js`
additions; the per-task window, bulk renewal, and holder-write gates were each
falsified (6/3/3 red) then restored byte-exact.

## [2.11.0] — 2026-09-25

### Added

- **Milestones / goals (opt-milestones).** Tasks carry an optional `milestone` grouping label.
  - `milestone` is a free-text label normalised by the shared `toMilestone()` helper in `server/task-identity.js` (a non-empty string is kept verbatim, everything else becomes `null`), settable at creation and via `PATCH` (so `{milestone: null}` clears it).
  - `GET /api/milestones` (project-scoped via `?project=`) rolls live cards up per goal as `{milestone, project, total, done, by_status, progress}` sorted by name. `client/src/components/Portfolio.tsx` renders a Milestones section and `TaskCard`/`TaskSheet` show a milestone chip.
- **Operator assignment (opt-operator-assignment).** A privileged caller can assign a task to a named agent, or release it, with `POST /api/tasks/:id/assign`.
  - Gate: `destructivePrivilege(caller)` → `403`; `404` for a missing task; the usual optimistic-concurrency guard.
  - Assign sets `assigned_agent` + a fresh lease and lifts a BACKLOG card to BUILDING (stamping `stage_owners.BUILDING`); `agent_id: null` releases the card back to BACKLOG; a non-string/blank id is a `400`. It appends an agent-log entry and persists before updating memory (KB-05). It deliberately bypasses the dependency gate and claim-contention check — an operator override is the point.
- **Outbound integration webhooks (opt-integration-hooks).** `server/webhooks.js` is a pure `store.onDiff` subscriber that POSTs a flat JSON envelope (`{event, kind, project, task_id, status, priority, milestone, actor, reason, timestamp}`) to every URL in `KANBAN_WEBHOOK_URLS`.
  - Optional HMAC-SHA256 signing (`KANBAN_WEBHOOK_SECRET`) sends `x-kanban-signature: sha256=<hex>`, `x-kanban-event` and `x-kanban-timestamp` headers. `KANBAN_WEBHOOK_EVENTS` filters by diff kind.
  - Delivery is fire-and-forget and fail-silent: a webhook outage is logged but never breaks a task mutation. No new dependency (global `fetch`).

### Changed

- `server/store.js` re-exports `toMilestone`; the `patchTask` allow-list and `serializeCard` carry `milestone`; `backfillLeaseFields` normalises it on read.

### Quality gates

- Server suite: **403 tests across 64 suites** (adds `kanban.optfeatures211.test.js`, 9 tests). Client suite: **120 tests** (adds the opt-features source-contract guard, 6 tests). Both new gates falsified and restored byte-exact.

## [2.10.0] — 2026-09-25

### Added

- **HMAC session tokens are now revocable (ENH-12).** Session tokens are stateless HMACs, so before this release a leaked or retired token stayed valid until its 24h expiry. Each token now carries a random `jti` (16 bytes hex) in its signed payload, and a new `POST /api/auth/revoke` endpoint lets the **holder** of a token revoke it immediately:
  - `server/sessionAuth.js` mints `jti` in `createSessionToken` (returned alongside `token`/`expiresAt`), checks a module-level `revoked` deny-list in `verifySessionToken` (an expired deny entry is pruned rather than rejected), and exposes `revokeSessionToken(token)`, `revokedSessionCount()`, `resetRevokedSessions()`.
  - `POST /api/auth/revoke` is auth-failure rate-limited, requires a valid session token (401 otherwise), and returns `{revoked: true, jti}` on success — or `400` for a legacy token that predates `jti` (those remain valid but irrevocable, preserving backwards compatibility).
  - Only the holder can revoke their own token; a static/project/admin token cannot be revoked this way (401).

### Changed

- **`server/store.js` split into focused modules (ENH-11).** The ~3.9k-line monolith is now a thin stateful core that re-exports from four new modules, so every existing importer keeps working unchanged:
  - `server/state-machine.js` — pure lifecycle: `STATUSES`, `VALID_STATUS_LIST`, `normalizeStatus`, `isValidStatus`, `VALID_TRANSITIONS`, `canTransition`, `canRoleTransition` (zero imports).
  - `server/task-identity.js` — `writeAtomic`, project/task id validation, `toBranch`, `defaultProjectName`, `normalizeProject`, `resolveProjectScope`, `gitRoot`, `jsonDataDir`, `backfillLeaseFields`.
  - `server/task-fields.js` — `PRIVILEGED_ROLE_SET`, `isPrivilegedRole`, `validatePriority`/`validateDependsOn`/`validateMetadata`, the length/byte caps, `priorityRank`.
  - `server/storage.js` — the `JsonStorage` and `GitYamlStorage` backends.
  - `store.js` re-exports every extracted symbol, so `store.X === module.X` identity holds (asserted by the new guard).

### Quality gates

- Server suite: **394 tests across 63 suites** (was 382/61; `kanban.revocation.test.js` +7, `kanban.modulesplit.test.js` +5).
- Client suite: **114 tests**. Both new server gates were falsified (revocation check neutralized → 2 red; a DONE→BUILDING transition added → 1 red) then restored byte-exact.

## [2.9.1] — 2026-09-25

### Fixed

- **Mobile layout: the board is usable on phone-width viewports.** An external review of the live board on iPhone/Safari found three rendering defects, all fixed:
  - **Header + filter chrome no longer crush the board (Issue 1, high).** Both the header (`App.tsx`) and the filter bar (`BoardFilters.tsx`) previously let every control free-wrap, producing ~10 chrome rows that left the board only ~150px tall. Below `md`/`sm` the secondary controls (agent id, token, help, Signal, theme, project picker, priority/assignee/sort, export, columns, metrics) now collapse behind a single `⋯` / `Filters` disclosure; only the title, the Board/Portfolio/About switch, the search box and the task count stay visible. Measured at 390px: chrome went **299px → 155px** and the board grew from 545px to **690px of an 844px viewport (~82%)**. Desktop is unchanged (controls inline, disclosure hidden from `md`).
  - **Column scroll-arrow buttons no longer overlap cards (Issue 2, medium).** The `‹ / ›` paging buttons were absolutely centred over the whole scroller and sat on top of card content in an `85vw` mobile column. They are now `hidden … md:flex`, so touch devices keep the native horizontal swipe + scroll-snap instead.
  - **Task-card IDs no longer collapse to 1–2 characters (Issue 3, medium).** The card header row now wraps and the badge group goes full-width on phones (`w-full … sm:w-auto`), so the id keeps a readable width (measured 285px for a real card id) instead of competing with the project/estimate/priority/status badges on one line.

### Added

- **Anonymous visit counter on the About page.** The hosted demo now shows a single visit count at the bottom of the About view (`client/src/lib/useVisitCount.ts`, counts the first page-view per browser session via the public `abacus.jasoncameron.dev` counter under its **own** namespace `agent-kanban.riazrahaman.com`). It is deliberately **not** per-visitor tracking: no cookies, no identifiers, no data beyond a counter. The About copy was updated to say so honestly — "local-first · headless-first · no accounts · no tracking · one anonymous counter" — replacing the previous absolute "zero telemetry" claim, and the FAQ answer was rewritten to match.

### Quality gates

- Server suite: **382 tests across 61 suites**, 0 fail. Client suite: **114 tests** (adds the mobile-disclosure / badge-stacking guards and the visit-counter guard). `npx tsc -b` clean; `vite build` clean; `make sec` clean; version lockstep (both manifests, both doc mirrors, this section) enforced by `kanban.version.test.js`.

## [2.9.0] — 2026-09-25

### Added

- **Persisted audit stream (ENH-04).** Set `KANBAN_AUDIT_LOG` truthy and every committed mutation appends one compact JSON line (`ts`, `kind`, `project`, `task_id`, `actor`, `reason` — never the whole task payload) to `<data-dir>/audit.jsonl`. New `GET /api/audit` reads it back newest-first with `limit` (capped 1000), `since`, `project` and `kind` filters, returning `{entries, count, enabled}`. Best-effort writes never break a mutation; reads are open like the other GETs.
- **Dependency auditing in CI (ENH-06).** The workflow now runs `npm audit --audit-level=high` for both server and client, and `.github/dependabot.yml` opens weekly npm + GitHub-Actions update PRs.
- **Browser smoke test (ENH-07).** `scripts/check-browser-smoke.mjs` seeds a worst-case fixture project (long unicode title, an unbreakable long id, many log entries) and drives a real headless Chrome over CDP to assert the board renders with cards, no page-level horizontal overflow and zero uncaught page errors. Runs on the 22.x CI leg beside the card-layout guard; a missing browser is a skip, not a failure.
- **Generated configuration reference (ENH-10).** `scripts/gen-config-reference.mjs` scans the source for `process.env.KANBAN_*` (plus `PORT`/`HOST`/`VITE_*`), fails if any var lacks a description, and writes `docs/CONFIGURATION.md`. A tracked root `.env.example` lists every variable. `server/test/kanban.config.test.js` guards the docs + example against drift.

### Changed

- **Vite 5 → 7 (SEC-06).** `client` now builds on Vite `^7.3.6` + `@vitejs/plugin-react` `^5.2.0`, resolving the dev-server advisories (both `npm audit` runs are now clean).

### Quality gates

- Server suite: 382 tests across 61 suites (adds `kanban.audit.test.js` and `kanban.config.test.js`). Client suite: 107 tests. `tsc -b`, `vite build`, `make sec`, the version test and the doc-mirror/table checks are green.

## [2.8.0] — 2026-09-25

### Changed

- **Diff events are now the default SSE mode (PERF-01).** `GET /api/events` previously re-sent the entire board on every mutation (a full snapshot per change — ~18 MB per event at 3000 tasks). It now streams per-task `task.<kind>` diff events by default; `?mode=snapshot` selects the legacy whole-board path and `?mode=diff` remains a no-op alias. A priming `event: tasks` snapshot is sent only when `?prime=1` (the client primes from its own `GET /api/tasks`). The `event: settings` stream now rides the same connection in **both** modes, so the client opens a single stream instead of two.
- **Client subscribes once, applies events locally.** `client/src/App.tsx` replaces `subscribeToEvents` + `subscribeToSettings` with a single `subscribeToBoard(applyDiff, applySettings)`: `applyDiff` upserts the local `tasks` array by `(project, id)` and drops a row on `removed`/`archived`, instead of replacing the whole array.

### Added

- **Optional append-only journal for JSON storage (PERF-02).** Set `KANBAN_STORAGE_JOURNAL=1` to append each mutation as a single line to `<partition>.journal.jsonl` instead of rewriting the whole project partition; the journal is replayed on load and compacted into the canonical file once it exceeds `KANBAN_JOURNAL_COMPACT_BYTES` (default 1 MB). Off by default — with the flag unset the on-disk layout is byte-identical to before.
- **Bounded inline logs/comments with sidecar spill (ENH-08).** `agent_logs` and `comments` now keep at most the newest `KANBAN_INLINE_LOG_CAP` / `KANBAN_INLINE_COMMENT_CAP` entries (default 50 each; `0` disables) inline, spilling older overflow to a per-task JSONL sidecar under `spill/<project>/`. A new `GET /api/tasks/:id/logs` returns `{inline, spilled_count, entries}` with `?offset=`/`?limit=`/`?include_spilled=1` paging.

### Quality gates

- Server suite: **371 tests** across **59 suites** (was 354/56; adds `kanban.performance280.test.js`, 17 tests).
- Client suite: **107 tests**; `tsc -b` and the production Vite build are clean.
- All three fixes falsified (neutralised → tests red → restored byte-exact).

## [2.7.0] — 2026-09-25

### Fixed

- **A project named `archive` is no longer invisible (BUG-06).** `listGitProjects` skipped any top-level directory literally named `archive`, which made a real git-backed project with that id vanish after a restart. The skip is removed; the archive sink never held a direct card file, so it is still excluded by the per-directory `.yml` check.
- **Dependency cycles and self-references are rejected (BUG-08).** `createTask` and `PATCH /api/tasks/:id` accepted a `depends_on` that referenced the task itself or closed a cycle, which could leave tasks permanently unclaimable. A depth-capped DFS now rejects self-references and transitive cycles with a 400 (dangling dependencies are still allowed — they simply never satisfy the gate).
- **A failed port bind no longer crashes the process (IMPL-01).** `startServer` attaches a `server.on('error')` handler, so `EADDRINUSE`/`EADDRNOTAVAIL` is logged and the boot promise rejects cleanly instead of surfacing as an unhandled `'error'` event and a restart loop.
- **Telegram alerts keep their critical rows under truncation (BUG-10).** A reclaim alert longer than Telegram's 4096-character limit previously had its tail chopped, dropping the reason, the holder, and the board deep link. The formatter now drops low-value rows first, protects the reason/holder rows, and always appends the board link last.

### Changed

- **Stale cross-repo storage fallback removed (IMPL-02).** `gitRoot()` and `jsonDataDir()` no longer default to a sibling `../../agent-based-investment/ops/kanban` path; unset `KANBAN_GIT_DIR`/`KANBAN_DATA_DIR` now resolve to an in-repo `server/data` with a one-time warning, so an unconfigured instance can never write into (or read from) another checkout.
- **Readiness endpoint added and wired into the deploy blueprint (ENH-05).** `GET /api/health/ready` returns 200 `{ready:true}` once the store is loaded and 503 otherwise; `render.yaml` now health-checks that path, so a platform won't route traffic to an instance that has not finished loading its store.
- **Deploy CORS origin now carries a scheme (BUG-11).** `render.yaml` references `RENDER_EXTERNAL_URL` rather than the bare `RENDER_EXTERNAL_HOSTNAME`, and `configureCors` normalises a scheme-less origin by prefixing `https://`; the `*`/empty rejections run against the raw value first.

### Quality gates

- Server suite: **354 tests across 56 suites** (adds `kanban.robustness270.test.js`, 25 tests; IPv6-less hosts skip the bind test instead of failing).
- Client suite: 107 tests. `tsc -b`, `vite build`, `make sec`, the version lockstep guard, and the doc-mirror parity check all pass.

## [2.6.0] — 2026-09-25

### Fixed

- **Empty or unrecognized purge filter no longer wipes the board (BUG-07).** `POST /api/tasks/purge` with `{filter:{}}` or a filter object containing only unrecognized keys previously matched every task in scope — an accidental "delete all". A filter must now include at least one recognized key (`status`, `project`, `assigned_agent`, `older_than_days`) or the request is a 400.
- **HMAC session proof is bound to role and project (SEC-03).** `POST /api/auth/session` previously verified the proof over the client nonce alone, so one captured proof could be replayed to mint a session for any role or project. The proof input is now `client_nonce:role:project`; role (403) and project are resolved before the proof check, so a proof minted for `(builder, alpha)` cannot be reused as `(admin, alpha)` or `(builder, beta)`.
- **Concurrent SSE streams are capped (SEC-05).** `/api/events` had no upper bound on long-lived streams. A module-level counter now caps concurrent connections via `KANBAN_MAX_SSE_STREAMS` (default 100; negative disables). Over-cap requests receive a 503 before any SSE headers are written.
- **Auth failures are rate-limited (ENH-09).** Failed authentication (401/403) on the mutation middleware and on the `/api/auth/session` + `/api/auth/stream-ticket` handshakes is now throttled per client IP via `KANBAN_AUTH_RATE_LIMIT_PER_MIN` (falls back to `KANBAN_RATE_LIMIT_PER_MIN`; inert when both are unset → existing deployments unaffected). Exceeding the budget returns 429 with `retry_after_ms`.
- **Log and comment inputs are validated.** `appendLog` and `addComment` now reject a non-string or whitespace-only `message` / `agent_id` with a 400 instead of silently storing an empty string.

### Changed

- **Constant-time token comparison consolidated (SEC-07).** The four per-module `tokensMatch` copies early-returned on length mismatch, leaking the secret's length. They are replaced by one shared `server/utils/constantTime.js` that folds the length difference into the accumulator and always iterates the longer input. `auth.js` re-exports it so existing importers are unchanged.

### Quality gates

- Server suite: **329 tests across 49 suites**, 0 failures (`node --test`).
- Client suite: **107 tests**, 0 failures; `tsc -b` + `vite build` clean.
- All four new guards falsified (each gate neutralized → its tests red → restored byte-exact).

## [2.5.10] — 2026-09-25

### Changed

- **About-page tour screenshots refreshed to the v2.5.9 board.** The six `client/public/landing/` shots dated from v2.5.0 (Sep 24) and no longer matched the product: the mobile shot still showed the pre-2.5.9 clipped toolbar (controls cut off after "All Assignees"), and none showed the reachable toolbar, the estimate chips, the custom column colours or the comment thread. All six were recaptured against a v2.5.9 build — board, project picker, task sheet (now with a two-entry comment thread), portfolio, dark theme, and a mobile shot that shows the fixed toolbar. No code changed.

### Quality gates

Server suite: 300 tests across 43 suites. Client suite: 107 tests. `tsc -b`, `vite build`, `make sec`, the version lockstep test and the doc-mirror parity check all pass.

## [2.5.9] — 2026-09-25

### Fixed

- **Mobile: the filter toolbar controls were unreachable on a phone.** At a 390px viewport the toolbar's inner control group (`Sort`, `Export`, column colours, `Metrics`) laid out 720px wide, did not wrap, and was clipped by the parent `overflow-hidden` board column. `elementFromPoint` at each control's centre returned `null`, so the controls could not be tapped at all — the board looked functional but those four controls were dead. Each of them was below the fold of a horizontally-scrolling row with nothing to scroll it, which is why the screenshot showed a toolbar that simply stopped after "All Assignees". The control group is now allowed to shrink (`min-w-0`) and wrap, selects clamp to `max-w-full`, and the toolbar is usable at every width from 360px up.
- **Mobile: the header consumed a fifth of the viewport.** The header wrapped to four rows (158px on a 390x844 phone) with a trailing row holding only the theme toggle. Padding and row gaps are tightened on phones (`py-2`, `gap-y-1.5`), the title scales down (`text-base sm:text-lg`), and narrower phone input widths let the theme toggle join the input row. The header now folds to ~118px on a 390px phone (and 49px on desktop, unchanged).
- **Tap targets in the toolbar and header were below the 30px touch floor.** Every bordered toolbar control and header button/input now carries `py-1.5` on phones (≥30px tall) while `sm:py-1` preserves the denser desktop rhythm.

### Added

- `client/src/lib/mobileToolbar.test.mjs` — a 5-test source-contract guard asserting the shrink-and-wrap contract (no rigid non-shrinking control row, `min-w-0` + `flex-wrap` on the control group and root, `py-1.5` touch padding on every bordered control, `max-w-full` on each select, compact header rhythm + scaled title). All five assertions were falsified against the pre-fix code before being accepted.

### Quality gates

Server suite: 300 tests across 43 suites. Client suite: 107 tests. `tsc -b`, `vite build`, `make sec`, the version lockstep test and the doc-mirror parity check all pass.

## [2.5.8] — 2026-09-24

### Fixed

- **BUG-03 — `createTask` was a side door around the claim contract.** Any token holder could create a task directly in `BUILDING`, `IN_REVIEW`, `IN_TEST` or `DONE`, skipping the role gate, the dependency gate and the entire claim/lease lifecycle — fabricating completed work or floating work nobody owned. Creating a task in one of those work states now requires a privileged credential (`403` otherwise). `BACKLOG` (the normal create status) and `BLOCKED` (a parking state and a bulk-import target) stay open to unprivileged creation.
- **BUG-04 — caller-supplied `assigned_agent` produced unclaimable orphans.** `createTask` took `assigned_agent` straight from the body and never joined it to a lease, so a `BACKLOG` card could look assigned while the contention check rejected every real claimer with `409` forever. Ownership is now written **only** by `POST /claim`; a body-supplied owner is ignored at create.
- **SEC-04 — forgeable audit provenance at create.** `stage_owners`, `agent_logs` and `comments` were accepted verbatim from the create body, letting a caller fabricate a review history for work nobody did. They now always start empty and are written only by real transitions and real endpoints.
- **BUG-05 — unbounded / silently-coerced create fields.** `depends_on` as a bare string was silently dropped to `[]`; a non-object `metadata` was silently swallowed into `{}`; a 90 000-character title was accepted. `depends_on` must now be an array of non-empty task ids, `metadata` a plain object of at most 8 000 bytes, and `title`/`description` are capped at 200 / 20 000 characters. The same shape rules apply on `PATCH`.

### Changed

- `store.createTask(data, project, { caller })` now takes the authenticated caller; the `POST /api/tasks` route threads `req.caller` through so the status privilege check is derived from the credential (not a client-asserted role header).

### Quality gates

- Server suite: **300 tests across 43 suites** (adds `kanban.createinput.test.js`, 14 tests). Client suite: 102 tests. Each of the four new gates was falsified (neutralized → tests red → restored byte-exact) before release.

## [2.5.7] — 2026-09-24

### Added

- **Optional read authentication (ENH-01).** `KANBAN_READ_AUTH=token` now gates every read (GET + SSE) behind a credential; unset/empty/`off`/`0`/`false` keeps reads open, so existing deployments are unchanged. When enabled, a read must present either the usual bearer token or a short-lived stream ticket. Liveness probes (`/api/health`, `/healthz`) stay open for platform healthchecks and the client's version chip.
- **Single-use stream tickets for `EventSource`.** `EventSource` cannot set request headers (and the long-lived token must never go in a URL), so a new `POST /api/auth/stream-ticket` (token-gated) mints a 60-second, single-use HMAC ticket bound to a role + project. The SSE client presents it as `?ticket=` and re-mints on every (re)connect; a ticket's `jti` is recorded at mint time and deleted on first verification, so a replayed or leaked ticket is inert. Signed with `KANBAN_AUTH_SECRET` when set, else the global `KANBAN_AUTH_TOKEN`.
- **Client support.** Read fetches now send the stored bearer token, and `subscribeToEvents`/`subscribeToSettings`/`subscribeToDiffs` mint a ticket before opening their `EventSource`.

### Quality gates

Server suite: 286 tests across 43 suites, 0 failures (new `kanban.readauth.test.js`: 8 tests covering open-by-default reads, gated reads, the always-open health probe, ticket issuance, single-use consumption, gated-vs-open SSE, ticket-bound bookkeeping and flag parsing; read gate falsified by neutralizing it — 3 red — then restored byte-exact). Client suite: 102. `tsc -b`, `vite build`, `make sec`, version lockstep, doc-mirror parity and markdown-table checks all green.

## [2.5.6] — 2026-09-24

### Added

- **Soft-delete trash sink + restore (ENH-03).** `DELETE /api/tasks/:id` and the default `POST /api/tasks/purge` no longer destroy data — they park the task (stamped `deleted_at`/`deleted_by`, version bumped) in a per-project `trash/` sink beside the archive, on both the JSON and git backends (git cards are parked as plain untracked YAML under `<root>/trash/<project>/` so history stays clean). New endpoints: `GET /api/tasks/trash` (lists the sink, project-scoped), `POST /api/tasks/trash/:id/restore` (returns the card to BACKLOG with owner/lease/stage-owners cleared, a `restored_at` stamp, an agent-log entry, and a fresh claimable state), and `DELETE /api/tasks/trash/:id` (admin-only permanent removal from the sink).
- **True permanent purge preserved.** `POST /api/tasks/purge` with `{ "hard": true }` bypasses the sink for irreversible deletion.
- **Retention sweep.** `KANBAN_TRASH_DAYS` (default 30; 0/negative disables) hard-deletes sink rows older than the window, anchored on `deleted_at || updated || created_at`; the sweep runs on the existing archive-sweep cadence (GET /tasks, /archive, /metrics all sweep first) and trash survives service restarts via `loadStore()`. A trash row whose id collides with a live card cannot be restored (409).

### Quality gates

Server suite: 278 tests across 42 suites, 0 failures (new `kanban.trash.test.js`: 8 tests covering soft-delete parking, restore, project scoping, restore-conflict, hard delete, hard purge, restart persistence and retention off-switch; restore path falsified by stubbing then restored byte-exact). Client suite: 102. `tsc -b`, `vite build`, `make sec`, version lockstep, doc-mirror parity and markdown-table checks all green.

## [2.5.5] — 2026-09-24

### Added

- **Backups wired into the deploy blueprint (ENH-02).** `render.yaml` now sets `KANBAN_BACKUP_ENABLED=1`, `KANBAN_BACKUP_INTERVAL_MS=600000` (10 min) and `KANBAN_BACKUP_KEEP=10` so the Render deployment snapshots `/data` on a schedule (Railway users set the same three variables in the dashboard — `railway.json` cannot declare env vars).
- **Backup status in `GET /api/health`** — a new `backup` block reports `{enabled, running, interval_ms, keep, backup_root, backup_count, last_backup_at}` so operators can see at a glance whether snapshots are being taken and how fresh the newest one is.
- **Restore tooling + runbook** — new `scripts/restore-backup.mjs` (`<snapshot-dir> --into <data-dir> [--dry-run]`) copies a snapshot over the data tree (refusing empty/missing snapshots), and `docs/RESTORE.md` documents the full procedure: verify via the health `backup` block, copy snapshots off the volume nightly (same-volume snapshots protect against corruption, not volume loss), restore with the script, restart, verify.

### Quality gates

Server suite: 270 tests across 41 suites, 0 failures (adds backup-status and health-backup-block coverage to the existing backup suite). Client suite: 102. `tsc -b`, `vite build`, `make sec`, version lockstep, doc-mirror parity and markdown-table checks all green.

## [2.5.4] — 2026-09-24

### Fixed

- **Field-type validation on create and patch (BUG-02, external review).** `createTask` accepted a non-string `title` (silently HTML-escaped into an empty string) and a non-string `priority` (stored verbatim) — the stored shape crashed the board's `filterTasks` client helper (`toLowerCase` on a non-string) and blanked the whole board above the ErrorBoundary. Both write paths now validate: `title` must be a non-empty string, `description` a string, and `priority` one of `low|medium|high` (case-insensitive, normalised to lowercase; absent defaults to `medium`). Violations return `400` with an explicit message. New suite `server/test/kanban.fieldtypes.test.js` (10 tests), falsified by neutralising the guards (4 tests red) and restoring byte-exact.

### Quality gates

- Server suite: 268 tests across 41 suites, 0 fail (adds 10 tests).
- Client suite: 102 tests, 0 fail (unchanged).
- `tsc -b`, `vite build`, `make sec`, banned-pattern grep, version lockstep, mirror parity, markdown table integrity, and the version-bump guard all pass.

## [2.5.3] — 2026-09-24

### Changed

- **Dark theme matched to riazrahaman.com.** The dark palette is now a
  green-tinted charcoal (`--bg #1b211d`, `--surface #252d27`) with a brighter
  sage `--muted #b4beaf` (8.5:1 on bg, up from 5.84:1) and fully visible
  hairlines (`--line #445047`, previously an alpha-white that read as
  invisible). Semantic state tokens (up/down/warn/block/live/test) are
  unchanged and all clear WCAG AA on the new surface tones. The two sites now
  read as one product family in dark mode.

### Quality gates

- Server suite: 258 tests across 41 suites, 0 fail (unchanged).
- Client suite: 102 tests, 0 fail; `tsc -b` clean; production build clean.

## [2.5.2] — 2026-09-24

### Fixed

- **SEC-01 — purge cross-project scope bypass.** `purgeTasks` clamps its scope
  to the caller's authorized project: an unscoped purge now only reaches the
  default project (previously it swept EVERY project), and a `filter.project`
  that disagrees with the `?project=` scope is rejected with 403 rather than
  silently widening the blast radius. `deleteTask` gained the same scope clamp
  (defense-in-depth per the Reviewer) so a composite `project:id` path segment
  cannot address another project's card.
- **SEC-02 — destructive ops no longer trust the asserted role.** The
  `X-Agent-Role` header is caller-declared; any token holder could previously
  self-declare `admin` and purge everything. Destructive operations (task
  delete / bulk purge) now require `caller.privileged`, which the auth
  middleware derives from the **credential**: the `KANBAN_ADMIN_TOKEN` bearer
  or a session token whose server-issued role is privileged. Per-project
  tokens are by-convention worker credentials (functional roles such as
  builder/reviewer/tester stay assertable; privileged ops do not). Legacy
  single-token deployments keep their historical semantics unchanged.
- **BUG-01 — corrupt data file could be wiped.** `JsonStorage.load()` now
  fails closed: an existing but corrupt/unparseable data file makes
  `loadStore()` throw and `startServer` refuse to boot (the file is preserved
  for recovery), instead of starting empty and letting the next save overwrite
  the board. An absent file still boots normally as an empty board. The git
  backend's directory-level load failure also refuses boot now; per-card
  corruption is still skipped with a warning (git files are independent).

### Added

- 3 new purge/delete scope + privilege tests (`kanban.purge.test.js`) and a
  new `kanban.corruptfile.test.js` suite (5 tests) covering the fail-closed
  load behavior on both the JSON and git backends.

### Removed

- **Advisory WIP capacity badges** (the client-side `n/3` per-column limit
  guard shipped in v2.4.0). They were advisory-only (never server-enforced)
  and misread as a hard constraint; column headers now show the plain task
  count. Server behavior is unchanged.

### Quality gates

- Server suite: 258 tests across 41 suites, 0 fail (adds 8 tests; both new
  gates falsified and restored byte-exact). Client suite: 102 tests, 0 fail.
- `tsc -b` clean, `vite build` clean, `make sec` clean, banned-pattern grep
  clean, release-version guard 5/5, doc mirror parity IDENTICAL ×3.

## [2.5.1] — 2026-09-24

### Changed

- **About-page tour screenshots refreshed.** The six `/landing/*.png` screenshots in the in-app
  About view were still v2.2.0-era captures; they are re-taken against a seeded v2.5.0 board so
  they now show the filter/sort/export toolbar, priority badges, effort chips, WIP capacity
  badges, stage step numbers, the distinct violet IN_TEST accent, a custom BUILDING accent,
  the task sheet's comment thread, and both themes plus the 390px mobile layout. The board and
  task-sheet `TOUR_SHOTS` alt/caption text in `client/src/lib/aboutContent.ts` were updated to
  describe the new features.

### Quality gates

- Server suite: 250 tests / 39 suites (unchanged — no runtime code touched). Client suite:
  102 tests. `tsc -b` clean; `vite build` clean; mirror parity identical; tables clean.

## [2.5.0] — 2026-09-24

### Added

- **Custom column colors (per-project, server-persisted).** A new display-settings store
  (`/api/settings`, GET public / PUT token-gated) persists a per-project `column_colors`
  override, resolved as stock -> board default -> project override. The palette reuses the
  design system's 8 accent tokens (muted/live/warn/test/fail/pass/block/line) — raw hex never
  crosses the wire, so every choice keeps validated WCAG contrast. Both storage backends
  round-trip settings (JSON sibling file / git `settings.yml`). A "Columns" control in the
  filter toolbar opens a swatch popover with per-column picks and Reset-to-defaults; the SSE
  stream gained an `event: settings` push so an operator's save applies live in every open
  browser.
- **Task comments / discussion thread.** A new `comments[]` field on every task, written only
  through `POST /api/tasks/:id/comments` (mirrors `/logs`: agent_id + message required, §2.6 CAS
  guard, escapeHtml on write, one version bump, KB-05 persist-first). Deliberately separate from
  `agent_logs` — the machine audit trail stays clean. The task sheet now renders a Comments
  thread (oldest-first, entities decoded for display) with its own composer that shares the
  sheet's single Agent ID field. Comments are defaulted to `[]` on read for legacy records and
  round-trip through git cards.

### Changed

- README roadmap: items 1 (Ticket Details Panel) and 3 (Custom Column Colors) are now shipped
  and removed from the roadmap; the remaining opt-* backlog cards stay tracked.

### Quality gates

- Server suite: 250 tests across 39 suites (adds `kanban.comments.test.js` 7 tests and
  `kanban.settings.test.js` 9 tests, both falsified).
- Client suite: 102 tests (adds the column-colors contract, 8 tests).
- `tsc -b` clean, `vite build` clean, `make sec` clean, banned-pattern grep clean,
  version lockstep 5/5, mirror parity 3× identical, markdown tables clean.

## [2.4.0] — 2026-09-24

### Added

- **Search Bar & Quick Filters (`client/src/components/BoardFilters.tsx`, `client/src/lib/filterTasks.ts`)**:
  - Live substring search matching across task titles, IDs, descriptions, and branch names with instant filtering.
  - Multi-criteria quick filters: priority filter (`high`, `medium`, `low`), dynamic assignee selector populated from active/held tasks, and instant `Reset` action.
- **Work-In-Progress (WIP) Capacity Limits & Effort Sizing (`client/src/components/Column.tsx`, `client/src/components/TaskCard.tsx`)**:
  - Configurable WIP capacity limits on active columns (`BUILDING` cap 3, `IN_REVIEW` cap 3) with warning badges and limit violation banners.
  - Sizing & effort indicator badge (`⚡ <estimate>`) dynamically rendered from task metadata (`estimate`, `points`, `size`).
- **High-Impact Ticket Prioritisation & Clear Status Workflow Labels**:
  - Prominent high-priority card right-accent (`border-r-2 border-r-fail`) and priority badge chips.
  - Numbered workflow steps (`01 Backlog`, `02 Building`, `03 In Review`, `04 In Test`) for transparent visual flow.
- **Live Metrics Dashboard Summary (`client/src/components/MetricsDashboard.tsx`, `client/src/lib/dashboardMetrics.ts`)**:
  - Toggleable summary dashboard banner showing Total Tickets, Backlog, In-Flight WIP, Blocked, Completed, Average Cycle Time (derived from completed work), and Overdue/Stalled active tasks exceeding the freshness threshold.
  - The dashboard always summarises the WHOLE board scope — it is deliberately fed the unfiltered task list, so totals stay stable while filters narrow the board.
- **JSON Export (`client/src/App.tsx`, `client/src/components/BoardFilters.tsx`)**:
  - One-click JSON export with ISO datestamp for backing up and sharing board task states. (A paired import was considered and dropped: a browser-side merge into local state was invisible to the server and silently discarded by the next SSE snapshot — export remains, import awaits a server-backed design.)
- **In-Column Sorting (`client/src/lib/boardSort.ts`)**:
  - Explicit column-ordering control (`Sort: Priority | Recently Updated | Task ID`), persisted per browser (`localStorage kanban.sort`) and re-applied on every SSE snapshot. Priority sort ranks high → medium → low and keeps the server's recency order within a rank (stable sort); ties never jump.
  - This replaces the first-draft ▲/▼ move controls, which mutated only local state and were silently wiped by the next live update.
- **Double-Click Inline Title Editing**:
  - Instant inline title editing directly on cards with Enter/Blur persistence and Escape cancellation, backed by optimistic CAS version verification.
- **Distinct verification-stage colour (IN_TEST)**:
  - New `--test`/`--test-bg` violet token pair (light + dark, WCAG AA); `IN_TEST` cards now use the violet left-stripe and badge and the In Test column a violet top accent — previously `BUILDING` and `IN_TEST` shared the identical blue treatment and were indistinguishable at a glance.

### Quality gates

- Server suite: 234 tests across 37 suites, 0 fail. Client suite: 94 tests, 0 fail (adds `boardSort.test.mjs`, 8 tests; trust metrics self-check keeps the About page counts in lockstep with the real suite sizes).
- `tsc -b` clean; production bundle builds clean; `make sec` clean; visual-contract grep clean; version lockstep guard 5/5; `check-version-bump.sh` exit 0 (2.3.13 → 2.4.0); docs mirrors prose-identical; markdown tables clean.
- Future enhancements from the original recommendations file (Ticket Details Panel comments, operator assignment, custom column colours, milestones, integration hooks) are recorded in the README **Roadmap** section and as `opt-*` backlog cards on the live board; the two root handover files were removed.

## [2.3.13] — 2026-09-24

### Fixed

- **Legacy dirty `branch` values are now normalised on READ paths (issue #30).**
  The write paths (serializeCard / createTask / patchTask) all normalise `branch`
  through the shared `toBranch()` normaliser, but `backfillLeaseFields()` — the hook
  every storage backend's load path runs — normalised only `version`,
  `claim_expires_at` and `reclaim_count`. A legacy record with a dirty branch
  (`""`, whitespace-only, or a non-string) therefore re-emerged verbatim in every
  API response and, on the git backend, was re-serialised onto cards from memory on
  every save — so read and write disagreed forever. `backfillLeaseFields()` now
  applies the same normaliser on read: a usable string is kept verbatim (padding
  and all), everything else becomes `null`, and an absent key stays absent. The
  git-backend memory-vs-card divergence disappears with the same change, since
  cards re-serialise from the normalised memory value.

### Changed

- **Documentation sync.** Removed a stale out-of-order `## [Unreleased]` section from
  this changelog (the version-bump guard it described shipped inside v2.3.7);
  corrected stale test counts in `docs/PRESENTATION_NOTES.md` and the standalone
  one-pager (server 222 → **234**, client 68 → **77**; one-pager badge → v2.3.13).

### Quality gates

- Server suite **234 tests / 37 suites / 0 fail** (the branch suite gains 4 read-path
  normalisation tests, including the git-YAML card round-trip; falsified by
  neutralising the backfill normaliser — the suite went red and was restored
  byte-exact); client suite **77 tests / 0 fail** (About trust-metric guard now
  asserts 234); `tsc -b` and the production build clean.

## [2.3.12] — 2026-09-24

### Fixed

- **`PATCH` was a side door around the dependency gate.** `claimTask` and
  `nextClaim` refuse to start a task whose `depends_on` is not fully `DONE`
  (409 `dependency_unsatisfied`), but `patchTask` never checked the gate, so a
  caller could `PATCH {status:'BUILDING'}` a dependency-blocked card straight
  into an active stage — reaching a state the claim path would never grant.
  The transition is now gated inside `patchTask` for every move INTO an active
  stage (BUILDING / IN_REVIEW / IN_TEST), after the state-machine (409) and
  role (403) checks so those errors keep precedence, and the PATCH route
  forwards the same `reason` + `unresolved_dependencies` payload the claim
  route already emits. Transitions into DONE / BLOCKED / BACKLOG stay ungated:
  completion and unblocking are lock-internal moves, and a worker must never
  be trapped by its own dependency on the way out. Creating a task directly
  in an active stage remains deliberately ungated (the bulk-import path and
  the archive suite rely on it).

### Quality gates

- Server suite 230 tests / 37 suites / 0 fail (adds the KB-11b PATCH-gate
  describe: blocked PATCH 409 with the unresolved list, unblocked PATCH after
  the dependency is DONE, the ungated createTask path preserved, and the
  dep-free regression). Gate proven load-bearing by falsification — neutralising
  it turned exactly the blocked-PATCH test red. Client suite 77 / 0 fail.
  `make sec` clean; `tsc -b` and the production build clean.

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
