# Multi-Project Enhancements — Handover

**Project:** `agent-kanban-board`
**Authoritative path:** `~/Documents/agend-grid/agent-kanban-board`
**Working branch:** merged to `main` (the former `feat/client-coordinator-phase` branch is retired)
**Roadmap:** `docs/MULTI_PROJECT_ENHANCEMENT_RECOMMENDATIONS.md`
**Status:** §2.2, §2.9, §2.3 and §2.10 are all **DONE**. §2.11/§2.12 remain out of scope.
**Merged:** `main` is at the `--no-ff` merge `91c8df0` and pushed to `origin`.
**Remaining:** nothing blocking. UI verified in a browser; known gaps in §9.
**Last verified:** server 196/196, client 68/68, `tsc` + `vite build` green.
**Working tree:** clean. Everything below is committed.

> This document is partly a frozen historical record; the live state is v2.3.3 on `main`.
> Read §4 "Next steps" first, then §7 (contracts you
> must not break) and §8 (defects already found — do not reintroduce them). Do not
> assume anything is done from the summary alone — run the test commands in §6 to
> confirm before building further.

---

## 1. Where the work lives

| Thing | Location | State |
|---|---|---|
| Roadmap spec | `docs/MULTI_PROJECT_ENHANCEMENT_RECOMMENDATIONS.md` | read-only ref |
| Server diff/audit engine | `server/store.js` | **committed** `9472ce2` + fixes in `706129f`/`8405ac9` |
| Scoped/diff SSE endpoint | `server/server.js` (`GET /api/events`) | **committed** `706129f` |
| Diff SSE client | `client/src/api.ts` (`subscribeToDiffs`) | **committed** `706129f` |
| Metrics engine + route | `server/store.js` (`getMetrics`), `server/routes/metrics.js` | **committed** `3bc7258` |
| Per-project auth + limits | `server/middleware/` (`auth.js`, `projectScope.js`, `rateLimit.js`) | **committed** `a4eb6ef`/`d7bba45` |
| Portfolio + switcher | `client/src/components/Portfolio.tsx`, `client/src/lib/portfolioMetrics.ts`, `App.tsx` | **committed** `f52eecc` |
| Client coordinator | `client/src/lib/` (`claimCoordinator.ts`, `useClaimCoordinator.ts`, `.test.mjs`) | **committed** `8a6f2f1` |
| Client wiring | `client/src/App.tsx` (agent-id input + coordinator) | **committed** `8a6f2f1` |
| Old project | `~/Documents/Claude/Projects/budgeting_app_project/agent-kanban-board` | superseded; its diff is in the stash (see §5) |
| Stashed WIP | `git stash@{0}` | **do not delete** — see §5 |

---

## 2. Git state

Historical branch `feat/client-coordinator-phase` (all commits below are ancestors of `main`):

```
00ef625 fix(u8b): clear stale board error; poll the portfolio instead of guessing
d7bba45 fix(u7b): close composite-id bypass of per-project auth
f52eecc feat(u8): §2.10 project switcher + portfolio view
a4eb6ef feat(u7): §2.3 per-project auth + rate limiting
fee8afc fix(u6b): metrics defects found in review of u6
3bc7258 feat(u6): §2.9 cross-project metrics endpoint
c5a7d1b docs: track handover; record §2.2 done, review fixes, new contracts
3fc3841 fix(u5c): client coordinator defects found in review
8405ac9 fix(u5b): project scoping + audit attribution defects found in review
706129f feat(u5): §2.2 scoped/diff SSE endpoints + audit sinks
9472ce2 feat(u5a): §2.2 diff-event layer + §2.9 audit substrate in store
8a6f2f1 feat(u4): client-side claim coordinator + heartbeat/auto-claim
b59861c feat(u3): claim lease+reaper, dependency-gated claim, fair next-claim queue
abc9b29 feat(u2): optimistic concurrency with version + If-Match/expected_version CAS
e9d54b2 fix(u1): archive sweep persists before in-memory mutation (KB-05)
a31fda5 feat: project namespacing + per-project archiving (§2.1, §2.8)
```

The working tree was clean and nothing staged at this handover; the listed work is merged into `main`.

---

## 3. Completed & verified

