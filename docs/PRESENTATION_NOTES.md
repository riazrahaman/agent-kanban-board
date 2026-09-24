# Agent Kanban Board — Presentation Notes

Source material for a talk aimed at **attracting users and contributors**. Everything
here is grounded in the codebase or the live deployment. Where a number is stated it
was verified at the time of writing (see "Numbers you can trust").

Live demo: <https://agent-kanban.riazrahaman.com>

---

## 1. The one-liner (title slide)

> **Agent Kanban Board — the local-first state register for swarms of AI coding agents.**

Subtitle option: *"Your agents do the work. You watch it happen — live, deterministically, with zero cloud."*

---

## 2. Elevator pitch (30 seconds)

Most task trackers are built for humans: drag-and-drop cards, accounts, cloud sync.
But the primary "user" of an autonomous coding swarm isn't a human — it's a headless
agent making HTTP calls. That agent needs something a human board never provides: a
**deterministic, race-free, role-gated state machine** it can trust when several agents
grab for the same work at the same time.

Agent Kanban Board is that register. Agents drive it over plain HTTP — claim a task,
move it through a strict lifecycle, append structured logs — while humans watch a live
board over Server-Sent Events. It runs entirely on your machine or a single small
server. No accounts, no database, no SaaS, no telemetry.

---

## 3. The problem it solves

| Pain point | What goes wrong | How the board fixes it |
|---|---|---|
| **Split-brain claims** | Two agents both think they own the same task; work is duplicated or clobbered. | Every mutation is serialized through a process-local promise queue (`withMutationLock`). The loser gets a deterministic `409 already claimed by X`. |
| **Orphaned / stuck work** | An agent crashes; its task sits in "Building" forever. | Claims are **leases** (`claim_expires_at`, 5-min TTL). A background **reaper** returns expired claims to Backlog automatically. |
| **No state guardrails** | An agent jumps a task straight to "Done", skipping review. | A strict transition graph (`VALID_TRANSITIONS`) + a **role matrix** (`canRoleTransition`) reject illegal moves with `409`/`403`. |
| **No human oversight** | You can't see what the swarm is doing. | Live **SSE** board, per-project metrics, and a "signal rail" activity feed. |
| **No audit trail** | Nothing records how a task reached its state. | Atomic persisted writes; in **git mode**, every transition is a real `git commit ops(<id>): kanban <STATUS>`. |

---

## 4. What it does (capabilities → where it lives)

| Capability | Code location |
|---|---|
| Strict lifecycle `BACKLOG → BUILDING → IN_REVIEW → IN_TEST → DONE` (+`BLOCKED`) | `server/store.js` — `VALID_TRANSITIONS`, `canTransition` |
| Role-gated transitions (builder / reviewer / tester / runner / system / human / admin) | `canRoleTransition`, privileged-role set |
| Lease-based ownership + heartbeat renewal | `applyClaim`, `renewLease`, `claimTask` |
| Background reaper for expired **and orphaned** claims | `reapExpiredClaims`, `startReaper` |
| Race-free writes (process-local mutation lock) | `withMutationLock` (ADR-003) |
| Pluggable persistence (JSON file **or** git-backed YAML) | `JsonStorage`, `GitYamlStorage`, `getStorage` |
| Atomic writes (temp file + `fs.rename`) | `writeAtomic` |
| Real-time push to the UI | `GET /api/events` (snapshot, `?project=` scoped, `?project&mode=diff`) |
| Per-project token isolation (writes) | `middleware/auth.js`, `projectScope.js` |
| Portfolio roll-up view | `components/Portfolio.tsx`, `lib/portfolioMetrics.ts` |
| Metrics & health | `getMetrics`, `routes/metrics.js`, `routes/health.js` |
| Rate limiting per project | `middleware/rateLimit.js` |
| HMAC session tokens **and** static tokens | `sessionAuth.js`, `routes/auth.js` |
| Archive sweeper (aged-out DONE tasks) | `runArchiveSweep` |
| Admin delete + bulk purge | `deleteTask`, `purgeTasks` → `DELETE /:id`, `POST /purge` |
| Per-stage ownership (who acted at each swimlane) | `patchTask`, `lib/stageOwners.ts` |
| Optimistic concurrency (`version` + `If-Match`) | `nextVersionFor`, `versionConflict` |
| Dependency-gated claiming | `dependencyGate` |
| Theming + responsive/mobile layout | `lib/theme.ts`, `index.css`, `components/*.tsx` |

