# Handover — Agent Kanban Board

A self-contained handover for the next maintainer/agent. Every claim below is
grounded in the code in this repository; file paths, function names and env vars
were read from source, not copied from other docs. Where something is uncertain
it is marked **(uncertain)**.

Live board: <https://agent-kanban.riazrahaman.com> · Repo:
<https://github.com/riazrahaman/agent-kanban-board>

---

## 1. What this is

An **agent-orchestration Kanban board**. A single long-lived Node process serves a
**headless REST + SSE API** (Express 5, ESM) that enforces a strict 8-state task
lifecycle, ownership leases, role rules and optimistic concurrency — and a **thin
React observability client** that renders the live board over one SSE stream. It
is **local-first**: no database, no accounts, no SaaS. State is persisted to a
json file (default) or git-backed YAML. The primary users are headless agents
driving the board over plain HTTP; humans watch.

---

## 2. Repository layout

| Path | What it is |
| :-- | :-- |
| `server/` | The whole backend: `server.js` (composition/boot), `store.js` (engine), split modules, `routes/`, `middleware/`, `test/`, `utils/`. |
| `client/` | React 19 + Vite + TypeScript + Tailwind v4 SPA (`client/src/`); built into `client/dist/`, served statically by the server. |
| `scripts/` | CI/local tooling: `check-version-bump.sh`, `gen-config-reference.mjs`, `test-client-status.js`, headless-browser layout guards, `restore-backup.mjs`. |
| `docs/` | Operator/maintainer docs (`CONFIGURATION.md` is generated), ADRs under `docs/decisions/`, presentation assets. |
| `skills/kanban/` | The bundled opencode **orchestrator skill** (`SKILL.md` + `README.md`) that drives the board claim-first. |
| `.github/workflows/ci.yml` | CI: Node 20 + 22 matrix, version-bump guard, `make sec`, server/client tests, client build, layout guards. |
| `railway.json` | Railway deploy config (build command, `node server/server.js` start, healthcheck, restart policy). |
| `render.yaml` | Legacy/secondary Render blueprint (kept; not the active host). |
| `CHANGELOG.md` | Per-release history; the version discipline is enforced by tests + CI. |
| `README.md` | Primary operator/agent documentation, endpoint table, "Releasing". |
| Other root files | `.env.example`, `Makefile` (`test`/`build`/`sec`), `package.json` (umbrella scripts only), `CLAUDE.md`, `ONBOARDING.md`, `DESIGN.md`, `LICENSE`. |

---

## 3. Architecture

### Layers and real files

**`server/server.js` — composition root.** `createApp()` mounts in this exact
order (important for security and for the unauthenticated routes):

1. `configureCors()` (`middleware/cors.js`) — allow-list, never `*`.
2. `express.json()`.
3. `app.set('trust proxy', resolveTrustProxy())` and `query parser = extended`.
4. `app.use('/api/auth', authRouter)` — the HMAC handshake must be reachable
   before the auth middleware.
5. `app.use('/api/bug-reports', createBugReportsRouter())` — public, its own
   in-memory limiter.
6. `app.use('/api/ask', createAskRouter())` — public, its own password gate.
7. `createAuthMiddleware()` then `createRateLimitMiddleware()`.
8. Feature routers: `/api/tasks`, `/api/projects`, `/api/metrics`, `/api/audit`,
   `/api/health`, `/healthz`, `/api/settings`, `/api/milestones`, `/api/agents`.
9. `GET /api/events` — the SSE stream (diff by default; `?mode=snapshot`,
   `?project=`, `?prime=1`, `?ticket=`; capped by `KANBAN_MAX_SSE_STREAMS`).
10. Static `client/dist` + SPA catch-all (`GET {*splat}` → `index.html`).
11. A global error handler that maps body-parser errors to 400/413/415.

`startServer()` calls `loadStore()`, warns about auth/CORS/credential-map gaps,
then starts the reaper, audit sink, backups, notifier and webhooks, wiring each
to `server.on('close', …)`. `registerShutdownHandlers()` handles SIGTERM/SIGINT.

**`server/store.js` — the engine.** Holds the in-memory `tasks[]` + `index`
(`${project}/${id}` → task), the single serialization point
**`withMutationLock(operation)`** (one process-local promise queue — ADR-003), the
diff/audit/settings listeners, `notify()`, metrics, the claim core `applyClaim`,
the reaper `reapExpiredClaims`/`reclaimTaskInner`, and the persistence/backup
lifecycle. It re-exports the split modules so every `../store.js` importer is
unaffected.

