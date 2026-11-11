# AGENTS.md

Canonical agent guide for this repository. Read this file first, whatever
harness you run in - Claude Code, Codex CLI, Gemini CLI, opencode, Cursor, or a
custom loop runner. It is tool-neutral on purpose; `CLAUDE.md` is a short
pointer to it plus a few Claude-specific notes.

## What this is

Agent Kanban Board: a Kanban state dashboard for swarms of autonomous AI agents.
Agents claim tasks and move them through a state machine over an HTTP API;
humans watch live over SSE. Node/Express server (`server/`) + Vite/React 19/
Tailwind v4/TypeScript client (`client/`). The server also serves the built
client (`client/dist`) on the same origin.

## Commands

There is no root `npm install`; the server and client each have their own
manifest.

```bash
npm --prefix server install && npm --prefix client install
npm start                      # API + built SPA on http://localhost:4000 (needs `npm run build` first for the UI)
npm run build                  # tsc -b && vite build  -> client/dist
npm --prefix client run dev    # Vite on :5173, proxies /api (incl. SSE) to :4000
npm test                       # server tests + scripts/test-client-status.js + client tests + client build
make sec                       # CI security gate (see below)
```

Single tests (Node's built-in runner, no Jest/Vitest):

```bash
cd server && node --test test/kanban.lease.test.js
cd server && node --test --test-name-pattern="substring" test/kanban.lease.test.js
cd client && node --test src/lib/filterTasks.test.mjs
```

Client tests are `.test.mjs` files in `client/src/**`; most import `.ts` modules
or scan component source text (class names, CSS rules) as contract guards rather
than rendering. Server tests are `server/test/kanban.*.test.js`.

## CI and quality gates

CI (`.github/workflows`) runs, on Node 20 and 22: `scripts/check-version-bump.sh`,
`npm ci`, `npm audit --audit-level=high`, `make sec`, tests, build. `make sec`
fails on any tracked file containing a `/Users/<name>` or `/home/<name>` path and
on `dangerouslySetInnerHTML` in `client/src`, so never write absolute home paths
into tracked files - docs and this guide included.

Configuration is env-driven; the generated reference is
`docs/CONFIGURATION.md` (regenerate with `node scripts/gen-config-reference.mjs`).
Mutations need `KANBAN_AUTH_TOKEN` (or per-project `KANBAN_PROJECT_TOKENS` /
`KANBAN_ADMIN_TOKEN`); reads are open unless `KANBAN_READ_AUTH=token`. Since
v3.8.0 `KANBAN_PROJECT_TOKENS` credentials may be role-bound
(`{"token":"...","role":"builder"}`): the role is then forced server-side from
the credential, and a conflicting `X-Agent-Role` header is ignored and audited
(`role_binding_mismatch`). Every agent role needs its own token. Since v3.12.8 a
credential may also bind `agent_id`, and that bound identity wins over
`X-Agent-Id` and over any body `agent_id` (a conflict is audited as
`identity_binding_mismatch`).

## Architecture

**Server (`server/`, ESM, Express 5).**

- `store.js` is the store **facade**: the create/patch/claim state-machine walk,
  the dependency gate and the mutation lock use, re-exporting `server/store/*`.
  Since v3.12.5 the engine is split by responsibility. `store/core.js` is the
  single home of STATE (live `tasks`, composite index, archive/trash/settings
  sinks, mutation queue, storage factory, serials, read accessors);
  `store/listeners.js` owns the snapshot/diff/audit/settings buses behind
  `notify()`; `store/aggregates.js` the summaries/metrics caches;
  `store/leases.js` the clock, lease windows, reclaim path and reaper; and
  `store/archive.js` / `store/trash.js` / `store/backups.js` the sweeps.
  Extracted modules IMPORT that state (ESM live bindings); a module that must
  reassign goes through a named setter in `core.js`, never a second copy.
  `store.js` re-exports every moved symbol with its original identity, so import
  from either, and `kanban.modulesplit.test.js` pins the identities (including
  `store.writeAtomic === task-identity.writeAtomic`). Other pure pieces:
  `state-machine.js` (statuses, legal transitions, role ownership matrix; no
  I/O), `task-fields.js` (field validation + `callerIsPrivileged` /
  `destructivePrivilege`), `task-identity.js`, `storage.js` (`JsonStorage`
  atomic rename-writes with an optional journal; `GitYamlStorage` one YAML card
  per task with a git commit per transition), `version.js` (the one
  `APP_VERSION` reader for health/drift/ask/bug-report) and `logger.js`
  (structured `[kanban <scope>] key=value` records + the single `warnOnce`
  dedupe helper).
- Multi-project: every task has a `project`. The default project reuses the
  legacy file (`server/tasks.json` / `KANBAN_DATA_FILE`); named projects live
  under `KANBAN_DATA_DIR`. `middleware/projectScope.js` resolves `?project=`, the
  `X-Kanban-Project` header, or the `workspace_id` create alias.
- `server.js` wires routers in `routes/` (tasks, projects, metrics, audit,
  health, auth, settings, milestones, agents, plus the pre-auth `bugReports` and
  `ask`), middleware (`cors`, `auth`, `rateLimit`), the capped SSE stream
  (`/api/events`, single-use stream tickets in `streamTicket.js`),
  `notifier.js` (optional Telegram reclaim alerts), `webhooks.js`, and static
  serving of `client/dist`. `resolveHost` handles Railway's `HOST=[::]`.
- Concurrency model to preserve: optimistic locking (every PATCH carries the
  current `version` as `expected_version` / `If-Match`; two distinct 409s -
  "Version mismatch" vs claim contention / invalid transition), claim-first
  entry into active stages (`POST /claim` sets owner + lease; a status-only
  PATCH leaves an ownerless task that the reaper resets to READY), and lease
  heartbeats. Lifecycle (v3+, 8 states, `state-machine.js`):
  `BACKLOG -> READY -> PLANNING -> IN_PROGRESS -> IN_REVIEW -> VALIDATION ->
  READY_TO_SHIP -> DONE` plus `BLOCKED`; only `READY` cards can be claimed, and
  planner/builder/reviewer/tester/releaser roles gate transitions. Legacy v2
  names (`BUILDING`, `IN_TEST`) are still accepted and normalized by
  `normalizeStatus`. Behind a reverse proxy set `KANBAN_TRUST_PROXY`
  (`resolveTrustProxy` in `server.js`) or the auth-failure rate limiter sees the
  proxy IP.
- **Ask-the-Board (`routes/ask.js`, `askKnowledge.js`, client `lib/ask.ts`).**
  A read-only natural-language Q&A endpoint. Public by the board's token model
  but gated by a shared password (`x-ask-pass`) and mounted BEFORE auth and
  rate-limit, exactly like `/api/bug-reports`. `isEnabled` fails closed: the
  password is always required, and the `openrouter` provider additionally
  requires `KANBAN_ASK_OPENROUTER_API_KEY`. Two providers, resolved by
  `resolveProvider`: `openrouter` (default) and `ollama`, the latter
  auto-detected when `KANBAN_ASK_OLLAMA_HOST` is set without an OpenRouter key.
  Each has its own default model, and for Ollama `max_tokens` is omitted
  entirely unless `KANBAN_ASK_MAX_OUTPUT_TOKENS` is set, because a reasoning
  model otherwise stops mid-thought with `finish_reason: "length"`.
  `askKnowledge.js` builds the prompt from a hand-curated protocol summary,
  keyword-ranked source excerpts (`rankSourceFiles` + `excerptWindow`, centred
  on the question's keywords rather than the head of the file), and a live board
  snapshot assembled **in-process via store accessors, never over HTTP**:
  `isProbePath()` exempts only `/api/health` and `/healthz`, so scraping
  `/api/metrics` over HTTP would break under `KANBAN_READ_AUTH=token`.
  **Every outbound header value must be pure ASCII.** An HTTP header is a
  ByteString, and an em dash in a static `X-Title` constant made `fetch` throw
  before a packet left the process, silently breaking the feature across several
  releases while the logs showed no outbound connection at all;
  `kanban.ask.test.js` now runs the real `Headers`/`Request` validator over what
  the route builds, because every other test injects a fake `fetch` that skips
  validation. The API key, the password and the raw upstream response **body**
  are never logged or returned - only the upstream status and a hint keyed on
  it. `scripts/gateway/ollama-tunnel-gateway.js` is the token-verifying reverse
  proxy for reaching a local Ollama from the hosted board over a Cloudflare
  tunnel; `scripts/setup-ollama-persistent-tunnel.sh` sets up the alternative,
  a persistent Tailscale Funnel (v3.7.0). Either way
  `KANBAN_ASK_OLLAMA_AUTH_HEADER` carries the bearer.
- **Graceful shutdown (`registerShutdownHandlers`, `drainSseStreams`).** An SSE
  response never ends by design, and `server.close()` waits for every open
  connection - so on SIGTERM the order is **drain the SSE set -> `close()` ->
  `closeIdleConnections()`**, with `closeAllConnections()` only on an unref'd 1s
  backstop (calling it immediately would destroy in-flight requests and break
  the graceful contract). `kanban.shutdown.test.js` pins that exact ordering and
  asserts `closeAllConnections` is not synchronous.

**Client (`client/src/`).** `App.tsx` owns top-level state and the single
combined SSE `EventSource` (diff + settings). `api.ts` is the typed fetch layer
(`ConflictError` for version conflicts, auth headers from `lib/authToken`;
`subscribeToBoard` is the only SSE subscribe export - the pre-v2.13
`subscribeToEvents` / `subscribeToSettings` were deleted in v3.12.5). Pure logic
lives in `lib/*.ts` with sibling `.test.mjs` files (filtering, sorting, metrics,
claim coordination, column colors, theming, `aboutContent.ts`). Views: Board,
Portfolio, About; plus `TaskSheet`, `SignalRail`, `MetricsDashboard`. The About
page's shell is `components/About.tsx`; its article body and figures are
`client/src/about/*` (`ChapterBody`, `ArchitectureDiagram`, `Ask` hero + figure,
`VideoShowcase`, shared `primitives`), and the page-level source-contract tests
read all of them via `lib/aboutSources.mjs`.

**Design contract.** `DESIGN.md` is the source of truth (editorial-minimalist).
Machine-enforced bans across `client/src`: no `shadow-*`, no `rounded-full`
(DESIGN.md says "any radius" is off-system, but the test only matches
`rounded-full`), no Inter/Roboto, no person glyph U+1F464, and no Tailwind
border classes interpolated in template strings (invisible to the JIT scanner).
Responsive rules in `DESIGN.md` section 10 are guarded by `responsive.test.mjs`
and `mobileToolbar.test.mjs`. Touch ergonomics use `pointer: coarse` (Tailwind
`pointer-coarse:` variants plus one unlayered `@media (pointer: coarse)` font
rule in `index.css`), not width breakpoints, so mouse layouts at any width stay
dense.

## Release discipline (enforced by tests/CI)

Every user-visible change bumps the version (policy text: README "Releasing");
docs-only and test-only changes do not. A release must update, in lockstep:
`server/package.json` (the UI reads the version live from it via `/api/health`)
and root `package.json`; a new `## [x.y.z] - YYYY-MM-DD` section plus the tag
list at the top of `CHANGELOG.md`; the version headers in `docs/` and
`docs/with-images/`; and `skills/kanban/SKILL.md` frontmatter. After bumping,
run `npm --prefix server install --package-lock-only` so
`server/package-lock.json`'s own version fields match (they drifted in
2.16.0/2.16.1). Then an annotated tag `vX.Y.Z`, pushed only after CI is green on
main: Railway waits for CI, so a red CI leaves the tag undeployed (v2.16.0 was
never deployed for this reason). `kanban.version.test.js` checks internal
consistency; `check-version-bump.sh <base-ref>` compares against git history, so
it only sees *committed* changes.

`docs/PRESENTER_RUNBOOK.md` is the live-demo walkthrough,
`docs/presentation/index.html` is the same walkthrough as a single shareable
page (published as a Claude Artifact), and `docs/presentation/deck/` is the same
material as a 15-slide deck (`deck.json` + one HTML file per slide, presenter
notes in each slide's `<aside>`; built from the Artifact Slides type). All three
are **version-pinned by the same test** - the deck through the version its cover
footer renders - so a release must bump them too, and a change to one belongs in
the same commit as the others. The deck also carries its own update contract
(section 11 of the runbook): a change to the lifecycle, a launch/install command,
the skill's bootstrap, any `KANBAN_*` variable it uses, `.env.example`, an
endpoint or header in one of its `curl` blocks, an error code, or the `docs/`
inventory has to be reflected there in the same commit - people type its
commands verbatim in front of an audience.

The About page (`client/src/lib/aboutContent.ts`) hardcodes **both** test counts
in `TRUST_METRICS`, and `about.test.mjs` recounts them by regex over `it(` /
`test(` / `t.test(` declarations (not from runner output) and asserts equality.
So adding or removing a *server* test fails a *client* test until that number is
updated - surprising, but deliberate.

## Owner decisions (do not re-litigate)

- **2026-11-11 - Ask-the-Board board snapshot scope (A11, card study-a11-a7).**
  The Ask assistant is for the **owner**, and its password is an owner
  credential, so gathering the whole board snapshot by default is deliberate:
  the owner is entitled to the whole board.
  `KANBAN_ASK_SNAPSHOT_PROJECTS` remains an opt-in narrowing (fail-closed: an
  allow-list that matches nothing yields an empty snapshot rather than silently
  widening back to all). Do not re-file this as over-scoping. The same decision
  is recorded in `server/askKnowledge.js` above `gatherSnapshot()`.

## Skill distribution

`skills/kanban/` in this repo is the source of truth for the orchestration skill
(`SKILL.md` + `README.md`). Installed copies in harness skill directories - for
example `~/.config/opencode/skills/kanban-orchestrator/` or a Claude skill
directory - must be synced FROM this repo on release, never edited in place: an
edit there is lost on the next install and leaves the published skill and the
repo disagreeing. When the protocol changes, change `skills/kanban/SKILL.md`
here, bump its frontmatter version with the release, and re-sync the installed
copies.

## Workflow notes for this repo

- The real board is the hosted instance (API under `/api`, project `kanbann`),
  not a local server. A local server on `:8891` can be a stale process serving an
  old `client/dist`; `/api/health` shows the running version. The token goes in
  the gitignored `.opencode/config.json` (`kanban_token`) or `KANBAN_TOKEN`;
  never commit or print it. All task paths need `?project=<name>`; only
  `POST /tasks` takes `project` in the body.
- Work is orchestrated with the `riazrahaman__agentkanban` skill
  (`skills/kanban/SKILL.md` is its source): log tasks on the board, file GitHub
  issues, run the builder -> reviewer -> tester pipeline (the v3 stages are
  PLANNING/IN_PROGRESS -> IN_REVIEW -> VALIDATION -> READY_TO_SHIP; claim a
  READY card first), update docs/changelog/version, and verify the Railway
  deploy (`railway.json`; `render.yaml` is an alternative blueprint).
- **Agents may share this checkout.** A branch is not isolation here: `git add
  -A` from one agent captures another's uncommitted work and ships it under the
  wrong commit message. Stage explicit paths, and check `git status` for files
  you did not touch before committing.
- Never commit a real secret. `.env.example`, docs and README use placeholders
  or Cloudflare's published Turnstile test keys only; the real
  `KANBAN_REPORT_GITHUB_TOKEN` and `TURNSTILE_SECRET` live in Railway variables.
- Gitignored local tooling: `.opencode/`, `opencode.json`, `.claude/`,
  `skillport.lock`.
- Every new `KANBAN_*` / `TURNSTILE_*` variable has to be read as a **literal
  `process.env.KANBAN_X`** (see `readEnv()` in `routes/ask.js`) - the config
  generator and `kanban.config.test.js` discover variables by scanning for the
  name, so a computed or destructured lookup is invisible to them. Each one also
  needs a `DESCRIPTIONS` entry in `scripts/gen-config-reference.mjs` and an
  `.env.example` line, or the drift test fails.
- `docs/images/*.svg`, and the diagram embeds inside the three
  `docs/with-images/*.md` copies, are **generated** by
  `node scripts/generate-diagram-images.js` (renders via mermaid.ink over the
  network) from the matching `docs/*.md` sources - edit the source doc and
  regenerate rather than hand-editing a diagram or an embed. The release version
  header in those copies *is* bumped by hand, in step with the source (see
  Release discipline); only the three files keyed in `DIAGRAM_METADATA` are
  regenerated at all. The script pairs the **Nth mermaid block in a file with
  the Nth entry** of that file's `DIAGRAM_METADATA` array by position, so
  inserting a diagram mid-document silently relabels every one after it. A
  mermaid `Note` cannot contain a semicolon (it breaks the sequence parser with
  a 400).
- A test that spawns a **real** server must set both `KANBAN_DATA_FILE` and
  `KANBAN_DATA_DIR` - setting only the dir still loads the real
  `server/tasks.json`. For a spawned child, reserve a free port by letting the OS
  assign one (`net.createServer().listen(0)`, read the port, close) and pass
  that number in; a randomly picked port collides under the parallel suite.
- The About / Field Guide view (`components/About.tsx` + `client/src/about/*` +
  the `.about-*` rules in `index.css`) is a 13-chapter editorial page pinned hard
  by `aboutFieldGuide.test.mjs`: chapter count and order, the
  ELI5/under-the-hood/snippet/gotcha grammar, each chapter pointing at at least
  one file that really exists on disk, and the env table mirroring
  `docs/CONFIGURATION.md`. The CSS carries two couplings the tests also pin:
  `--guide-rail` must track the rail's `w-[13rem]` + `gap-10` in `About.tsx`, and
  `.about-rail { display: none }` must stay **above** its
  `@media (min-width: 80rem)` override (equal specificity, so a later rule would
  hide the rail at every width).
- Report-a-bug (v2.16.0+) is a public, unauthenticated route
  (`server/routes/bugReports.js`, Turnstile + GitHub issue) and touches several
  places at once: `server.js` mount order (must stay ahead of auth/rate-limit),
  `scripts/gen-config-reference.mjs` + `.env.example` (the config-variable rule
  above), `client/src/lib/bugReport.ts` (client limits must match the server's),
  and the `aboutContent.ts` test-count pair. Its entry points (v2.17.0+) are a
  small bug-icon button in the header, immediately beside the theme toggle, and
  the About page CTA; the earlier header "i" popover row (v2.16.0) and footer
  link (v2.16.3, `AppFooter.tsx`) were both removed. Since v3.2.2 the icon lives
  inside the `data-testid="header-controls"` group, which is `hidden` below `md`
  until the overflow toggle opens it (state persisted as `kanban.headerOpen`),
  so on a phone it is one tap deeper than the About CTA. The header icon shares
  a border with the theme toggle and claws back its own slice of the row's gap
  (`App.tsx`, `md:-ml-2`, applied only when it renders) specifically so the
  header height stays IDENTICAL with the feature on vs off at every width,
  guarded by `scripts/check-header-layout.mjs`. Real touch phones measure taller
  than a desktop window (`pointer: coarse` 44px targets), so check both.
  `BugReportDialog.tsx` also carries iOS/WebKit-specific defenses (v2.17.0)
  against a real-device overflow/zoom/bottom-toolbar-clipping report:
  `overflow-x-hidden` / `max-w-[100vw]` on the sheet plus horizontal clipping at
  the document root (`index.css`: `overflow: hidden` on html/body outside the
  phone layout, `overflow-x: hidden` / `clip` in it), `inert` when closed,
  `100dvh`, Turnstile `size: 'flexible'`, and a submit button pinned outside the
  scrollable body with safe-area bottom padding - Playwright WebKit (desktop
  engine) does not reproduce the underlying iOS chrome behaviour, so these fixes
  are defensive and unverified-by-repro in that environment.
- Mobile verification: do not use headless Chrome `--window-size` (it enforces a
  minimum width and produces false "clipped" layouts). Use real emulation (for
  example playwright-core with `isMobile` + `hasTouch`) and check `scrollWidth`,
  control heights (>=44px) and input font size (>=16px).
- Mobile shell (v3.2.2+): `client/index.html` sets
  `maximum-scale=1.0, user-scalable=no`, but iOS Safari has NOT honoured that
  since ~iOS 10 (the real pinch blocks are the touch-action rule and the JS
  guard below; the meta tag only matters for other engines, and blocking zoom is
  a known accessibility trade-off). Light/dark `theme-color` metas are synced by
  the pre-paint script, and `html, body` carry the theme background so Safari's
  translucent bars show it. Below `md` the header's secondary controls (project,
  identity, theme, bug report) sit behind the overflow toggle, whose open state
  persists in `localStorage` (`kanban.headerOpen`). Since v3.2.4 the zoom block
  is `touch-action: pan-x pan-y` on EVERY element (`*` in `index.css`; WebKit
  resets touch-action at each scroll container, so a root-only rule - v3.2.3 -
  never reached the board; never use `manipulation`, it re-grants pinch) plus
  `lib/pinchZoomGuard.ts` (2+-finger `touchmove`, `gesture*`; non-passive,
  capture, document+window; no `touchend` guard and no `wheel` listener -
  ctrl+wheel cancelling killed desktop zoom and forced main-thread wheel
  scrolling). Zoom blocking is confirmed on a real iPhone. Two layouts, switched
  only in `index.css`: on touch phones below `md`
  (`(max-width: 47.99rem) and (pointer: coarse)` = `max-md:pointer-coarse:` =
  `PHONE_LAYOUT_QUERY` in `lib/scrollLock.ts`) the DOCUMENT scrolls (html is the
  scroller, body/#root/shell grow, `.app-header` is sticky and non-sticky while
  the overflow menu is open, columns grow to full height, Portfolio/About flow),
  because only document scrolling lets iOS Safari draw content behind its
  floating toolbar - app shells with internal scrollers (3.2.3's lvh shell, a
  fixed inset:0 shell) always stopped at its top edge. The hooks are semantic
  class names (`app-main`, `board-pane`, `board-frame`, `board-root`,
  `board-viewport`, `kanban-column`, `column-list`, `portfolio-view`,
  `about-view`); keep them when refactoring. All columns share the document's
  one scroll position, so in the phone layout the strip is
  `align-items: flex-start`, columns cap at 25 cards + "Show N more"
  (`lib/phoneBoard.ts`, Column `cardLimit`), a sticky current-column bar sits
  under the header (`--app-header-h` from App; real column headers can't be
  sticky - they're inside the horizontal scroller), and Board re-aligns the page
  to a newly snapped column's top (debounced, never during a vertical scroll).
  Real-device data has ~300 DONE cards; test with a long column. Overlays
  (TaskSheet, BugReportDialog, the phone rail drawer) lock the document via
  `useDocumentScrollLock` (body fixed at `-scrollY`, position restored; follows
  the phone query live across rotation; the sticky header is shifted back by
  `--scroll-lock-y`). Everywhere else it is a plain `h-screen` (100dvh) flex
  shell with internal scrolling and html/body `overflow: hidden` - never
  `position: fixed` + `100lvh` (clips behind a visible URL bar). The header pads
  `env(safe-area-inset-top)`, coarse+narrow lists keep `5rem + safe-area` bottom
  padding, fixed sheets stay `100dvh`. None of the iOS toolbar behaviour
  reproduces in Playwright/Chromium emulation. Anchored dropdowns (ProjectPicker,
  ColumnColors from `sm`) are `position: fixed` and placed by
  `lib/useMenuPlacement.ts` / `menuPlacement.ts` (right-aligned when it fits,
  otherwise left-aligned, clamped 12px inside the viewport); never anchor a menu
  with `absolute right-0` to a trigger that can wrap to the left of a row.