### §2.1 / §2.8 — namespacing + per-project archiving
Committed `a31fda5` (+ fix `e9d54b2`). Composite `project/id` keys, per-project storage
partitions, `runArchiveSweep`, `GET /projects`, `GET /tasks/archive`.

### §2.6 — optimistic concurrency
Committed `abc9b29`. `version` field, `expected_version` / `If-Match` CAS, 409 conflict.

### §2.4 + §2.5 + §2.7 — lease, dep-gate, fair next-claim
Committed `b59861c`. `applyClaim`/`applyClaimCore` (lock split), `renewLease`,
`reapExpiredClaims` + `startReaper`/`stopReaper`, dependency-gated claim,
`POST /api/tasks/next-claim`.

### §2.2 (client half) + lease UI — claim coordinator
Committed `8a6f2f1`. `claimCoordinator.ts` (pure decisions: `isMineHeld`,
`needsHeartbeat` window-relative, `shouldAutoClaim`, `selectTasksToHeartbeat`,
`leaseRemainingMs`), `useClaimCoordinator.ts` (React hook: heartbeat held tasks then
auto-claim when idle), `claimCoordinator.test.mjs`, `App.tsx` agent-id binding
input wired to the hook. Four defects in this code were fixed in `3fc3841` — see §8.
**15/15 client tests, build green (46 modules).**

### §2.2 (server diff layer) + §2.9 (audit substrate) — COMMITTED `9472ce2`
Backward-compatible: the snapshot `onChange` contract is unchanged. What it adds:

- `onDiff(listener)` — subscribes to structured diff events
  `{ kind, task, prev?, project, actor, reason?, ts }`.
  `kind` ∈ `created | updated | removed | archived | claimed | renewed | unblocked | reclaimed`.
- `onAudit(fn)` + `emitAudit(...)` — structured audit substrate: one entry per committed
  mutation `{ ts, kind, project, task, prev?, actor, reason? }`. Default sink is a console
  line; extra sinks register via `onAudit`. This is the foundation for §2.9 metrics.
- `notify(opts)` — refactored from `notify()`. Computes created/updated/removed/archived
  by diffing the current task map against `prevTaskMap` (one event per changed task, never
  two). `opts = { actor, reason, semantic }`, where `semantic` is a
  `Map<compositeKey, {kind, actor, reason}>` used to override the inferred kind for the
  exact task just mutated (so a claim surfaces as `claimed`, not `updated`).

Semantic metadata wired at these call sites:
- `applyClaim` → `claimed` (fresh claim) / `renewed` (heartbeat), actor = the agent.
- `unlockTaskInner` → `unblocked`, actor `system`.
- `maybeUnlockDependentsInner` → trailing `notify({actor:'system', reason:'unblocked_batch'})`.
- `reclaimTaskInner` → `reclaimed`, actor `system`, reason = `lease_expired` (or supplied).

**Design note:** an earlier draft of this layer had a fragile "most-recently-updated task"
heuristic for semantic overrides and a separate `notifyWith(kindOverride)` path that could
emit a second event per task. Both were removed in favor of the `semantic` Map keyed on the
exact `compositeKey`. Do not resurrect that heuristic.

---

## 4. Next steps (in order)

### 4.1 §2.2 SSE scoped + diff — DONE (`706129f`)
`GET /api/events` now has three modes: legacy (unchanged, `event: tasks`),
`?project=X` (snapshot filtered to one project), and `?project=X&mode=diff`
(per-task `task.<kind>` events via `onDiff`). `subscribeToDiffs` added client-side;
`subscribeToEvents` untouched. `runArchiveSweep` passes a semantic map so archived
rows surface as `archived`. Covered by `server/test/kanban.events.test.js` (6 tests)
and verified end-to-end against a running server.

Three defects in the uncommitted diff layer were found and fixed while landing this —
see §8. The handover's original step 4 (archive semantic map) could not work as written
until the `removed` branch learned to consult `semantic`.

### 4.1b Review fixes — DONE (`8405ac9`, `3fc3841`)
A review of the whole branch surfaced eight defects in already-committed code; all are
fixed with regressions (each verified to fail without its fix). See §8.

### 4.2 §2.9 — cross-project observability — DONE (`3bc7258`, fixes `fee8afc`)
`GET /api/metrics[?project=X]`. Per project + aggregate: task/live/archived counts, a
`by_status` histogram, cycle time (count/mean/median/p90/min/max), reclaim counts,
active agents, claim contention.