Split modules (all re-exported by `store.js`):

- `server/state-machine.js` — pure: `STATUSES`, `VALID_TRANSITIONS`,
  `canTransition`, `canRoleTransition`, `normalizeStatus`.
- `server/task-fields.js` — pure: `PRIVILEGED_ROLE_SET`, `isPrivilegedRole`,
  `validatePriority`, `validateDependsOn`, `validateMetadata`, bounds, `priorityRank`.
- `server/task-identity.js` — `writeAtomic` (temp-file + rename), `isValidProjectId`,
  `isValidTaskId`, `toBranch`, `toMilestone`, `defaultProjectName`,
  `normalizeProject`, `resolveProjectScope`, `gitRoot`, `jsonDataDir`,
  `backfillLeaseFields`.
- `server/storage.js` — `JsonStorage` and `GitYamlStorage` (the storage factory
  is `getStorage(project)` in `store.js`).

**`server/middleware/`**

- `auth.js` — `createAuthMiddleware`, `parseProjectTokens`, `getAuthorizedProjects`,
  `readAuthEnabled`, `hasReadCredential`, `VALID_ROLES`, `tokensMatch` (re-export).
- `rateLimit.js` — per-project mutation limiter (`createRateLimitMiddleware`) and
  the separate per-IP **auth-failure** limiter (`recordAuthFailure`/
  `authFailuresExceeded`).
- `projectScope.js` — `referencedProjects(req)` (every project a request names),
  `rawProjectScope`, `projectScopeGuard`.
- `cors.js` — `configureCors`.

**`server/routes/*.js`** — `tasks.js` (largest; all task endpoints), `projects.js`,
`metrics.js`, `audit.js`, `health.js`, `auth.js` (handshake/tickets/revoke),
`settings.js`, `milestones.js`, `agents.js`, `bugReports.js`, `ask.js`.

**Client (`client/src/`)** — `App.tsx` owns **one combined SSE `EventSource`**
(`subscribeToBoard` in `api.ts`, mode `diff`), reconciling each `task.<kind>` event
into local state by the composite key `(id, project)`, plus `event: settings`.
`components/Board.tsx` renders the lanes; `components/TaskSheet.tsx` is the detail
sheet. `lib/useClaimCoordinator.ts` is the **single writer on the browser side**
(heartbeat every held card, then `nextClaim` when idle); pure decisions live in
`lib/claimCoordinator.ts`.

### Write path

```
  HTTP request (server/routes/*.js)
        │   req.caller = { agent_id, role, privileged }   ← derived from credential
        ▼
  store.js engine ── withMutationLock(fn)     (one process-local promise queue)
        │   validate · CAS expected_version · canTransition/canRoleTransition
        ▼
  storage backend   JsonStorage.saveTask | GitYamlStorage.saveTask
        │            writeAtomic(tmp → rename)  /  YAML card + git commit      ← PERSIST FIRST (KB-05)
        ▼
  in-memory tasks[] + index          updateInMemoryTask()
        │
        ▼
  notify(opts) → diffListeners {kind,task,prev,project} + auditListeners
        │
        ├─ SSE  GET /api/events   →  task.<kind> frames to browsers
        ├─ notifier.js            →  Telegram (reclaimed events)
        ├─ webhooks.js            →  signed JSON to subscriber URLs
        └─ auditLog.js            →  <data>/audit.jsonl (opt-in)
```

Ordering is deliberately **persist → memory → notify**, so a storage failure
leaves memory untouched (fail-closed).

---

## 4. Domain model

### Lifecycle (`server/state-machine.js`)

```
BACKLOG → READY → PLANNING → IN_PROGRESS → IN_REVIEW → VALIDATION → READY_TO_SHIP → DONE
                    (+ BLOCKED side state; DONE is terminal)
```

`VALID_TRANSITIONS` (exact):

