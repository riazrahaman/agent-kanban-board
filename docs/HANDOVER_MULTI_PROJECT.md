# Multi-Project Enhancements — Handover

**Project:** `agent-kanban-board`
**Authoritative path:** `/Users/riazrahaman/Documents/agend-grid/agent-kanban-board`
**Working branch:** `feat/client-coordinator-phase`
**Roadmap:** `docs/MULTI_PROJECT_ENHANCEMENT_RECOMMENDATIONS.md`
**Status:** **IN PROGRESS** — §2.2 complete (engine + endpoints + client); §2.9/§2.3/§2.10 remaining.
**Last verified:** server 93/93 tests pass, client 15/15 tests pass, client build green.
**Working tree:** clean. Everything below is committed.

> This document is a resume point. Read §4 "Next steps" first, then §7 (contracts you
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
| Client coordinator | `client/src/lib/` (`claimCoordinator.ts`, `useClaimCoordinator.ts`, `.test.mjs`) | **committed** `8a6f2f1` |
| Client wiring | `client/src/App.tsx` (agent-id input + coordinator) | **committed** `8a6f2f1` |
| Old project | `/Users/riazrahaman/Documents/Claude/Projects/budgeting_app_project/agent-kanban-board` | superseded; its diff is in the stash (see §5) |
| Stashed WIP | `git stash@{0}` | **do not delete** — see §5 |

---

## 2. Git state

Branch `feat/client-coordinator-phase` (main is clean — `--no-ff` merge planned):

```
3fc3841 fix(u5c): client coordinator defects found in review
8405ac9 fix(u5b): project scoping + audit attribution defects found in review
706129f feat(u5): §2.2 scoped/diff SSE endpoints + audit sinks
9472ce2 feat(u5a): §2.2 diff-event layer + §2.9 audit substrate in store
8a6f2f1 feat(u4): client-side claim coordinator + heartbeat/auto-claim (Phase 2.2)
b59861c feat(u3): claim lease+reaper, dependency-gated claim, fair next-claim queue (§2.4/§2.5/§2.7)
abc9b29 feat(u2): optimistic concurrency with version + If-Match/expected_version CAS (§2.6)
e9d54b2 fix(u1): archive sweep persists before in-memory mutation (KB-05)
a31fda5 feat: project namespacing + per-project archiving (§2.1, §2.8)
```

The working tree is clean and nothing is staged. `main` is still untouched.

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

### 4.2 §2.9 — cross-project observability  ← NEXT

**Three constraints that are easy to get wrong here:**
1. The invalid-`?project=` guard is middleware on the **tasks router**, not the app. A
   metrics router mounted separately re-opens the bug: `?project=my%20proj` would
   silently aggregate the whole portfolio. Lift the guard to app level or repeat it.
2. `dispatchDiffEvents` returns early on its first call (it seeds `prevTaskMap`), so
   `emitAudit` does not fire for it either. An `onAudit` accumulator registered at boot
   permanently misses the first mutation — force one priming `notify()` in `startServer`.
3. For reclaim counts prefer the **persisted** `reclaim_count` field over accumulating
   audit `reclaimed` events: in-memory counters reset on restart and the endpoint would
   then disagree with the tasks it is describing.

- Add `GET /api/metrics?project=X` (and unscoped = aggregated). Return per-project +
  aggregate: cycle time (BACKLOG→DONE, from `created_at`/`completed_at`), reclaim count
  (sum of `reclaim_count` / audit `reclaimed` events), claim-contention rate, active-agent
  count. Wire an `onAudit` consumer to accumulate counters (per-project + global) so the
  metrics read a maintained structure instead of recomputing from logs.
- Replace/annotate ad-hoc `console.warn`/`console.error` mutation logging to route through
  the audit layer where it makes sense (keep KB-05 fail-closed behavior).
- Commit as `feat(u6): §2.9 metrics endpoint + audit accumulation`.

### 4.3 §2.3 — per-project auth & isolation
- Extend `server/middleware/auth.js`: accept per-project tokens / JWT with a `project`
  claim, so a compromised agent in one project cannot mutate another's board. Per-project
  rate limiting. Maintain backward-compat with the single `KANBAN_AUTH_TOKEN` when no
  per-project config is present (fall back to current global check).
- Commit as `feat(u7): §2.3 per-project auth + rate limiting`.

### 4.4 §2.10 — client multi-project UI
- Project switcher/filter in the header (tabs or dropdown) instead of one flat board.
- `Portfolio` view: one row per project with WIP/blocked/done counts, fed by
  `getProjects()` (`ProjectSummary`).
- Commit as `feat(u8): §2.10 project switcher + portfolio view`.

### 4.5 §2.11 / §2.12 — FUTURE SCOPE (skip this pass)
Per the roadmap's §4 non-goals, `withMutationLock` hardening (file/Redis/DB lock) and the
WebSocket push channel are out of scope for this pass. Do not implement unless asked.

### 4.6 Merge
When §2.2/§2.3/§2.5(verify)/§2.9/§2.10 are all green:
```
/opt/homebrew/bin/git checkout main
/opt/homebrew/bin/git merge --no-ff feat/client-coordinator-phase -m "merge: multi-project enhancements §2.2-§2.10"
```
`main` must stay clean until then.

---

## 5. Old project + stash (do not delete the stash)

- **Old project** `budgeting_app_project/agent-kanban-board` (branch `feat/2.2-2.9`,
  commit `d20cd31`) was the earlier home of this work but is **superseded** by this tree.
  Its lease/reaper server code overlaps what is already committed here (`b59861c`); only
  the client coordinator was truly new and it has now been rebuilt + committed here
  (`8a6f2f1`). **The old project is safe to remove once main has been merged** — do not
  delete it yet; confirm the merge first.
- **`git stash@{0}` on `feat/client-coordinator-phase`** holds a pre-existing WIP that is
  **NOT mine**: a `getProjectSummaries` camelCase field rename
  (`task_count`→`totalTasks`, `live_count`→`activeTasks`, `done_count`→`completedTasks`)
  plus a rewritten `kanban.projects.test.js` that points integration tests at a hardcoded
  port `:3000` without starting its own server (this is what broke 2 server tests). It is
  **inconsistent** with the client's snake_case `ProjectSummary` type. Decide intent
  before touching it: reconcile the field names across server + client, or drop it. Do NOT
  `stash drop` it until that decision is recorded.

---

## 6. How to verify (run these)

```sh
cd /Users/riazrahaman/Documents/agend-grid/agent-kanban-board
# server
cd server && node --check store.js && node --test
# expected: 93 pass, 0 fail  (grows as §2.9 tests are added)

cd ../client
# client tests
node --test 'src/**/*.test.mjs'      # expected: 15 pass, 0 fail
# build
npm run build                        # expected: tsc clean, vite build ok

cd ..
git status --short                   # expect a clean tree
git stash list                       # confirm stash@{0} still present
```

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
  hands a caller that believes it is scoped the entire portfolio.
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