Built from **persisted task fields**, not an `onAudit` accumulator — in-memory counters
reset on restart and would drift from the tasks they describe. That also sidesteps the
trap noted during planning: `dispatchDiffEvents` returns early on its first call to seed
`prevTaskMap`, so `emitAudit` never fires for it and an accumulator registered at boot
would permanently miss the first mutation. Claim contention is the one figure with no
durable source (a rejected claim commits nothing), so it is reported explicitly as
since-boot.

`done_count` is the **live board** and agrees with `GET /api/projects`;
`completed_count` spans archived rows. Cycle time includes archived tasks — they are
exactly the completed work, so excluding them would make cycle time silently improve as
history is swept.

### 4.3 §2.3 — per-project auth & isolation — DONE (`a4eb6ef`, fix `d7bba45`)
`KANBAN_PROJECT_TOKENS` is a JSON map of project -> token; `KANBAN_ADMIN_TOKEN`
optionally spans all. Unset = the previous single-token behaviour, unchanged.
Per-project fixed-window rate limiting on mutations only, off unless
`KANBAN_RATE_LIMIT_PER_MIN` is set.

**The load-bearing detail** (see §7): authorization is checked against *every project a
request references*, not one resolved value — body, `workspace_id`, query,
`X-Kanban-Project` header **and a composite `project:id` in the URL path**. Missing the
path channel made the entire feature bypassable; see §8.

### 4.4 §2.10 — client multi-project UI — DONE (`f52eecc`, fixes `00ef625`)
Header project switcher + a portfolio table. Selecting a project scopes the board, the
SSE subscription and auto-claim together — all server-side, so a scoped board never
receives another project's tasks rather than filtering in the browser. The portfolio is
fed by `/api/metrics` and polls while mounted, because a scoped task stream cannot tell
it about other projects.

### 4.5 §2.11 / §2.12 — FUTURE SCOPE (skip this pass)
Per the roadmap's §4 non-goals, `withMutationLock` hardening (file/Redis/DB lock) and the
WebSocket push channel are out of scope for this pass. Do not implement unless asked.

### 4.6 Merge
The `--no-ff` merge was completed; the listed commits are ancestors of `main`.

---

## 5. Old project + the resolved stash

- **Old project** `budgeting_app_project/agent-kanban-board` (branch `feat/2.2-2.9`,
  commit `d20cd31`) was the earlier home of this work but is **superseded** by this tree.
  Its lease/reaper server code overlaps what is already committed here (`b59861c`); only
  the client coordinator was truly new and it has now been rebuilt + committed here
  (`8a6f2f1`). **The old project is safe to remove once main has been merged** — do not
  delete it yet; confirm the merge first.
- **`stash@{0}` is RESOLVED — rejected, and the stash entry dropped.** It held a
  pre-existing WIP (not written during this work) that renamed `getProjectSummaries`
  fields to camelCase — `task_count`→`totalTasks`, `live_count`→`activeTasks`,
  `done_count`→`completedTasks` — dropped `archived_count` entirely, and rewrote
  `kanban.projects.test.js` to point integration tests at a hardcoded `:3000` without
  starting a server (the cause of the 2 broken tests).

  Rejected for three reasons: it would have been the only camelCase in an API that is
  snake_case throughout (`created_at`, `assigned_agent`, `claim_expires_at`,
  `reclaim_count`, `by_status`, `cycle_time`, …); it breaks the client's `ProjectSummary`
  type and `Portfolio.tsx`, which reads `archived_count`; and the test rewrite was
  broken. The richer counts it was reaching for already shipped in §2.9: `/api/metrics`
  distinguishes `done_count` (live board) from `completed_count` (archived included) and
  carries a full `by_status` histogram.

  **Nothing was lost.** The stash commit is preserved as an annotated tag before the
  entry was dropped:

  ```sh
  git stash apply wip/rejected-camelcase-project-summaries   # recover it
  git show wip/rejected-camelcase-project-summaries          # read the rationale
  ```

  The tag is local-only; `git push origin wip/rejected-camelcase-project-summaries`
  if it should survive this machine.

---

## 6. How to verify (run these)