| From | To |
| :-- | :-- |
| `BACKLOG` | `READY`, `BLOCKED` |
| `READY` | `PLANNING`, `IN_PROGRESS`, `BACKLOG`, `BLOCKED` |
| `PLANNING` | `IN_PROGRESS`, `READY`, `BLOCKED` |
| `IN_PROGRESS` | `IN_REVIEW`, `PLANNING`, `BLOCKED` |
| `IN_REVIEW` | `VALIDATION`, `IN_PROGRESS`, `BLOCKED` |
| `VALIDATION` | `READY_TO_SHIP`, `IN_PROGRESS`, `BLOCKED` |
| `READY_TO_SHIP` | `DONE`, `IN_PROGRESS`, `BLOCKED` |
| `BLOCKED` | `BACKLOG`, `READY`, `PLANNING`, `IN_PROGRESS`, `IN_REVIEW`, `VALIDATION` |
| `DONE` | *(terminal — empty)* |

**Legacy aliases** (`normalizeStatus`, accepted on input and on load):
`TODO → BACKLOG`, `BUILDING → IN_PROGRESS`, `IN_TEST → VALIDATION`. Lowercase is
uppercased. `ACTIVE_STATUSES` = `PLANNING, IN_PROGRESS, IN_REVIEW, VALIDATION`.

### Roles (`canRoleTransition`)

Privileged roles **`runner`, `system`, `human`, `admin`** may make **any**
transition, including setting/clearing `BLOCKED` and entering/leaving any stage.
A regular agent may not set `BLOCKED` (that is privileged-only). Otherwise:

- `planner` → `READY`, `PLANNING`, `IN_PROGRESS`
- `builder` → `IN_PROGRESS`, `IN_REVIEW`
- `reviewer` → `VALIDATION`, `IN_PROGRESS`
- `tester` / `validator` → `READY_TO_SHIP`, `IN_PROGRESS` (cannot set `DONE`)
- `releaser` → `DONE`, `IN_PROGRESS`

On a **claim** of a `READY` card: status lifts to `PLANNING` for a `planner`, else
`IN_PROGRESS`. Transitions *into* an active stage are additionally gated on
dependencies (`dependencyGate`).

### Claim / lease semantics

- `claim_expires_at` (ISO): when the lease lapses.
- `claim_lease_ms`: the **per-task** window. A fresh claim with an explicit
  `lease_ms` pins it (clamped by `resolveLeaseMs` between `KANBAN_MIN_LEASE_MS`
  and `KANBAN_MAX_LEASE_MS`); otherwise it is stored `null` and tracks
  `KANBAN_CLAIM_TTL_MS` live. `leaseWindowFor(task)` =
  `task.claim_lease_ms ?? KANBAN_CLAIM_TTL_MS`.
- `last_progress_at`: last time **this card's content** changed (claim, log,
  PATCH) — distinct from lease renewal. Only a fresh claim or a real write
  advances it; a **sibling lease renewal does not**.
- Renewal: the holder's `heartbeat`, `logs`, or any holder `PATCH` push the
  deadline out. `renewAllLeases` / holder-write sibling renewal re-arm the
  holder's *other* active leases in the same lock (default on;
  `KANBAN_HOLDER_WRITE_RENEWS_ALL=0` disables). Only `READY` (or an already-active
  held card for renewal) is claimable; `BACKLOG` is refused.

### The 409s

Two semantically opposite `409`s, distinct payloads:

- **"Version mismatch"** — a *stale read*. Body carries
  `details: { expected, provided }` and the route adds `currentVersion`. Re-fetch
  and retry. Raised by `versionConflict` from `expected_version` (body) or
  `If-Match` (header).
- **"Task … is already claimed by …"** — *contention*, a live lease held
  elsewhere. Retrying is pointless until it lapses. Carries no version, no reason.

Other reason-tagged `409`s (branch on `reason`):

| `reason` | Meaning |
| :-- | :-- |
| `dependency_unsatisfied` | unresolved `depends_on` (also carries `unresolved_dependencies[]`) |
| `not_ready` | still in `BACKLOG` — promote to `READY` first |
| `status_not_claimable` | not `READY` and not an active held card |
| `claim_limit` | caller already at `KANBAN_MAX_CLAIMS_PER_AGENT` |
| `not_claimed` | heartbeat on a task with no owner |
| `not_lease_holder` | heartbeat by a non-holder, non-privileged caller |

(The state-machine also returns a plain `409` for an illegal transition with no
`reason`; creating a duplicate `${project}/${id}` is a different `409`.)

### Reaper (`reapExpiredClaims` / `reclaimTaskInner`)