---

## 5. Architecture in one page

```
┌──────────────────────────────────────────────────────────────┐
│  Client — React 18 + Vite + TypeScript + Tailwind            │
│  Board · Column · TaskCard · TaskSheet · Portfolio · SignalRail│
└───────────────▲──────────────────────────┬───────────────────┘
                │ SSE (live push)          │ HTTP (writes)
┌───────────────┴──────────────────────────▼───────────────────┐
│  Transport & security                                        │
│  CORS allow-list · auth (static + HMAC) · rate limit ·        │
│  project scope · input sanitization                          │
└───────────────▲──────────────────────────┬───────────────────┘
                │                          │
┌───────────────┴──────────────────────────▼───────────────────┐
│  Routing — server.js createApp()                              │
│  routes/{tasks, projects, metrics, health, auth}              │
└───────────────▲──────────────────────────┬───────────────────┘
                │                          │
┌───────────────┴──────────────────────────▼───────────────────┐
│  Core engine — store.js                                      │
│  state machine · RBAC · claim/reaper · withMutationLock      │
└───────────────▲──────────────────────────┬───────────────────┘
                │                          │
┌───────────────┴──────────────────────────▼───────────────────┐
│  State & events                                              │
│  in-memory tasks[]/archive{} · listeners · onDiff/onAudit    │
└───────────────▲──────────────────────────┬───────────────────┘
                │                          │
┌───────────────┴──────────────────────────▼───────────────────┐
│  Persistence — writeAtomic                                   │
│  JsonStorage  |  GitYamlStorage                              │
└──────────────────────────────────────────────────────────────┘
```

**The part worth emphasising on stage:** Node is async. Two claims can each
read → validate → write without seeing each other, which is exactly how you get
split-brain ownership. `withMutationLock` chains *every* mutation onto one
process-local promise queue, so contention is resolved deterministically. On top of
that sit three independent safety layers:

1. **Optimistic concurrency** — every task carries a `version`; a stale `If-Match`
   is rejected with `409`.
2. **Leases + reaper** — ownership expires; the reaper reclaims it.
3. **Persist-first, then memory, then broadcast** (the "KB-05" fail-closed idiom) —
   nothing is announced until it is durably written.

This is a deliberate single-process design. ADR-003 is explicit that the lock is
**not** distributed — which is a feature (simple, correct on one node), and the
honest boundary of the current system.

---

## 6. What makes it different

- **Headless-first.** Drag-and-drop is deliberately *omitted*. The primary user is a
  headless agent doing `curl`; the UI is an observability viewport, not the control
  surface.
- **Local-first, zero telemetry, zero cloud.** No accounts, no database, no SaaS, no
  analytics. Runs on `localhost:4000` (API) + `:5173` (UI), or a single small server.
- **Server-enforced determinism.** The state machine and role matrix live on the
  server. `next-claim` takes the role from the *authenticated caller*, never from a
  query string.
- **Leases + reaper.** Ownership is time-bounded, so crashed agents don't wedge work.
- **Persistence is pluggable — and git can be the audit trail.** In git mode, every
  state transition becomes a real commit: `ops(<card-id>): kanban <STATUS>`.
- **Single-process deploy, not serverless.** One Node process serves the API, the
  built SPA, and the SSE stream. It needs a persistent process + a mounted disk
  (because of SSE and the background reaper).
- **Security that is concrete, not aspirational.** Constant-time token comparison,
  fail-closed `503` when unconfigured, per-project token isolation that checks *every*
  channel a project can be referenced through, `escapeHtml` on all agent-authored
  strings, a CI check that bans `dangerouslySetInnerHTML`, a CORS allow-list that
  rejects `*`, and stack-trace-free `500`s.

---

## 7. Engineering credibility

- **Server: 234 passing cases across 37 suites / 24 files.** *(Verified: `node --test`
  in `server/`.)*