```sh
cd "$(git rev-parse --show-toplevel)"
# server
cd server && node --check store.js && node --test
# expected: 196 pass across 33 suites / 23 files, 0 fail

cd ../client
# client tests
npx tsc -b                           # expected: exit 0
npm test                             # expected: 68 pass, 0 fail
# build
npm run build                        # expected: tsc clean, vite build ok

cd ..
git status --short                   # expect a clean tree

# What CI runs, in CI's order. Run this BEFORE pushing — the workflow fails
# fast on `make sec`, so a failure there hides every later step.
make sec                             # no /Users or /home paths in tracked files,
                                     # no dangerouslySetInnerHTML in client/src
npm test                             # server tests + scripts/test-client-status.js
                                     # + client tests + client build
```

**`make sec` bans absolute home paths in tracked files.** Writing
`~/Documents/...` or `"$(git rev-parse --show-toplevel)"` keeps a path usable
without hardcoding somebody's home directory. This document broke CI exactly
once by carrying `/Users/<name>/...` in its own header.

CI (`.github/workflows/ci.yml`) runs the same steps on **Node 20.x and 22.x**,
which is stricter than a modern local Node — this repo has already been bitten
by a Node-20-only failure in the `.mjs`/esbuild test path.

Precedent: macOS system `git` is blocked by the Xcode license — always use
`/opt/homebrew/bin/git` (prepend `/opt/homebrew/bin` to `PATH`).
The lease TTL default is 300000 ms (5 min), server on port 4000.

---

## 7. Key contracts a picker-up must not break

- **Composite key** is `${project}/${id}` (see `compositeKey`). Task IDs are unique *within*
  a project, not globally.
- **CAS guard** (`expected_version` / `If-Match`) runs *before* building a candidate; a
  "Version mismatch" 409 is distinct from claim-contention 409 and from
  `dependency_unsatisfied` 409.
- **Semantic diff events** are keyed by `compositeKey` and emit exactly one event per
  changed task. Do not reintroduce a "most-recently-updated task" heuristic.
- **Unchanged rows stay silent.** `dispatchDiffEvents` skips a task whose object is
  identical to the previous snapshot (`prevTask === task`). This relies on the mutation
  paths being copy-on-write (`setTaskInMemory` swaps the object) — if you ever mutate a
  task in place and call `notify()`, its event will be dropped. Semantic overrides fire
  *before* this check, so claim/renew/unblock/reclaim/archive never depend on it.
  Without this guard one mutation fanned out an `updated` for every task in the store.
- **Cross-project results use composite keys.** `reapExpiredClaims` returns
  `reclaimed: ['project/id', ...]`, not short ids — short ids are ambiguous across
  projects. Anything that sweeps or reports across projects must do the same.
- **An invalid `?project=` is a 400**, never a silent widening. `getTasks(undefined)`
  means *all* projects, so a route that lets a bad scope fall through to `undefined`
  hands a caller that believes it is scoped the entire portfolio. The guard is shared
  middleware (`middleware/projectScope.js`) — a new router that forgets it re-opens the
  bug on its own endpoints.
- **Per-project auth authorizes EVERY referenced project, not one "effective" value.**
  There are four channels that can decide which board is touched, and two of them
  outrank `?project=`: a body `project`/`workspace_id` (because `createTask` resolves
  `data.project ?? data.workspace_id ?? projectArg`) and a composite `project:id` in the
  URL path (because `resolveProjectScope` lets that prefix win). Authorizing a single
  resolved value is how this was bypassed once already — see §8. If you add a new way to
  name a project, add it to `referencedProjects()` in the same commit.
- **Decode before parsing a path segment.** `req.path` is still percent-encoded, so
  `beta%3Avictim` contains no literal `:`. Any check that looks for the separator before
  decoding passes the encoded form of the same attack straight through.
- **`done_count` vs `completed_count`.** In `/api/metrics`, `done_count` is DONE on the
  live board (and agrees with `/api/projects`); `completed_count` includes archived rows.
  Cycle time spans archived rows. Keep the two names distinct — collapsing them made the
  two endpoints disagree about the same project the moment a sweep ran.
- **KB-05 fail-closed:** persist to storage first, mutate in-memory only after, then
  notify. The diff/audit layer is a *listener* side effect and must never block or throw
  into a committed write (all emits are `try/catch`-guarded).