Sweeps active cards (timer gated by `KANBAN_REAP_ENABLED`, interval
`KANBAN_REAP_INTERVAL_MS`, default 30000 ms; runs only in `startServer`). A
candidate is tagged and **reclaimed to `READY`** (owner + lease cleared,
`reclaim_count++`, version bumped):

- `orphan_normalized` — active but ownerless past `KANBAN_ORPHAN_GRACE_MS`
  (default 300000; `0` reaps immediately).
- `progress_stalled` — held card whose `last_progress_at` is older than
  `KANBAN_PROGRESS_STALL_MS` (default 1800000; `0` disables).
- `lease_expired` — `claim_expires_at` in the past.

> Reclaims go to **READY** (claimable again), not `BACKLOG`, since ADR-004. Some
> older comments/changelog text still say BACKLOG — see §14.

---

## 5. Auth & isolation

Credential families, resolved in `middleware/auth.js` `getAuthorizedProjects`:

- **`KANBAN_AUTH_TOKEN`** — legacy single global token; opens **every** project.
- **`KANBAN_ADMIN_TOKEN`** — privileged superuser; spans every project; admin
  writes are audited (`admin_write`).
- **`KANBAN_PROJECT_TOKENS`** — JSON map `{"project":"token"}`. A token only works
  for the projects it names; malformed JSON is a config failure → mutations `503`
  (never a silent fallback to global). A per-project token confers
  `privileged=false` by convention.
- **`KANBAN_AUTH_SECRET`** — HMAC stateless session tokens (`sessionAuth.js`):
  `POST /api/auth/session` (proof-of-secret handshake) → self-describing token
  `base64url(payload).hmac` with `{cn,sn,jti,exp,role,project}`, 24 h expiry, and
  a process-local **jti deny-list** (`POST /api/auth/revoke`).
- **Stream tickets** (`streamTicket.js`) — 60 s, single-use, signed with
  `KANBAN_AUTH_SECRET` (fallback `KANBAN_AUTH_TOKEN`); minted at
  `POST /api/auth/stream-ticket`, consumed in `GET /api/events?ticket=` because
  `EventSource` cannot set headers.

**`referencedProjects(req)`** (`middleware/projectScope.js`) collects **every**
project id a request names — `body.project`, `body.workspace_id`, `query.project`,
`query.workspace`, `X-Kanban-Project`, and percent-decoded composite `project:id`
path segments — and auth authorizes against **all** of them (the store lets a body
project outrank the query, so checking only one channel would authorise A while
writing to B).

**Credential-derived privilege.** `req.caller.privileged` is set from the
credential (admin token, or a session role that is privileged), never from the
self-asserted `X-Agent-Role` header. `destructivePrivilege`/`callerIsPrivileged`
gate delete/purge/assign on that flag.

**Fail-closed 503s.** No auth mechanism configured on a mutation → `503`; malformed
`KANBAN_PROJECT_TOKENS` → `503`; `/api/auth/session` with no secret → `503`;
`/api/auth/stream-ticket` with no signing key → `503`.

**Read auth (`KANBAN_READ_AUTH`).** Unset/`off`/`0`/`false` → reads and SSE are
open (the board is a public viewport). Any other value → every read requires a
bearer credential or a stream ticket; `/api/health` and `/healthz` stay exempt
(liveness probes).

---

## 6. Persistence

Chosen by `KANBAN_STORAGE_BACKEND` (`json` default, `git`); one instance per
project via `getStorage(project)`.

- **`JsonStorage`** — one atomic `{tasks:[…]}` file per project. Writes go through
  `writeAtomic` (temp file + `rename`). With **`KANBAN_STORAGE_JOURNAL=1`** a
  single task write appends to a `.journal.jsonl` sidecar (O(1) writes; replayed on
  load, compacted at `KANBAN_JOURNAL_COMPACT_BYTES`, default 1 MB). Archive,
  trash and settings live in sibling `archive/`, `trash/`, `settings/` paths.
- **`GitYamlStorage`** — one YAML card per task (`<id>.yml`), **one real git commit
  per transition** (`ops(<project>/<id>): kanban <STATUS>`), enabling
  `KANBAN_GIT_COMMIT=0` to skip commits. **Requires a positive-integer `round`**
  on every task; missing/invalid `round` throws.

