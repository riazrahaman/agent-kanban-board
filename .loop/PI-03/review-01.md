# PI-03 Review — round 1

VERDICT: CHANGES_REQUESTED

Reviewer: reviewer-pi03-glm (glm-5.2, different family from the Codex/gpt builder)
Branch reviewed: `task/PI-03` @ `1f2ee9a`, 3 commits over `main`.
Forbidden-file check: `git diff main...HEAD -- tests/gates/ AGENT_BUILD_SPEC.md` is
empty, and neither path exists in the board repo. Clean.

This is round 1, so findings are whole-diff (no issue ids to render per-issue yet). The
substantive gaps below become ISS ids when the Tester registers them.

---

## 1. Invariants I1–I8 (walked explicitly)

- **I1 (no LLM in decision path):** N/A. The board has no position/price/weight/
  order logic; status is set by deterministic role/state checks, not a model. Holds.
- **I2 (as_of/known_at):** N/A. Cards are workflow records, not market facts. The
  card schema's `updated` is a workflow timestamp, not a fact timestamp.
- **I3 (corrections are new rows, append-only):** Relevant to the loop evidence and
  git history. `agent_logs` and `issues` append rather than rewrite (store.js:523, 555).
  Git transitions append commits, never rewrite history. The diff did not touch the
  desk's audit/message records. Holds.
