# Issue: cards are reset to `READY` while their lease is still live

**Area:** `server/store/leases.js` — `reapExpiredClaims` / `reclaimTaskInner`
**Contributing assumption:** `server/store.js` — lease renewal is holder-only
**Severity:** medium. No data loss; workflow state and ownership are destroyed and the board misreports progress.
**Status:** fixed in v3.20.0 — option 6.1 (`KANBAN_STAGE_STALL_MS`) and section 7 (lease fields in the reclaim log) shipped; option 6.2 (lease transfer on transition) remains open as a follow-up. Originally reproduced from the code path, from a reaped card's own log, and by deterministic replay with the injectable clock.

---

## 1. What happens

A card that is genuinely mid-work — typically in review or validation — is reset to `READY`, its owner and lease are cleared, and `reclaim_count` is incremented. The card log says:

```
PROGRESS STALLED — task reclaimed to READY by system reaper.
```

The card's lease had **not** expired at that moment.

Observed on a production card (`design-board-width-cap`, `reclaim_count: 2`):

```
2026-11-25T16:58:44.194Z  progress_stalled  PROGRESS STALLED — task reclaimed to READY by system reaper.
2026-11-25T17:57:45.406Z  progress_stalled  PROGRESS STALLED — task reclaimed to READY by system reaper.
```

Both reclaims happened inside a claim taken with `lease_ms: 7200000` (the 2-hour maximum). The third card reclaimed in the same sweep was reclaimed a third time later the same evening.

Nothing is corrupt afterwards: the branch, the commits and `stage_owners` survive. What is lost is the answer to "where is this card?" — it reads as untouched work when it is in fact built, reviewed and tested.

---

## 2. Why it happens

`reapExpiredClaims` walks candidates in this order:

| # | Condition | Reason emitted |
|---|---|---|
| 1 | `READY` **with** an owner whose `claim_expires_at <= now` | `lease_expired` |
| 2 | status not active | skipped |
| 3 | status `READY_TO_SHIP` | **always skipped** |
| 4 | active, no owner / no lease, `updated` older than `KANBAN_ORPHAN_GRACE_MS` | `orphan_normalized` |
| 5 | active, `last_progress_at` older than `KANBAN_PROGRESS_STALL_MS` | `progress_stalled` |
| 6 | active, `claim_expires_at <= now` | `lease_expired` |

Row 5 runs **before** row 6 and **never consults the lease**. The effective rule is therefore:

> An active card that has not been written to for the stall window is reclaimed, regardless of whether its owner has declared itself alive.

Two consequences follow:

- The stall window (default 30 minutes) is shorter than the maximum lease (2 hours), so the two signals contradict each other for any long lease.
- `reclaimTaskInner` then forces the status to `READY` — the one sanctioned exception to the agent state machine — and clears `assigned_agent`, `claim_expires_at` and `claim_lease_ms`.

### Defaults (all env-overridable, read at call time)

| Setting | Default | Meaning |
|---|---|---|
| `KANBAN_CLAIM_TTL_MS` | 600000 (10 min) | lease when the caller does not ask for one |
| `KANBAN_MIN_LEASE_MS` / `KANBAN_MAX_LEASE_MS` | 60000 / 7200000 | clamp on `lease_ms` |
| `KANBAN_PROGRESS_STALL_MS` | 1800000 (30 min) | idle-card window (row 5) |
| `KANBAN_ORPHAN_GRACE_MS` | 300000 (5 min) | ownerless-card grace (row 4) |
| `KANBAN_REAP_INTERVAL_MS` | 30000 | sweep cadence |

---

## 3. Why multi-role cards are the ones that get hit

`last_progress_at` is refreshed by any commit on the card:

| Path | Location |
|---|---|
| claim (non-renewal) | `server/store.js:1245` |
| PATCH | `server/store.js:893` |
| assign (not a release) | `server/store.js:1717` |
| log append | `server/store.js:2057` |

But the **lease** is renewed only when the writer is the lease holder:

```js
if (candidate.assigned_agent && candidate.assigned_agent === agentId && candidate.claim_expires_at) {
  // extend the claim clock
}
```

That rule is deliberate and documented — "any agent may patch fields on a task, so a non-holder must never inherit or extend someone else's claim" — and `KANBAN_HOLDER_WRITE_RENEWS_ALL` only renews the holder's *other* cards. It cannot help a different agent writing to this one.

The failure sequence is therefore structural, not accidental:

1. `builder` claims the card (often with a long `lease_ms`) and does the work.
2. It transitions the card to `IN_REVIEW` and stops writing.
3. The reviewer is refused the claim (`409 already claimed by builder-1`), so it logs and patches status **without** the lease — the sanctioned workaround.
4. Review and test are long, quiet stages: reading, running suites, waiting on agents. A stage advance is one write, then 30+ minutes with none.
5. Row 5 fires on the next sweep. The card is reset while the builder's lease is still valid.

Cadence varies by workflow, but the pattern is deterministic: any stage that takes longer than the stall window to produce its next card write will be reaped.