**Fail-closed boot.** If the JSON file exists but cannot be parsed (or the project
directory is unreadable), `JsonStorage.load()` throws; `startServer` awaits
`loadStore()` and therefore **refuses to boot** rather than overwrite good data
with an empty board. In git mode, an individually bad card is warned and skipped,
but a directory read failure throws.

**Locations.** Default project → `KANBAN_DATA_FILE` (or repo `server/tasks.json`).
Named projects → `jsonDataDir()/tasks/<project>.json` (JSON) or `<gitRoot>/<project>/`
(git), where `jsonDataDir()` = `KANBAN_DATA_DIR` (fallback `server/data`). Archives
mirror under `archive/`; inline overflow spills to `spill/<project>/<id>.jsonl`.

**Backups** (`store.js`): off unless `KANBAN_BACKUP_ENABLED` is truthy. Interval
`KANBAN_BACKUP_INTERVAL_MS` (600000), rotate `KANBAN_BACKUP_KEEP` (10) snapshots
under `<data>/backups/<timestamp>/`. `scripts/restore-backup.mjs` restores one.

---

## 7. Subsystems

- **Anonymous bug reports → GitHub** (`routes/bugReports.js`, mounted public).
  Off unless `KANBAN_REPORT_GITHUB_TOKEN`, `KANBAN_REPORT_REPO`, `TURNSTILE_SECRET`
  and `TURNSTILE_SITE_KEY` are all set. Guards: a **honeypot** field (`website`),
  Cloudflare **Turnstile** siteverify (action must be `bug-report`, optional
  `TURNSTILE_HOSTNAMES` allow-list), and peek-only/consume-on-success caps
  (`KANBAN_REPORT_DAILY_CAP` 50, `KANBAN_REPORT_PER_IP_PER_HOUR` 3). Files a
  labelled (`user-report`) GitHub issue; `GET /api/bug-reports/config` returns the
  site key. Never logs the token, secret, report text or client IP.
- **Telegram notifier** (`notifier.js`) — an `onDiff` subscriber that posts a
  full-detail alert when a card is reclaimed. Off unless **both**
  `KANBAN_TELEGRAM_BOT_TOKEN` and `KANBAN_TELEGRAM_CHAT_ID` are set; filter with
  `KANBAN_NOTIFY_EVENTS`, `KANBAN_NOTIFY_PROJECTS`, `KANBAN_BOARD_URL`,
  `KANBAN_NOTIFY_INCLUDE_DESC`, `KANBAN_NOTIFY_MIN_INTERVAL_MS`. Fail-silent.
- **Signed webhooks** (`webhooks.js`) — POSTs a flat JSON envelope
  (`{event:'task.changed',kind,project,task_id,status,…}`) for every committed
  mutation to each `KANBAN_WEBHOOK_URLS`; optional HMAC
  `x-kanban-signature` over `${timestamp}.${body}` with `KANBAN_WEBHOOK_SECRET`.
  Off by default; fail-silent.
- **Audit log** (`auditLog.js`) — `KANBAN_AUDIT_LOG` truthy appends one compact
  JSON line per mutation to `<data>/audit.jsonl`; `GET /api/audit` reads it
  (newest-first, filter by `since`/`project`/`kind`).
- **Ask-the-Board** (`routes/ask.js` + `askKnowledge.js`, mounted public). A
  **read-only, password-gated** Q&A over the board's protocol and source. Off
  unless **both** `KANBAN_ASK_OPENROUTER_API_KEY` and `KANBAN_ASK_PASSWORD` are
  set. `GET /api/ask/config` reports `{enabled,gated,model}`. `POST /api/ask`
  requires the `x-ask-pass` header and `{question}` (3–500 chars); it builds a
  system prompt from a curated protocol pack, **retrieved source excerpts**
  (`rankSourceFiles` → `gatherSourceContext` → `readSourceExcerpt`) and a live
  in-process snapshot (`gatherSnapshot`), then calls OpenRouter. Caps:
  `KANBAN_ASK_DAILY_CAP`, `KANBAN_ASK_PER_IP_PER_HOUR`, plus a wrong-password
  counter (`KANBAN_AUTH_RATE_LIMIT_PER_MIN`). It never reads/writes the board and
  never sees a token; a failed live snapshot degrades to the static pack
  (`fallback: true`).

---

## 8. Run / test / build