- **Reaper runs only in `startServer`**, never in `createApp` (HTTP-contract tests must not
  spawn a timer). It is `unref()`'d and gated on `isReaperEnabled()`.

---

## 8. Defects found and fixed this session

Each has a regression test that was verified to fail without its fix.

**In the (then uncommitted) diff/audit layer — fixed in `706129f`:**

1. `dispatchDiffEvents` fired an `updated` for **every existing task** on every mutation,
   not just changed ones. One create fanned out N events. Broke the "one event per
   changed task" contract and made `mode=diff` useless at scale.
2. The `removed` branch never consulted the `semantic` map. Archiving removes rows from
   the live set, so archived tasks could not be labelled `archived` at all — the
   handover's own step 4.1.4 would have been a no-op as written. The `DONE`→`DONE`
   inference that was supposed to cover this instead mislabelled every ordinary edit of
   a done task as `archived`; it is gone.
3. `onAudit`'s unsubscribe reassigns `auditListeners`, which was declared `const`, so
   every detach threw `Assignment to constant variable` — inside `req.on('close')`,
   where nothing catches it.

**In already-committed code, found by review — fixed in `8405ac9` (server) / `3fc3841` (client):**

4. `reapExpiredClaims` called the 1-arg `getTask(t.id)`, which resolves against
   `default`. For a lease in any other project that returned `null`, `reclaimTaskInner`
   threw, and `startReaper`'s `.catch` swallowed it — so the sweep aborted and every
   remaining expired lease in the batch stayed held. **The reaper was a silent no-op for
   non-default projects**, and where two projects shared a short id it reclaimed the
   wrong one.
5. `nextClaim` accepted `?project=` and discarded it (`void project`), handing an agent
   bound to one project another project's card.
6. An invalid `?project=` resolved to `undefined` → the whole portfolio (see §7).
7. `applyClaim` read `caller.agentId`, but the auth middleware sets `req.caller` as
   `{ agent_id, role }`. Every lease renewal by a real agent was attributed to `system`
   in the audit substrate §2.9 reads from.
8. The agent-id input drove the coordinator per keystroke, so typing `builder-1` issued
   nine auto-claims, eight under partial ids (`b`, `bu`, …), each moving a real task to
   BUILDING with a bogus owner and a live lease. The binding is now committed explicitly
   on blur/Enter.
9. The client's lease window was pinned to the 300000 default, so against a server on a
   60s TTL every held task heartbeated on every 5s tick. `observedLeaseWindowMs` now
   calibrates to the real TTL by observation.
10. The lost-lease pattern used spaced prose while the server sends `not_lease_holder` /
    `not_claimed`, so the documented drop-the-lease recovery was dead code.
11. `useClaimCoordinator` returned a mutable ref, so React was never told to re-render
    and the header's claim/error display was intermittently stale.

**In §2.9 / §2.10 / §2.3, found by review of those commits:**

12. `active_agents` counted an assignment with **no** lease as active — the guard read
    `Number.isNaN(expiry) || expiry > nowMs`, the opposite of its own docstring.
    Reachable from the public API: `createTask` passes a body `assigned_agent` straight
    through without a `claim_expires_at`, and the reaper skips records whose expiry is
    null, so the phantom agent was reported forever with nothing able to clear it.
13. Claim contention was recorded for a lapsed-but-unreaped lease, so the endpoint said
    "two agents raced" beside "nobody holds it". With `KANBAN_REAP_ENABLED` off, a
    polling agent inflated it without bound.
14. `done_count` included archived rows in metrics but not in `getProjectSummaries`.
15. **The §2.3 isolation was bypassable via a composite `project:id` in the URL path.**
    `PATCH /api/tasks/beta:victim?project=alpha` with alpha's token returned 200 and
    rewrote beta's task, because only the query was authorized while
    `resolveProjectScope` resolved to beta. Every task-scoped mutating route was
    affected, and per-project rate budgets were evadable the same way. The first fix was
    itself incomplete — it checked for `:` before percent-decoding, so `beta%3Avictim`
    still worked. Both forms are now covered.
16. The rate-limit bucket map was keyed by unvalidated caller-supplied strings and never
    evicted, growing for the process lifetime.
17. The board's `error` state was never cleared, so a single failed load wedged the UI
    on a stale message permanently — later successful fetches loaded tasks that were
    never displayed.