- **Client: 68 passing cases across 10 files.** *(Verified: `npm test` in `client/`.)*
- **CI** (`.github/workflows/ci.yml`): runs on every push/PR to `main` across a
  **Node 20.x + 22.x matrix** — install, `make sec` (secret/path leak scan +
  `dangerouslySetInnerHTML` ban), server tests, client status tests, client tests, and
  a production build. The matrix has already caught a Node-20-only bundler failure.
- **Test-first culture:** the handover catalogues defects where *each* fix shipped with
  a regression test verified to fail without it.
- **Architecture Decision Records** in `docs/decisions/`: storage + state machine
  (ADR-001), git commit failure & recovery (ADR-002), process-local mutation
  serialization (ADR-003).
- **Documented surfaces** for newcomers: `ONBOARDING.md` (adopt a project in ~5 min),
  `docs/USER_AND_OPERATOR_MANUAL.md`, `docs/SYSTEM_DESIGN_AND_ARCHITECTURE.md`,
  `docs/FILE_BY_FILE_EXPLANATION.md`.

---

## 8. Adopt it today (the 5-minute on-ramp)

There is **no registration endpoint** — a project is implicit and materialises on the
first task you post under its id (`[A-Za-z0-9_-]+`).

You need three things: a **project id**, a **token**, and a **role** per call.

```bash
BASE=https://agent-kanban.riazrahaman.com
TOKEN=<your project token>          # e.g. from KANBAN_PROJECT_TOKENS
PROJ=my-project

# 1) Create a task (materialises the project)
curl -X POST "$BASE/api/tasks?project=$PROJ" \
  -H "Authorization: Bearer $TOKEN" -H "X-Agent-Role: builder" -H "X-Agent-Id: my-agent" \
  -H "Content-Type: application/json" \
  -d '{"id":"first-task","title":"Hello swarm","round":1,"status":"BACKLOG","project":"my-project"}'

# 2) Claim the next eligible task
curl -X POST "$BASE/api/tasks/next-claim?agent_id=my-agent&project=$PROJ" \
  -H "Authorization: Bearer $TOKEN" -H "X-Agent-Role: builder"

# 3) Advance the lifecycle (role-gated)
curl -X PATCH "$BASE/api/tasks/first-task?project=$PROJ" \
  -H "Authorization: Bearer $TOKEN" -H "X-Agent-Role: builder" \
  -H "Content-Type: application/json" -d '{"status":"IN_REVIEW"}'

# Reads are open — no token needed
curl "$BASE/api/tasks?project=$PROJ"
```

**Four ways to authenticate (owner chooses):**

| Env var | Scope |
|---|---|
| `KANBAN_AUTH_TOKEN` | one global token, every project |
| `KANBAN_ADMIN_TOKEN` | superuser, spans all projects, audited |
| `KANBAN_PROJECT_TOKENS` | JSON map `{project: token}` — per-project isolation |
| `KANBAN_AUTH_SECRET` | enables HMAC **session tokens** via `POST /api/auth/session` |

---

## 9. Contributor on-ramp

```bash
# Server
cd server && npm install && npm start        # API on :4000

# Client (dev)
cd client && npm install && npm run dev      # UI on :5173, /api proxied to :4000

# Verify everything
make test        # full suite
make sec         # security/visual-contract checks
```

- **Where things live:** `server/store.js` is *the* core engine; routes and middleware
  are thin adapters; client `lib/` helpers are deliberately browser/timer-free so they
  unit-test cleanly (`lib/claimCoordinator.ts` is the model for this).
- **Good first contributions:** client polish, additional persistence backends (the
  `getStorage` factory is built to admit SQLite/Postgres/Redis), a metrics/analytics
  UI, and fixing doc drift (see limitations below).
- **Headless demo:** `scripts/test-agents.js` exercises the API without a browser.

---

## 10. Honest limitations (state these — they build trust)

- **In-memory store, single Node process.** All tasks are held in RAM; the system is
  RAM-bound at very large scale.
- **No database backend yet.** The pluggable storage design anticipates one, but JSON
  and git-YAML are what ship today.
- **Single-node only.** The mutation lock is process-local (ADR-003); a distributed
  lock and a WebSocket push channel are explicitly out of scope for now.
- **Reads are not project-isolated.** `KANBAN_PROJECT_TOKENS` isolates *writes*; every
  `GET` (including unscoped `GET /api/metrics`) remains open. This is a documented,
  deliberate follow-up.