There is **no root install step** — `server/` and `client/` each have their own
manifest and lockfile.

```sh
# install (from repo root)
npm --prefix server install
npm --prefix client install            # or `npm --prefix … ci` for lockfile-exact

# full suite from the root (server tests + client-status + client tests + client build)
npm test                               # == npm --prefix server test
                                       #    && node scripts/test-client-status.js
                                       #    && npm --prefix client test
                                       #    && npm --prefix client run build

# local dev — Vite on :5173, proxies /api (incl. SSE) to :4000
npm --prefix client run dev

# run the backend (serves the built client/dist on the same port)
PORT=4000 HOST=127.0.0.1 npm --prefix server start
```

Server tests are `node --test` over `server/test/*.test.js`; client tests are
`node --test src/**/*.test.mjs`.

**Local Ask preview** — set both secrets, then `POST /api/ask` with the
`x-ask-pass` header:

```sh
KANBAN_ASK_OPENROUTER_API_KEY=sk-or-... \
KANBAN_ASK_PASSWORD=choose-a-local-password \
PORT=4000 HOST=127.0.0.1 npm --prefix server start
# optional: KANBAN_ASK_MODEL, KANBAN_ASK_DAILY_CAP, KANBAN_ASK_PER_IP_PER_HOUR,
#           KANBAN_ASK_TIMEOUT_MS, KANBAN_ASK_MAX_PROMPT_TOKENS, KANBAN_ASK_MAX_OUTPUT_TOKENS
```

---

## 9. Deploy

- **Host: Railway.** Service **`agent-kanban-board`** in project **`kanbann`**
  (verified via the Railway API). Environment: `production`.
- **Push to `main` auto-redeploys.** CI (`.github/workflows/ci.yml`) runs on
  `push`/`pull_request` to `main`; Railway deploys the `main` build.
- **`railway.json`**: builder `RAILPACK`; build
  `npm ci --prefix client && npm run build --prefix client && npm ci --prefix server`;
  start **`node server/server.js`**; healthcheck `/api/health` (120 s);
  `restartPolicyType: ALWAYS`.
- **Mounted volume at `/data`** (holds `KANBAN_DATA_FILE=/data/tasks.json` and
  `KANBAN_DATA_DIR=/data`). Named projects, archives, settings, spill and backups
  all live under it, so the mount must cover the whole directory, not just the
  file. **(The volume itself is configured in Railway, not repo-verifiable.)**
- **Env vars live in the Railway dashboard** (project `kanbann` → service
  `agent-kanban-board` → Variables). Do **not** use `npm start`/`npm --prefix
  server start` as a Railway *custom* start command: npm exits non-zero after a
  clean SIGTERM and Railway reports a "Deploy Crashed" email. A dashboard Custom
  Start Command silently overrides `railway.json`.
- `render.yaml` is a legacy secondary blueprint (uses `/api/health/ready`).

---

## 10. Release & repo conventions

Release flow (from `README.md` → Releasing and `CHANGELOG.md`):

1. On a feature branch.
2. Bump the version in **both** `server/package.json` and `package.json` (the UI
   reads `server/package.json` live from `GET /api/health`); additive → minor,
   fix/polish → patch, breaking → major.
3. Add a dated `## [x.y.z] — YYYY-MM-DD` section to `CHANGELOG.md` and sync the
   version string in the four doc files (see the guard below).
4. `git merge --no-ff` into `main`, push, create an **annotated tag**
   (`git tag -a vX.Y.Z -m …`), push the tag, and cut a GitHub Release.

Guards that enforce this:

- **`server/test/kanban.version.test.js`** — `server/package.json` and
  `package.json` must match; version must be a semver triple; `CHANGELOG.md` must
  contain a `## [<version>]` section; and the four **doc version strings** must
  match (`docs/SYSTEM_DESIGN_AND_ARCHITECTURE.md` via `**System Version:**`, and
  both `docs/USER_AND_OPERATOR_MANUAL.md` and their `docs/with-images/` mirrors).
- **`scripts/check-version-bump.sh`** (CI, before install) — fails if user-visible
  source changed since the base branch but the version was not bumped. Docs/tests
  are excluded.
