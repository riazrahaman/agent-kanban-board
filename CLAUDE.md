# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Agent Kanban Board: a Kanban state dashboard for swarms of autonomous AI agents. Agents claim tasks and move them through a state machine over an HTTP API; humans watch live over SSE. Node/Express server (`server/`) + Vite/React 19/Tailwind v4/TypeScript client (`client/`). The server also serves the built client (`client/dist`) on the same origin.

## Commands

There is no root `npm install`; the server and client each have their own manifest.

```bash
npm --prefix server install && npm --prefix client install
npm start                      # API + built SPA on http://localhost:4000 (needs `npm run build` first for the UI)
npm run build                  # tsc -b && vite build  → client/dist
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

Client tests are `.test.mjs` files in `client/src/**` and mostly import `.ts` modules or **scan component source text** (class names, CSS rules) as contract guards rather than rendering. Server tests are `server/test/kanban.*.test.js`.

CI (`.github/workflows`) runs, on Node 20 and 22: `scripts/check-version-bump.sh`, `npm ci`, `npm audit --audit-level=high`, `make sec`, tests, build. `make sec` fails on any tracked file containing a `/Users/<name>` or `/home/<name>` path and on `dangerouslySetInnerHTML` in `client/src`, so never write absolute home paths into tracked files (including docs and this file).

Configuration is env-driven; the generated reference is `docs/CONFIGURATION.md` (regenerate with `node scripts/gen-config-reference.mjs`). Mutations need `KANBAN_AUTH_TOKEN` (or per-project `KANBAN_PROJECT_TOKENS` / `KANBAN_ADMIN_TOKEN`); reads are open unless `KANBAN_READ_AUTH=token`.

## Architecture

**Server (`server/`, ESM, Express 5).**
- `store.js` (~3.5k lines) is the core: in-memory task buckets keyed by composite `project/id`, mutation lock, lease/claim logic, the background lease reaper, backups, archive sweep, and the change/diff/audit/settings listener buses that feed SSE and the notifier. Pure pieces were split out: `state-machine.js` (statuses, legal transitions, role ownership matrix; no I/O), `task-fields.js`, `task-identity.js`, `storage.js` (`JsonStorage` atomic rename-writes, optional journal; `GitYamlStorage` one YAML card per task with a git commit per transition). `store.js` re-exports the split modules, so import from either.
- Multi-project: every task has a `project`. Default project reuses the legacy file (`server/tasks.json`/`KANBAN_DATA_FILE`); named projects live under `KANBAN_DATA_DIR`. `middleware/projectScope.js` resolves `?project=`, the `X-Kanban-Project` header, or the `workspace_id` create alias.
- `server.js` wires routers in `routes/` (tasks, projects, metrics, audit, health, auth, settings, milestones, agents), middleware (`cors`, `auth`, `rateLimit`), the capped SSE stream (`/api/events`, single-use stream tickets in `streamTicket.js`), `notifier.js` (optional Telegram reclaim alerts), `webhooks.js`, and static serving of `client/dist`. `resolveHost` handles Railway's `HOST=[::]`.
- Concurrency model to preserve: optimistic locking (every PATCH carries the current `version` as `expected_version`/`If-Match`; two distinct 409s: "Version mismatch" vs claim contention / invalid transition), claim-first entry into active stages (`POST /claim` sets owner + lease; a status-only PATCH leaves an ownerless task the reaper resets to BACKLOG), and lease heartbeats. Lifecycle: `BACKLOG → BUILDING → IN_REVIEW → IN_TEST → DONE` plus `BLOCKED`; builder/reviewer/tester roles gate transitions.

**Client (`client/src/`).** `App.tsx` owns top-level state and the single combined SSE `EventSource` (diff + settings). `api.ts` is the typed fetch layer (`ConflictError` for version conflicts, auth headers from `lib/authToken`). Pure logic lives in `lib/*.ts` with sibling `.test.mjs` files (filtering, sorting, metrics, claim coordination, column colors, theming, `aboutContent.ts`). Views: Board, Portfolio, About; plus `TaskSheet`, `SignalRail`, `MetricsDashboard`.

**Design contract.** `DESIGN.md` is the source of truth (editorial-minimalist). Machine-enforced bans across `client/src`: no `shadow-*`, no `rounded-full` (DESIGN.md says "any radius" is off-system, but the test only matches `rounded-full`), no Inter/Roboto, no person glyph U+1F464, and no Tailwind border classes interpolated in template strings (invisible to the JIT scanner). Responsive rules in `DESIGN.md` §10 are guarded by `responsive.test.mjs` and `mobileToolbar.test.mjs`. Touch ergonomics use `pointer: coarse` (Tailwind `pointer-coarse:` variants plus one unlayered `@media (pointer: coarse)` font rule in `index.css`), not width breakpoints, so mouse layouts at any width stay dense.

## Release discipline (enforced by tests/CI)

Every user-visible change bumps the version (policy text: README "Releasing"). Docs-only and test-only changes do not. A release must update, in lockstep: `server/package.json` (the UI reads the version live from it via `/api/health`) and root `package.json`; a new `## [x.y.z] — YYYY-MM-DD` section plus the tag list at the top of `CHANGELOG.md`; the version headers in `docs/` and `docs/with-images/`; and `skills/kanban/SKILL.md` frontmatter. After bumping, run `npm --prefix server install --package-lock-only` so `server/package-lock.json`'s own version fields match (they drifted in 2.16.0/2.16.1). Then an annotated tag `vX.Y.Z`, pushed only after CI is green on main: Railway waits for CI, so a red CI leaves the tag undeployed (v2.16.0 was never deployed for this reason). `kanban.version.test.js` checks internal consistency; `check-version-bump.sh <base-ref>` compares against git history, so it only sees *committed* changes.

The About page (`client/src/lib/aboutContent.ts`) hardcodes the client test count and `about.test.mjs` asserts it, so adding or removing client test cases requires updating that number.

## Workflow notes for this repo

- The real board is the hosted instance (API under `/api`, project `kanbann`), not a local server. A local server on `:8891` can be a stale process serving an old `client/dist`; `/api/health` shows the running version. Token goes in the gitignored `.opencode/config.json` (`kanban_token`) or `KANBAN_TOKEN`; never commit or print it. All task paths need `?project=<name>`; only `POST /tasks` takes `project` in the body.
- Work is orchestrated with the `riazrahaman__agentkanban` skill (`skills/kanban/SKILL.md` is its source): log tasks on the board, file GitHub issues, use builder → reviewer → tester, update docs/changelog/version, and verify the Railway deploy (`railway.json`; `render.yaml` is an alternative blueprint).
- Mobile verification: do not use headless Chrome `--window-size` (it enforces a minimum width and produces false "clipped" layouts). Use real emulation (e.g. playwright-core with `isMobile` + `hasTouch`) and check `scrollWidth`, control heights (≥44px) and input font size (≥16px).
- Report-a-bug (v2.16.0+) is a public, unauthenticated route (`server/routes/bugReports.js`, Turnstile + GitHub issue) and touches several places at once: `server.js` mount order (must stay ahead of auth/rate-limit), `scripts/gen-config-reference.mjs` + `.env.example` (every new `KANBAN_*`/`TURNSTILE_*` var needs a `DESCRIPTIONS` entry and an `.env.example` line, enforced by `kanban.config.test.js`), `client/src/lib/bugReport.ts` (client limits must match the server's), and the `aboutContent.ts` test-count pair. Its entry points (v2.17.0+) are a small bug-icon button in the header, immediately beside the theme toggle, and the About page CTA — the earlier header "i" popover row (v2.16.0) and footer link (v2.16.3, `AppFooter.tsx`) were both removed once the icon made the feature a direct tap at every width. The header icon shares a border with the theme toggle and claws back its own slice of the row's gap (`App.tsx`, `md:-ml-2`, applied only when it renders) specifically so the header height stays IDENTICAL with the feature on vs off at every width, guarded by `scripts/check-header-layout.mjs`. Real touch phones measure taller than a desktop window (`pointer: coarse` 44px targets), so check both. `BugReportDialog.tsx` also carries iOS/WebKit-specific defenses (v2.17.0) against a real-device overflow/zoom/bottom-toolbar-clipping report: `overflow-x-hidden`/`max-w-[100vw]` on the sheet plus `overflow-x: hidden` on `html, body` (`index.css`), `inert` when closed, `100dvh`, Turnstile `size: 'flexible'`, and a submit button pinned outside the scrollable body with safe-area bottom padding — Playwright WebKit (desktop engine) does not reproduce the underlying iOS chrome behaviour, so these fixes are defensive/unverified-by-repro in that environment.
- Never commit a real secret. `.env.example`, docs and README use placeholders or Cloudflare's published Turnstile test keys only; the real `KANBAN_REPORT_GITHUB_TOKEN` and `TURNSTILE_SECRET` live in Railway variables.
- Gitignored local tooling: `.opencode/`, `opencode.json`, `.claude/`, `skillport.lock`.
