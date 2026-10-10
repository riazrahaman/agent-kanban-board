# Instructions: migrate `agent-kanban-board` from 5 states to the AgentOS 8-state workflow

**Audience:** an engineering agent working in the `agent-kanban-board` repo (v2.16.3).
**Origin:** AgentOS PRD review, decision D2. AgentOS (PRD §11) specifies 8 states; the board enforces 5. We are **upgrading the board to the 8 states** rather than mapping between them.
**Status:** instructions only. Nothing has been changed or tested yet. Read the repo's `CLAUDE.md` first; its release discipline and test-contract rules apply.

---

## 1. Goal

Replace the board's lifecycle

```
BACKLOG → BUILDING → IN_REVIEW → IN_TEST → DONE        (+ BLOCKED side state)
```

with the AgentOS lifecycle

```
BACKLOG → READY → PLANNING → IN_PROGRESS → IN_REVIEW → VALIDATION → READY_TO_SHIP → DONE   (+ BLOCKED side state)
```

`BLOCKED` stays. The PRD has no blocked state; the PRD will be amended to add it.

### Status mapping (old → new)

| Old (board) | New (AgentOS) | Notes |
|---|---|---|
| `BACKLOG` | `BACKLOG` | unchanged |
| *(none)* | `READY` | new: backlog item whose dependencies are satisfied and acceptance criteria exist |
| *(none)* | `PLANNING` | new: active, claim-gated |
| `BUILDING` | `IN_PROGRESS` | rename |
| `IN_REVIEW` | `IN_REVIEW` | unchanged |
| `IN_TEST` | `VALIDATION` | rename |
| *(none)* | `READY_TO_SHIP` | new: validated, awaiting release/merge. Queue state (not claim-gated) |
| `DONE` | `DONE` | unchanged, terminal |
| `BLOCKED` | `BLOCKED` | unchanged |

Naming rule: keep the board's `UPPER_SNAKE` convention. Display titles: Backlog, Ready, Planning, In Progress, In Review, Validation, Ready to Ship, Done, Blocked.

---

## 2. Decisions to make first (write an ADR in `docs/decisions/`)

The repo already keeps ADRs there (status vocabulary is "ADR-001"). Add a new ADR **before coding**, answering:

1. **Claim target.** Today `POST /claim` lifts `BACKLOG → BUILDING` and records the claimant in `stage_owners`. Recommended: claim lifts `READY → IN_PROGRESS` (preserves what existing builder agents expect); `PLANNING` is entered by an explicit role-gated PATCH by the planner/architect. Alternative: claim lifts to `PLANNING`. **Pick one.**
2. **Can `BACKLOG` be claimed directly?** Recommended: no. Only `READY` is claimable. Promotion `BACKLOG → READY` is a role-gated transition (planner/human/system). Consider auto-promotion when dependencies become satisfied (see existing `maybeUnlockDependents`, store.js ~L1954).
3. **Is `PLANNING` mandatory?** Recommended: optional. Allow `READY → IN_PROGRESS` directly so simple tasks skip planning.
4. **`READY_TO_SHIP` ownership.** Recommended: queue state, no lease, no claim; only a `releaser`/human/system may enter and leave it.
5. **Version bump.** This breaks the public API vocabulary of a hosted instance. Recommended: **major bump to 3.0.0** with back-compat aliases (section 5).

If any of these is unresolved, stop and ask the owner. Do not guess.

---

## 3. Server changes

### 3.1 `server/state-machine.js` (pure module, no I/O)

- Add the new statuses to `STATUSES`; rename `BUILDING → IN_PROGRESS`, `IN_TEST → VALIDATION`; add `READY`, `PLANNING`, `READY_TO_SHIP`.
- `normalizeStatus`: keep accepting old names as aliases so old clients and stored data keep working: `BUILDING → IN_PROGRESS`, `IN_TEST → VALIDATION` (and keep the existing `TODO → BACKLOG`). **Note:** it currently maps `IN_PROGRESS → BUILDING`; that alias must be reversed.
- Replace `VALID_TRANSITIONS` with (adjust per the ADR):

```
BACKLOG        -> READY, BLOCKED
READY          -> PLANNING, IN_PROGRESS, BACKLOG, BLOCKED
PLANNING       -> IN_PROGRESS, READY, BLOCKED
IN_PROGRESS    -> IN_REVIEW, PLANNING, BLOCKED
IN_REVIEW      -> VALIDATION, IN_PROGRESS, BLOCKED
VALIDATION     -> READY_TO_SHIP, IN_PROGRESS, BLOCKED
READY_TO_SHIP  -> DONE, IN_PROGRESS, BLOCKED
BLOCKED        -> BACKLOG, READY, PLANNING, IN_PROGRESS, IN_REVIEW, VALIDATION
DONE           -> (terminal)
```