`READY_TO_SHIP` is already exempt (row 3) for precisely this reason — "the tester's job is finished; nothing legitimately advances progress". `IN_REVIEW` and `VALIDATION` are the same kind of state and are not exempt.

---

## 4. Reproduction

1. Claim a card with `lease_ms: 7200000`.
2. PATCH it to `VALIDATION`.
3. Write nothing to that card for `KANBAN_PROGRESS_STALL_MS`.
4. Observe: `status: READY`, `assigned_agent: null`, `reclaim_count + 1`, a `progress_stalled` log entry — and `claim_expires_at` still in the future at the instant of reclaim.

Deterministic test form: the reaper clock is injectable via `setNowFn`, so no wall-clock wait is required.

---

## 5. Impact

| Area | Effect |
|---|---|
| Data | None. Branch, commits and `stage_owners` survive. |
| Workflow | Status and owner lost. The card reappears as unstarted work; anyone watching the board draws the wrong conclusion. |
| Audit | `reclaim_count` inflates; `stage_owners` still records the real history, so the record contradicts the status. |
| Operators | Alerts keyed on `progress_stalled` fire for healthy cards, which trains people to ignore them. |
| Recovery | Work is not lost but must be re-claimed and re-walked through the stages, costing a full cycle of board writes per card. |
| Metrics | Reclaim counts and stall rates measure agent silences, not agent failures. |

Affected population: any card whose stage takes longer than the stall window to produce its next write — in practice, review and validation of anything non-trivial.

---

## 6. Options

### 6.1 Give review stages their own window (recommended first change)

Mirror the existing `READY_TO_SHIP` exemption. `IN_REVIEW` and `VALIDATION` mean "the work is committed, a decision is pending" — that is not an activity clock. Introduce `KANBAN_STAGE_STALL_MS` (e.g. 24 h) and apply it to those two statuses in row 5, keeping the 30-minute window for `IN_PROGRESS`/`PLANNING`.

- Small, local, reversible; no state-machine change.
- Preserves the alive-but-wedged detection that `kanban.stallreaper.test.js` deliberately encodes, because `IN_PROGRESS` keeps the short window.
- Does not fix ownership: the card is still owned by an agent that has moved on, and it will still be reclaimed when the lease lapses.

### 6.2 Transfer the lease to the acting role on a legal transition (recommended follow-up)

When a role-bound credential performs a legal transition (`IN_PROGRESS → IN_REVIEW`, `IN_REVIEW → VALIDATION`, `VALIDATION → READY_TO_SHIP`, and the rejection edges), move `assigned_agent` and `claim_expires_at` to that agent in the same commit.

- Ownership matches reality; the stall clock is refreshed by the agent actually working the card.
- Removes the `409 already claimed by …` workaround entirely, so nobody has to patch unleased.
- Larger change: touches the state machine, `stage_owners` semantics and claim contention. Deserves its own issue.

### 6.3 Keep the detection, drop the reclaim

Compute the stall signal as today but, while the lease is live, emit a warning (log entry, optional notify) and a `stalled` flag instead of reclaiming. Reclaim only on lease expiry.

- Keeps the operator signal without destroying state.
- Needs a decision on what a `stalled` flag does in the UI; useful with 6.1 or on its own.

### 6.4 Configuration only (mitigation, not a fix)

`KANBAN_PROGRESS_STALL_MS=21600000` makes the symptom rare. It does not correct the logic and it delays recovery of genuinely stuck cards.

**Suggested sequence:** 6.1 and 6.3 together, then 6.2.

---

## 7. Observability gap

The reclaim log entry records the reason and `reclaimed_from`, but not the lease state, so a reaped card cannot show that it was live when it was reaped. Add:

```js
candidate.agent_logs.push({
  timestamp: candidate.updated,
  message: '…',
  agent_id: 'system',
  reason,
  reclaimed_from: fromAgent,
  claim_expires_at: task.claim_expires_at,   // add
  last_progress_at: task.last_progress_at,   // add
});
```

---

## 8. Tests to add

`server/test/kanban.stallreaper.test.js`

- `IN_REVIEW` / `VALIDATION` survive past `KANBAN_PROGRESS_STALL_MS` while their lease is live (6.1).
- `IN_PROGRESS` with a stale `last_progress_at` is still reclaimed (6.1 must not disarm the existing guard).
- With 6.3: a live-lease stall produces a warning entry and no reclaim; an expired lease still reclaims.

`server/test/kanban.orphan.test.js`

- With 6.2: a transition transfers `assigned_agent` and `claim_expires_at` to the acting role.
- `READY_TO_SHIP` remains exempt under every configuration.

---

## 9. Non-goals

- Not a data-loss bug; do not treat it as one.
- Do not "fix" it by disabling the reaper (`KANBAN_REAP_ENABLED=0`) — dead agents would then hold cards forever.
- Do not widen `KANBAN_MAX_LEASE_MS` as a workaround; it lengthens every dead-claim window on the board.