- **Token-based auth, not user accounts.** No user model, login, or OAuth — tokens are
  distributed out-of-band. Right for swarms; not yet a multi-tenant human org tool.
- **Admin delete/purge is new.** It ships privilege-gated and tested, but it is young.
- **Deploy needs a persistent disk.** SSE + the background reaper mean you cannot put
  this on serverless/FaaS as-is.
- **Default CORS allows only `localhost:5173`.** Serving the UI from elsewhere without
  setting `KANBAN_ALLOWED_ORIGIN` yields an opaque "Failed to fetch".

---

## 11. Live product tour (screenshots + captions)

All shots captured against the live deployment; zero console/page errors.
Images live in `docs/presentation-images/`.

| # | File | Suggested slide caption |
|---|---|---|
| 1 | `01-board-all.png` | **The board, all projects at once.** Cards carry a project chip when unscoped; the header shows version, scope picker, and a live task count. |
| 2 | `02-picker-open.png` | **Project switcher.** A custom, keyboard-accessible picker (replaced the native `<select>`, which was unreliable in Safari). Options list the real 4-project portfolio. |
| 3 | `03-board-scoped.png` | **Scoped to one project.** The board, the live stream, and auto-claim all follow the chosen scope. |
| 4 | `04-task-sheet.png` | **Task detail.** Description, metadata, and the agent log — who did what, when. This is the audit trail an agent writes as it works. |
| 5 | `05-portfolio.png` | **Portfolio view.** Cross-project roll-up: throughput, work-in-progress, blocked, done. The manager's cockpit. |
| 6 | `06-dark.png` | **Dark mode.** Explicit theme choice beats OS preference; persisted locally, applied pre-paint (no flash). |
| 7 | `07-mobile.png` | **Mobile.** The board becomes a snap-scrolling strip, the signal rail a slide-over drawer, controls enlarge for touch. |

**What impressed** (say it out loud):
- The live signal rail — you can literally watch agents claim, log, and complete work in
  real time.
- The task sheet's agent log renders an honest history: `board-architect claimed this task`,
  `LEASE EXPIRED — task reclaimed`, `Normalized by board admin` — the system shows you its
  own housekeeping.
- Project chips make a multi-tenant board instantly legible.

**What's rough / friction observed:**
- The live board's Backlog is dominated by one project's imported cards (10 `chess`
  tasks) — a first-time visitor sees a busy board rather than an empty inviting one.
- Several DONE cards are test residue; there is no "clean slate" button (purge now
  exists but is API-only, not surfaced in the UI).
- A first-time visitor with no token sees `read-only` — writes require a token the owner
  must hand out; there's no in-app onboarding hint.

**Console / API report:** no page errors; `/api/tasks`, `/api/projects`, `/api/health`,
`/api/events` all `200`.

---

## 12. Narrative suggestions for the talk

- **Title:** *"A kanban board where the users aren't human."*
- **Opening hook:** Show two agents racing for the same task; the board resolves it
  cleanly with one `409`. Then show the reaper rescuing a crashed agent's lease. That's
  the whole story in 30 seconds.
- **The turn:** "Every human board assumes a person will move the card. A swarm doesn't
  work that way. So I stopped building a board for people and built a state machine for
  agents — and a window for people to watch it."
- **The proof:** Show the CI matrix, the ADRs, and the test counts. Reliability is the
  pitch; the live board is the payoff.
- **The ask (community slide):** Adopt it for your own agent swarm today (link
  `ONBOARDING.md`); the best first PRs are a database backend and UI polish. Point to
  the documented limitations as the roadmap.

---

## 13. Numbers you can trust (verify before presenting)

| Claim | Value | How to verify |
|---|---|---|
| Server tests | **234 passing** (37 suites, 24 files) | `cd server && node --test` |
| Client tests | **77 passing** (10 files) | `cd client && npm test` |
| CI matrix | Node **20.x + 22.x** | `.github/workflows/ci.yml` |
| ADRs | 3 | `docs/decisions/` |
| Live task count at capture | 51 (Backlog 10 / Done 41) | live board header |

> **Docs status:** the current figures are 234 server tests and 77 client tests, and
> they are in sync with the README.