- **I4 (one path, backtest≡live):** N/A. No execution path exists.
- **I5 (no fabricated values; missing → refuse, never a default):** **PARTIALLY UPHELD,
  with two real gaps.** Genuinely improved:
  - `auth.js:11` — missing/absent `agent_id` → null, not a fake id.
  - `auth.js:12` — missing role → null (no implicit `human`); `store.js:85` treats a
    non-string/null role as unauthorized. This is the load-bearing A07/A01 fix and it
    is correct.
  - `auth.js:21-27` — missing `KANBAN_AUTH_TOKEN` → 503 fail-closed; the `API_TOKEN`
    fallback was deleted. Good.
  - `store.js:398` — missing role → null (no implicit `human`) before the role check.
  BUT:
  - **`store.js:354` — `status: status || existing?.status || STATUSES.BACKLOG`.** A
    create with a blank status silently becomes `BACKLOG`. This is a loud null: a
    missing status is indistinguishable from an explicit `BACKLOG`. For a card schema
    this is arguably a workflow default, but it is untested and undocumented, and it is
    exactly the "missing value becomes indistinguishable from a real one" class the
    spec names as the most expensive bug class. Refuse, don't default.
  - **`store.js:207` — `round: task.round ?? 1`.** A missing round is silently
    fabricated as 1, which directly poisons the §2.5 cap ("handover does not reset the
    caps; a fourth Tester round is a fourth round whoever runs it"). A fabricated round
    number is a fabricated measurement — I5's spirit applies to process counters too.
  The build-report's I5 paragraph addresses auth/role defaults but says nothing about
  these two, so they are not a deliberate decision — they are silent.
- **I6 (retain the dead):** N/A. No instrument universe.
- **I7 (no network in tests):** Holds. `kanban.test.js` uses ephemeral local HTTP
  servers, `mkdtemp`, and a local `git init`; no external service is contacted.
- **I8 (no silent float money rounding):** N/A. No money arithmetic.

---

## 2. Acceptance in spirit — could `npm test` pass for the wrong reason?

The suite is genuinely adversarial in *shape* (7 `it` blocks covering the happy loop,
403/409/400/401/503 rejections, concurrent claims, a simulated persistence failure,
git commit-on-transition). It is not happy-path dressed up as coverage. So the *shape*
is sound — but three specific gaps mean a green run would not catch the bugs that
actually matter here:

- **KB-03 is proven only for the claim endpoint, not for `PATCH assigned_agent`
  (store.js:429, 472).** Claim contention is enforced at `claimTask`, but
  `assigned_agent` is in the unguarded `allowed` patch list at store.js:429 with no
  contention or role check. `PATCH /api/tasks/:id {assigned_agent:"x"}` reassigns a
  card from any holder to any string. So the exact gap KB-03 names — "a second claim
  silently stole the task" — is still open through the PATCH path. The test passes
  because it only probes `/claim`; an adversary who reads the PATCH route steals the
  task in one line, and the suite is green. This is a "passes for the wrong reason"
  case.
- **The commit-failure path is untested (store.js:237).** `GitYamlStorage` now
  *throws* when `git commit` fails, so the only git-backed test
  (kanban.test.js:213) is a happy-path commit check. The build-report's headline
  "commit failures are surfaced, not swallowed" claim — the single most central
  change — has no test asserting it, and no test confirming that on a commit failure
  in-memory state was not mutated (the KB-05 invariant). A regression that re-swallows
  the error would not fail any existing test.
- **`structuredClone` on a task carrying a function/non-clonable field would throw**
  (store.js:397, 479) and hit the 500 handler (server.js:37). Low impact — no route
  currently injects such a field — but it is an untested edge that would surface as a
  generic 500 rather than a 400.

---

## 3. Loud nulls (every `||` / `??` / fallback in the diff)

- `auth.js:11` `agent_id` → null: OK, refused downstream. OK.
- `auth.js:12` role → null: OK, now correct (was the `human` default). Good.
- `auth.js:21` `KANBAN_AUTH_TOKEN` → 503: OK, fail-closed. Good.
- `store.js:354` `status` → `BACKLOG` default: **FLAGGED** — see I5 above.
- `store.js:207` `round` → `?? 1` default: **FLAGGED** — see I5 above.
- `store.js:367-369` `assigned_agent` `!== undefined ? … : existing ?? null`: the
  `!== undefined` correctly allows an explicit `null` clear, but the value is written
  through with **no owner check** — this *is* the §2 finding, restated at the null-coal-
  esce site.
- `client/src/components/Board.tsx:20` `status ?? 'BACKLOG'` render default: a display
  fallback, lower risk, but it should mirror the server contract; a card the server
  rejected as malformed would never reach the client, so it is not load-bearing. Note
  only.
- `routes/tasks.js:41,57` `agentId = body.agent_id || caller.agent_id`: both are
  caller-supplied; the route 400s on empty. No missing value becomes a real one here.
- `store.js:252` `mutationQueue` lock: `run.catch(() => undefined)` prevents one
  failed mutation from poisoning the chain — correct.

---

## 4. Torn writes (multi-step mutations without a transaction)

- **JSON backend (`store.js:148-155`, `writeAtomic` 114-123):** writes the whole
  serialized array to a temp file in the same dir and `rename`s it over the original.
  rename(2) is atomic on the same filesystem, so a crash mid-write leaves either the
  old or the new file, never a truncation. Combined with the in-memory update happening
  *after* `saveTask` resolves (382-383), the KB-05 invariant holds for the JSON
  backend. The failing-storage test (kanban.test.js:186) confirms memory is not mutated
  on a save failure. Good.
- **Git backend (`store.js:191-239`):** this is **not atomic at the git level.** It
  (a) `writeAtomic` one `<id>.yml` card, then (b) `git add` + `git commit` as separate
  commands. Two failure windows:
  1. **Crash between (a) and (b):** the new card sits in the working tree uncommitted.
     On `loadStore()` a fresh `readdir` picks up the on-disk status, so the *board*
     state survives — but it is **not a git commit**. Spec §3.2 states "A status
     change *is* a commit" and §3 "the board cannot drift from reality because the file
     is the reality"; the commit is the append-only record. An uncommitted card is a
     drift window: on the next *successful* transition to that same card, the new
     commit absorbs both the uncommitted and the new change, collapsing two transitions
     into one and losing the intermediate history the append-only model exists to
     preserve. Not corrupting, but a torn write that violates the "every transition is
     its own commit" invariant. Low likelihood, should be documented.
  2. **Crash after the on-disk write, before `updateInMemoryTask`:** next `loadStore()`
     re-reads from disk and recovers. Consistent. OK.
  3. **The commit-failure throw is not itself tested** (see §2) — so the "failures are
     surfaced not swallowed" guarantee is asserted by the reporter, not by a test.
- **Serialization:** `withMutationLock` (store.js:251-255) serializes all mutations so
  two concurrent claims cannot both win, and memory/SSE update only after persistence.
  The concurrent-claim test (kanban.test.js:148) exercises this. Good. Note this lock
  is per-process — a multi-process swarm would still race, but that is outside PI-03's
  single-server scope.

---

## 5. Untested edges

- **Empty / invalid status:** `NOT_A_STATUS` → 400 is tested (kanban.test.js:103).
  A *blank/empty* status is not — it falls to the `store.js:354` default (flagged §3).
- **Duplicate issue id:** `addIssue` de-dupes (store.js:554) but this is untested.
- **Concurrent claims:** tested, one winner + idempotent reclaim (kanban.test.js:148).
  Good.
- **Backward transition from `DONE`:** tested — `409, "DONE is terminal"` (kanban.test.js:90).
  Good.
- **Role that doesn't exist:** `null`/non-string role → 403 tested via missing-role
  (kanban.test.js:66-69). A *malformed but present* role (e.g. `"garbage"`) also falls
  through `canRoleTransition` to `false` → 403, but is not explicitly asserted.
- **Git commit that fails:** **untested** (see §2/§4). This is the one gap that bites
  the central claim of the diff.
- **`PATCH assigned_agent` stealing a claim:** untested and unsafeguarded (see §2).
- **Timezone / boundary date:** N/A for the board; `updated` is `toISOString` UTC.

---

## 6. Design contract (§5)

- **§5.2 layer rule / `tests/arch/test_layering.py`** is written for the desk's
  `src/desk/` Python L0–L8 stack and **does not map onto this Node/Express repo.** The
  board is the existing React+Vite+Tailwind service with its own stack (§9.4.2's
  carve-out); the Python layering test is not a check that runs here. Forcing a fit
  would be wrong. The board has no upward-edge concern equivalent to it.
- **§5.1 visual rules** do not apply to the server-side diff and are out of scope for
  PI-03's acceptance (the ISSUES swimlane addition, `Board.tsx`, is a structural
  feature, not a §5.1 token audit, which is PI-04/KB-11). Skipped per the task's
  carve-out, as instructed.