18. The portfolio refreshed on `tasks.length`, which cannot work for a cross-project view
    fed by a project-scoped stream.

---

## 9. Known gaps

- **The UI has been exercised in a real browser** (Chrome, against a live server with
  two seeded projects). Verified by observation, not inference:
  - Typing a 9-character agent id with the text confirmed in the field issued **zero**
    `next-claim` requests and claimed nothing, with the `unbound · press enter` hint
    shown; pressing Enter then bound it and the coordinator began polling. This is the
    defect that previously fired nine auto-claims under partial ids.
  - The coordinator's error surfaced in the header, which the old mutable-ref hook could
    not do — it had no way to tell React to re-render.
  - The switcher scoped the board (6 tasks → 3, other project absent), and the selection
    plus agent id survived a reload via `localStorage`.
  - Six project switches left the server's established connection count unchanged, so the
    per-change SSE re-subscribe does not leak real `EventSource` connections.
  - The portfolio matched the API exactly and **auto-refreshed a change made in the
    project that was *not* on screen** — the case the previous `tasks.length` key could
    never have caught. Clicking a project opened its board.
  - Killing the server mid-session showed `Failed to fetch`; after restarting, switching
    project cleared it and loaded — previously that error was permanent.
- **Browser mutations now authenticate** (`41b32d2`). The operator supplies a token in a
  masked header field; it is held in localStorage and sent as an `Authorization` header,
  never in a URL and never in the bundle (confirmed by grepping the built assets). It is
  deliberately not a `VITE_` env var, which Vite would inline into the published JS. Two
  causes had to be fixed together: no request carried a token (401), and none carried
  `X-Agent-Role` either (403) — only `nextClaim` happened to pass a role, in its body.
- **Lease renewal was broken end-to-end until `dbdd29a`.** Heartbeats derived their
  project scope from the UI *filter* rather than from the task, so an unscoped board —
  the default view — sent no scope, the id resolved against `default`, and every
  heartbeat 404'd for a task in a named project. Nothing renewed; the reaper reclaimed
  every task once per TTL, forever. This was invisible to the whole test suite and only
  surfaced by watching a real browser against a live server.
- **Coordinator teardown races: fixed.** `agentId` is no longer an effect dependency, so
  the claim loop is created once and lives for the component's life; `runOnce` reads
  `agentRef`, which every render keeps current. Previously each rebind tore the loop down
  and built a new one, and the teardown could not cancel a `nextClaim` already in flight —
  so rebinding could let the *old* agent's claim land on a board no longer watching it,
  leaving that task held until the reaper took it back a full TTL later. It also called
  `loop()` immediately on every rebind, so rapid rebinding meant a claim storm. This was
  a production path, not only a StrictMode artifact; StrictMode's double-mount just made
  it reproducible. Verified against a production build: five rebinds ~360ms apart produced
  claims only on tick boundaries (110s and 11s apart), never one per rebind.
  A genuine unmount mid-claim can still orphan one claim — the request is already on the
  wire — but the page is going away in that case. An `AbortController` per tick would
  narrow it further without closing it, since the server may already have committed.
- **CORS allows an explicit comma-separated origin allow-list** (`KANBAN_ALLOWED_ORIGIN`,
  default `http://localhost:5173`); wildcard `*` is rejected. Serving the client from an
  origin not on that list — including a `vite preview` on 5174 — fails requests with an
  opaque "Failed to fetch" in the UI. Worth checking first when the board loads empty.
- **§2.3 isolates writes, not reads.** With `KANBAN_PROJECT_TOKENS` configured every GET
  stays open, including unscoped `GET /api/metrics`, which aggregates active-agent names
  and cycle times across all projects in one response. This matches the pre-existing
  posture (`GET /api/tasks` and `GET /api/projects` were always open) and §2.3's goal is
  mutation isolation — but an operator who configures per-project tokens may reasonably
  expect reads to be isolated too. Gating reads is a deliberate follow-up, not an
  oversight to patch silently.
- **`stash@{0}` is resolved** — rejected and dropped, preserved as the tag
  `wip/rejected-camelcase-project-summaries`. See §5.
- **`main` includes the completed merge.** The `--no-ff` merge in §4.6 has been run.