- **`server/test/kanban.config.test.js` + `scripts/gen-config-reference.mjs`** —
  every `process.env.KANBAN_*` (and `PORT`/`HOST`) read in server source must be
  documented in `docs/CONFIGURATION.md` (regenerate with
  `node scripts/gen-config-reference.mjs`) and listed in `.env.example` (which must
  stay un-gitignored).
- **`client/src/lib/aboutContent.ts` → `TRUST_METRICS`** must match the real suite
  sizes; `client/src/lib/about.test.mjs` counts the suites from the files and
  fails if the numbers drift.

---

## 11. The board protocol (the `rizaz` / `skills/kanban` skill)

The bundled orchestrator skill (`skills/kanban/SKILL.md`) drives the board:

1. **`?project=<name>` is mandatory on every task path.** Unqualified paths
   resolve to the `default` project, producing misleading `403`/`404`. Append it to
   `/:id`, `/:id/claim`, `/:id/heartbeat`, `/:id/logs`, `/tasks`, etc.
2. **Claim-first.** Enter an active stage by `POST /:id/claim` from `READY`, never
   by a status-only `PATCH`. A claim sets owner + lease and lifts to
   `IN_PROGRESS`/`PLANNING`.
3. **`PATCH` needs a fresh `expected_version`.** `claim`, `logs` and `heartbeat`
   each bump `version`, so re-`GET` the card before each `PATCH`.
4. **Appending a log also bumps `version`** (and extends the holder's lease).
5. The **hosted board is the same API** — the same endpoints and rules, just over
   HTTPS at the live URL.

---

## 12. Credentials

Local credentials live in a **gitignored** `.opencode/config.json` (the whole
`.opencode/` dir is in `.gitignore`). Its keys are:

```jsonc
{
  "kanban_url":   "https://agent-kanban.riazrahaman.com",
  "project_name": "<your project id>",
  "kanban_token": "<a project or global token>",
  "admin_token":  "<KANBAN_ADMIN_TOKEN>"
}
```

**No secret is ever committed.** Never stage `.opencode/`, `.env`, or
`server/data/`. `.env.example` carries placeholders only and is the one env file
that must be tracked.

Railway environment keys (names only; values live in the dashboard). The full
`KANBAN_ASK_*` set:

`KANBAN_ASK_OPENROUTER_API_KEY`, `KANBAN_ASK_PASSWORD`, `KANBAN_ASK_MODEL`,
`KANBAN_ASK_DAILY_CAP`, `KANBAN_ASK_PER_IP_PER_HOUR`, `KANBAN_ASK_TIMEOUT_MS`,
`KANBAN_ASK_MAX_PROMPT_TOKENS`, `KANBAN_ASK_MAX_OUTPUT_TOKENS`.

Plus the auth/storage/deploy keys the board needs in production, e.g.
`KANBAN_AUTH_TOKEN`, `KANBAN_ADMIN_TOKEN`, `KANBAN_PROJECT_TOKENS`,
`KANBAN_AUTH_SECRET`, `KANBAN_DATA_DIR`, `KANBAN_DATA_FILE`,
`KANBAN_STORAGE_BACKEND`, `KANBAN_ALLOWED_ORIGIN`, `KANBAN_TRUST_PROXY`,
`HOST`/`PORT`, and the bug-report/Telegram sets when those features are on. See
`docs/CONFIGURATION.md` for the complete list.

---

## 13. Current state & next steps

- **Version `3.5.0` is the current release** — "Ask-the-Board console + Field
  Guide Nº 02" (`CHANGELOG.md` `## [3.5.0] — 2026-10-18`). It contains the
  client half of Ask-the-Board (`client/src/lib/ask.ts` + the hero console),
  source retrieval in `server/askKnowledge.js` (`rankSourceFiles` /
  `gatherSourceContext`), the `KANBAN_ASK_MAX_PROMPT_TOKENS` 2000 → 6000 raise,
  and the About page rebuilt as a twelve-chapter field guide.
- **`3.4.0` was the backend half** (`## [3.4.0] — 2026-10-17`; commit `7361948`,
  merge `6b0b699`): the endpoint, the password gate and the rate limits.
- Everything the previous handover listed as pending is now done: both manifests
  bumped, the dated CHANGELOG section written against the tagged `v3.4.0`, the
  four doc version strings synced, `skills/kanban/SKILL.md` frontmatter
  re-synced (it had drifted to `3.3.0`), the `KANBAN_ASK_MAX_PROMPT_TOKENS`
  drift reconciled on 6000, `server/data/` added to `.gitignore`, and
  `TRUST_METRICS` moved to 605 server / 272 client — the numbers in the hero and
  the numbers strip are now read from that constant instead of retyped into JSX,
  so they cannot drift independently.
- Obvious next steps:
  1. Port the reference guides' **"← Back to …"** chip (the counterpart to the
     ↑ Top control), which was deliberately left out of v3.5.0.
  2. Issue **#108** — addressed in v3.5.1. Its original cause (an `npm` wrapper
     in the Railway start command) was fixed in the dashboard on 2026-10-11 and
     no crash email has arrived for this service since 2026-10-10. Verifying
     that turned up a second, real defect — the server never actually exited on
     `SIGTERM` while an SSE stream was open — which v3.5.1 fixes. Confirm on the
     next redeploy that the retired container logs `ended N open event stream(s)`
     followed by `closed cleanly in Nms`, then close the issue.
  3. Keep `aboutContent.ts` `TRUST_METRICS` in lock-step as tests are added
     (§10); `about.test.mjs` fails the build when it drifts.