- **ADR presence (§5.2 last paragraph):** `docs/decisions/ADR-001` exists and was
  updated for the role/auth/lock decisions. However, **two non-obvious decisions are
  recorded incompletely, and one is not recorded at all:**
  - The **git-backend commit granularity / failure mode** — the desk now *throws* on a
    commit failure instead of logging-and-continuing, and there is the torn-write
    window in §4.1. This is a behavioral contract change with real consequences
    (a thrown 500 on a transient git hiccup; collapsed history on a crash window).
    ADR-001 §6 says nothing about it. This is exactly the "retry policy / commit
    strategy that should have an ADR" the spec names. It should be added.
  - The **mutation-queue lock** (a deliberate serialization for concurrency) is a
    non-obvious decision; ADR-001 §3 mentions claim contention but not the
    queue mechanism. Worth a sentence.

---

## 7. Build-report self-report check (not relied upon, verified by read)

- "7 passing suites" — the file has 7 `it` blocks (6 `describe`). Accurate.
- "no network" — confirmed by read (`kanban.test.js` uses no external service).
- "commit failures surfaced not swallowed" — true in code (store.js:237), **but
  untested** (no test stubs a failing commit). A claim, not evidence.
- "removed implicit human role" — confirmed (auth.js:12, store.js:85, 398).
- The report is honest about the git default being desk-specific. Good.

---

## Findings (file:line — what is wrong — why it matters)

1. `server/store.js:429` (+ 367-369) — `assigned_agent` is in `patchTask`'s unguarded
   `allowed` list with no contention or role check, so `PATCH /api/tasks/:id
   {assigned_agent:"x"}` steals a card from any holder to any string. Why it matters:
   this is the exact KB-03 gap ("a second claim silently stole the task") reintroduced
   on the PATCH path; the suite is green only because it never probes PATCH.

2. `server/test/kanban.test.js:213` / `server/store.js:237` — the commit-failure path
   (`_tryGitCommit` throwing) is untested; no test stubs a failing `git commit` to assert
   the failure surfaces and that memory is not mutated on it. Why it matters: the
   diff's central claim ("commit failures surfaced, not swallowed") is asserted by the
   build report, not proven by a test; a regression that re-swallows the error passes
   `npm test`.

3. `server/store.js:354` — blank/missing status silently becomes `BACKLOG`; it is a
   loud null indistinguishable from an explicit `BACKLOG` (I5). Refuse, don't default.
   Why it matters: a malformed create that should be refused instead produces a card.

4. `server/store.js:207` — `round` silently fabricated as `1` when absent. Why it
   matters: a fabricated round number poisons the §2.5 iteration caps, which I5's spirit
   (no fabricated measurement) is meant to protect.

5. `server/store.js:191-239` — git-backed write is not atomic at the git level: a
   crash between the on-disk card write and `git commit` leaves an uncommitted card that
   the next commit silently absorbs, collapsing two transitions into one. Why it matters:
   it breaks §3.2's "every transition is its own commit / the file is the reality"
   append-only guarantee; the torn-window behavior must at least be documented in
   ADR-001 and ideally guarded (commit, then write only on commit success, or a
   `.tmp-<id>.yml`→commit→rename sequence).

6. `docs/decisions/ADR-001-…md` — the commit-failure-throw decision and the
   mutation-queue lock are non-obvious decisions with consequences but are not recorded
   (§5.2 requires an ADR for each). Why it matters: the architecture drifts silently
   across the 12 KB tasks; the failure-mode contract for the desk's git backend is
   unknown to any later reader.

7. Minor: `server/test/kanban.test.js` — duplicate issue id (`addIssue` de-dupe) and
   a malformed-but-present role are untested; add them so the "refuse, don't default"
   guarantee is actually evidenced.

---

## Verdict rationale

The core A07/A01 fixes (fail-closed auth, removed `human` elevation, claim lock) are
correct and genuinely improved over the pre-PI-03 state, and the forbidden-file check
is clean. But the two structural issues (KBB-03 bypass via PATCH; untested commit-failure
path) plus the two I5 loud nulls are exactly the bug classes this loop exists to catch,
and `npm test` cannot see them. This is a CHANGES_REQUESTED round, not an escalation:
nothing here conflicts with the spec, a dependency outside §9.3 is needed, or a gate
appears wrong. Six findings, all fixable in one commit.