- Update `canRoleTransition`. Existing roles: `builder`, `reviewer`, `tester`, plus privileged `runner/system/human/admin`. Required behaviour:
  - `planner` (new): `BACKLOG→READY`, `READY→PLANNING`, `PLANNING→IN_PROGRESS`, and back to `READY`.
  - `builder`: `→ IN_PROGRESS`, `→ IN_REVIEW`.
  - `reviewer`: `→ VALIDATION`, or return to `IN_PROGRESS`.
  - `tester` (this is the PRD's validator; accept `validator` as an alias): `→ READY_TO_SHIP`, or return to `IN_PROGRESS`. **Change from today:** testers currently set `DONE`; they must no longer.
  - `releaser` (new): `READY_TO_SHIP → DONE`.
  - `BLOCKED` stays privileged-only.
  - Update the doc comments in the module to match.

### 3.2 `server/store.js` (~3.5k lines; make targeted edits)

Every site that special-cases the old trio `BUILDING / IN_REVIEW / IN_TEST` must be revisited. Introduce a single exported constant, e.g. `ACTIVE_STATUSES = [PLANNING, IN_PROGRESS, IN_REVIEW, VALIDATION]`, and replace the scattered inline checks with it. Known sites (line numbers are approximate for v2.16.3; search for `STATUSES.BUILDING`, `STATUSES.IN_REVIEW`, `STATUSES.IN_TEST`):

| Area | Approx. lines | Required change |
|---|---|---|
| Active-task counting | ~160 | use `ACTIVE_STATUSES` |
| Create-time gate (BUG-03) | ~1303-1308, `IMPORT_GATED_STATUSES` ~1664 | gate `PLANNING, IN_PROGRESS, IN_REVIEW, VALIDATION, READY_TO_SHIP, DONE`. `BACKLOG`, `READY`, `BLOCKED` stay open to unprivileged creation |
| PATCH claim contract | ~1427-1465 | entry into any `ACTIVE_STATUSES` still requires the claim contract; record `stage_owners[nextStatus]`. `READY_TO_SHIP` is **not** claim-gated |
| Claim (`POST /claim`) | ~1735-1816 | per ADR: source `READY` (and not `BACKLOG`), target per ADR; `stage_owners` key becomes the new status name |
| Admin/orchestrator claim path | ~2126-2174 | same as above |
| Lease reaper | ~2063, ~2238-2255, ~2326 | reaper checks `ACTIVE_STATUSES`; an expired active claim resets to **`READY`** (today it resets to `BACKLOG`; resetting to BACKLOG would lose the "ready" signal). Update the comment and tests |
| Dependency unlock | ~1604-1610, ~1872-1960 | `BLOCKED → BACKLOG` unlock logic: decide whether it should land on `BACKLOG` or `READY` when dependencies clear |
| Column colour map | ~751 | add colours for `READY`, `PLANNING`, `READY_TO_SHIP`; rename keys. This mirrors `client/src/components/Column.tsx` |
| Restore from trash/archive | ~3219 | status handling after restore |

Also check: webhooks, notifier messages, metrics (`routes/metrics`, `kanban.metrics.test.js`), and any `status ===` literal in `server/routes/*`.

### 3.3 Data migration (important: a hosted instance with live data)

- On load (`store.js` ~L428-500, where legacy records already get `version` defaults), rewrite stored statuses: `BUILDING → IN_PROGRESS`, `IN_TEST → VALIDATION`. Also rewrite keys inside `stage_owners` (`BUILDING → IN_PROGRESS`, `IN_TEST → VALIDATION`), and statuses in archive and trash files.
- Migration must be **idempotent** and must **bump nothing** other than what is needed; do not change `version` just for the rename unless the tests demand it. Decide and document.
- Take a backup first. The store has backup support (`kanban.backup.test.js`, `docs/RESTORE.md`). Add a test that loads a fixture of old-vocabulary data and asserts the new vocabulary.
- Audit-log and journal entries (`auditLog.js`, `GitYamlStorage`) hold historical status strings. Do **not** rewrite history; make readers tolerate old names via `normalizeStatus`.

---

## 4. Client changes (`client/src/`)

| File | Change |
|---|---|
| `lib/status.ts`, `status.js` | New `CANONICAL_STATUSES`; `ACTIVE_STATUSES` becomes the four active states; keep legacy aliases in `normalizeStatus` |
| `types.ts` | `TaskStatus` union: add new names, keep legacy aliases for older stored data |
| `board-model.js`, `board-model.d.ts` | `COLUMNS` array: 8 columns plus Blocked, Unknown, Issues, with `stepNumber` 01-08 and updated titles |
| `components/Column.tsx`, `StatusBadge.tsx`, `lib/columnColors.ts` | colours and labels for the new states. **Respect `DESIGN.md`**: no `shadow-*`, no `rounded-full`, and no Tailwind class strings interpolated in templates |
| `lib/stageOwners.ts`, `portfolioMetrics.ts`, `dashboardMetrics.ts`, `signalStats` | replace hard-coded old status names |
| `App.tsx`, `lib/aboutContent.ts` | wording; **`aboutContent.ts` hard-codes the client test count and `about.test.mjs` asserts it. Update the number if you add or remove client test cases** |

Layout check: 8 + side columns is much wider than 5. Check desktop and mobile layouts (`responsive.test.mjs`, `mobileToolbar.test.mjs`, `scripts/check-header-layout.mjs`). Verify mobile with real emulation, not a headless `--window-size` (see `CLAUDE.md`).

---

## 5. Backward compatibility (agents are using this board today)

- The `skills/kanban/SKILL.md` flow and any running agents use `BUILDING` / `IN_TEST` and the claim → PATCH sequence. Keep **accepting** the old names on input (aliases) for at least one major version. Responses use the **new** names; call this out in the changelog.
- Update `skills/kanban/SKILL.md` (and the frontmatter version) to the new vocabulary and role flow: planner → builder → reviewer → tester/validator → releaser.
- Update `docs/` (state machine diagrams `docs/images/02-state-machine-rbac-graph.svg`, `10-swarm-lifecycle-flowchart.svg`, `12-diagnostic-decision-tree.svg`; `Agent_Kanban_Board_OnePager_v5.html`; the manuals). Regenerate or hand-edit the SVGs.

---

## 6. Tests

~25 server test files and ~15 client test files reference the old names. Work through them rather than loosening them.

- Update every assertion that hard-codes `BUILDING` / `IN_TEST` or the old transition table.
- **Add:**
  - transition-table tests for every legal and illegal pair (including `READY_TO_SHIP` and `PLANNING`);
  - role-matrix tests (planner, tester no longer sets `DONE`, releaser sets `DONE`);
  - claim only from `READY`; `BACKLOG` claim rejected with the expected 409 shape;
  - reaper resets expired claims to `READY`;
  - migration fixture test (old data in, new data out, idempotent on a second load);
  - alias test: PATCH with `BUILDING` / `IN_TEST` is accepted and stored as the new name.
- Run the full suite: `npm test` (server tests + `scripts/test-client-status.js` + client tests + client build) and `make sec`.

---

## 7. Release discipline (enforced by CI)

Follow the `CLAUDE.md` "Release discipline" section exactly:
bump `server/package.json` and root `package.json` (to the version chosen in the ADR); add a `CHANGELOG.md` section plus the tag list; update version headers in `docs/` and `docs/with-images/`; update `skills/kanban/SKILL.md` frontmatter; run `npm --prefix server install --package-lock-only`; annotated tag only after CI is green. Never write absolute home-directory paths into tracked files (`make sec` fails on them).

Deploy is Railway, and the hosted instance is the real board. Ship the migration with a backup taken first and a rollback plan (`docs/RESTORE.md`).

---

## 8. Suggested order of work

1. ADR with the five decisions in section 2 (get owner sign-off).
2. `state-machine.js` + its unit tests.
3. `store.js` edits with `ACTIVE_STATUSES` refactor, then data migration + migration test.
4. Server tests green.
5. Client types, columns, colours, then client tests and the `aboutContent.ts` count.
6. Skill file, docs, diagrams, changelog, version bump.
7. `npm test` + `make sec`, then deploy with a backup in hand.

## 9. Out of scope

Do not change auth, SSE, multi-project scoping, storage backends, or the bug-report feature. Do not add AgentOS-specific fields to tasks yet (workflow binding, execution binding, cost); those belong to AgentOS phase P4.

## 10. Caveats from the analysis

- Line numbers and the file list come from a text search, not from running the code. Verify each site before editing.
- The "illegal transition returns 409 with optimistic concurrency" behaviour is confirmed in `store.js`; there are two distinct 409s (version mismatch vs invalid transition/claim contention). Preserve both.
- I have not run the test suite, so the baseline pass/fail state is unknown. Run `npm test` before starting so regressions are attributable.