---

## 14. Gotchas

- **NAMED projects resolve through `jsonDataDir()`.** Tests for a named project
  must set **`KANBAN_DATA_DIR`** (so the per-project file lands in a temp dir) —
  do **not** rely on `setStorage()`, which only binds the default project (or one
  explicitly named cache slot) and does not redirect the `tasks/<project>.json`
  path. `gitRoot()`/`jsonDataDir()` warn once when unset and default to
  `server/data`.
- **`aboutContent.ts` trust counts must be bumped whenever a test is added.**
  `client/src/lib/about.test.mjs` counts the real suite sizes from the files and
  fails if `TRUST_METRICS` drifts. As of v3.5.0 it declares `605` server / `272`
  client, and the About hero and numbers strip read those values from the
  constant rather than repeating them in JSX.
- **The reaper returns cards to `READY`, but some comments/changelog wording still
  says `BACKLOG`.** `reclaimTaskInner`, `unlockTaskInner`, `reclaimTask` and
  `restoreFromTrash` all target `READY`. Trust the code; older prose (including
  some CHANGELOG lines) is stale.
- **A lease-only sibling renewal deliberately does NOT bump `version`.** Version
  is the content CAS guard; bumping it on a card the caller never edited would
  invalidate concurrent `expected_version` PATCHes. `renewAllLeasesInner` renews
  `claim_expires_at` only. `renewAllLeases(agentId)` (bulk) *does* notify and
  return the keys, but still does not bump version.
- **`server/data/` holds live runtime data and must never be committed.** It is
  gitignored as of v3.5.0; before that it was merely untracked, one `git add -A`
  away from publishing local board state. Production uses `/data` on the mounted
  volume.
- **`KANBAN_ASK_MAX_PROMPT_TOKENS` is 6000** — reconciled in v3.5.0 across the
  code fallback (`routes/ask.js`), `.env.example`, `docs/CONFIGURATION.md` and
  the About environment table. It was raised from 2000 because the prompt now
  carries retrieved source. `kanban.config.test.js` fails if a `KANBAN_*` var
  lacks a `DESCRIPTIONS` entry or an `.env.example` line, so change all four.
- **`HOST` may arrive bracketed** (Railway injects `HOST=[::]`). `resolveHost()`
  strips the brackets; passing `[::]` through otherwise fails DNS with `ENOTFOUND`
  and restart-loops.
- **`KANBAN_TRUST_PROXY` defaults to `1`** (one trusted hop). Setting it to `true`
  with no real proxy re-opens `X-Forwarded-For` spoofing against the per-IP
  bug-report and auth-failure limiters.
- **A long-lived response blocks `server.close()`.** `GET /api/events` holds a
  response open for the life of a browser tab, and `close()` waits for every
  open connection, so shutdown has to END those streams first or the callback
  never fires. `server.js` keeps an `openSseStreams` set purely for this;
  `drainSseStreams()` is called before `close()` on SIGTERM/SIGINT. A plain
  counter cannot do it — you need the response objects. Any future endpoint
  that holds a connection open must register the same way.
- **`round` is required for git-backed persistence** and for `createTask`
  generally (positive integer); a missing value is a `400`.

---

*Handover by _[maintainer]_ · 2026-10-17.*
