/**
 * C1 (v3.12.5) — leases: the injectable clock, every KANBAN_* lease/stall
 * window, the claim-cap helpers, the reclaim path and the background reaper.
 *
 * The reaper and its reclaim body moved together because they are one unit of
 * behaviour (the timer calls reapExpiredClaims, which calls the UNLOCKED
 * reclaimTaskInner). The claim path itself stays in store.js: it shares the
 * legal-transition walk with PATCH, and moving it would have meant re-exporting
 * half of that logic back. Extracted verbatim apart from imports; the state it
 * mutates lives in ./core.js and the events it emits go through ./listeners.js.
 */
import {
  tasks,
  getTask,
  getStorage,
  projectBucket,
  updateInMemoryTask,
  compositeKey,
  withMutationLock,
  nextVersionFor,
} from './core.js';
import { notify } from './listeners.js';
import { ACTIVE_STATUS_SET, STATUSES } from '../state-machine.js';
import { createLogger } from '../logger.js';

const log = createLogger('reaper');

// ============================================================================
// Injectable clock (§2.4) — all lease math goes through nowFn() so tests can
// force expiry deterministically. Pass undefined to restore the wall clock.
// ============================================================================
export let nowFn = () => Date.now();

export function setNowFn(fn) {
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
}

// ============================================================================
// Lease / reaper / auto-promote config (§2.4 / §2.5) — read at call time so a
// test suite can override per-suite via env. (Minor deviation from the plan's
// "cache at load": call-time reads are correct for env-toggle tests.)
// ============================================================================
function getClaimTtlMs() {
  const raw = process.env.KANBAN_CLAIM_TTL_MS;
  // Default raised 300000 -> 600000 (v2.3.11): headless builders only POST /logs
  // (which extends the lease since v2.3.4) and the browser heartbeats every 5s,
  // but measured log gaps on the production board showed median 46s / p95 315s,
  // so a 5-minute TTL reaped live work 6% of the time; 10 minutes cuts that to
  // ~2.6% without meaningfully delaying recovery of genuinely dead agents.
  if (raw === undefined || raw === '') return 600000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 600000;
}

export function getMinLeaseMs() {
  const raw = process.env.KANBAN_MIN_LEASE_MS;
  if (raw === undefined || raw === '') return 60000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 60000;
}

export function getMaxLeaseMs() {
  const raw = process.env.KANBAN_MAX_LEASE_MS;
  if (raw === undefined || raw === '') return 7200000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 7200000;
}

export function getProgressStallMs() {
  const raw = process.env.KANBAN_PROGRESS_STALL_MS;
  if (raw === undefined || raw === '') return 1800000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1800000;
}

export function leaseWindowFor(task) {
  return task.claim_lease_ms ?? getClaimTtlMs();
}

export function resolveLeaseMs(requested) {
  if (requested === undefined || requested === null || requested === '') {
    // No explicit request (including an empty `?lease_ms=`): the lease keeps
    // the global default, and we do NOT pin it — the caller stores `null` so a
    // later config change still applies.
    return { ok: true, ms: getClaimTtlMs(), explicit: false };
  }
  // v2.12.1 (I-8): accept only an actual number or a numeric string. Before
  // this guard, `Number(requested)` coerced `true` -> 1 and `[5]` -> 5, so a
  // malformed request silently got clamped up to the SHORTEST possible lease
  // (KANBAN_MIN_LEASE_MS) instead of being rejected — the exact failure mode
  // this feature exists to prevent.
  const isNumericType = typeof requested === 'number';
  const isNumericString = typeof requested === 'string' && /^\d+(\.\d+)?$/.test(requested.trim());
  if (!isNumericType && !isNumericString) {
    return { ok: false, status: 400, error: 'lease_ms must be a positive number of milliseconds' };
  }
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, status: 400, error: 'lease_ms must be a positive number of milliseconds' };
  }
  const min = getMinLeaseMs();
  const max = getMaxLeaseMs();
  return { ok: true, ms: Math.min(Math.max(n, min), max), explicit: true };
}

// E-2: cap how many active leases one agent may hold at once. 0/unset =
// unlimited (unchanged default behavior). Privileged roles are exempt (they
// administer the board, e.g. an orchestrator batch-assigning via /assign).
export function getMaxClaimsPerAgent() {
  const raw = process.env.KANBAN_MAX_CLAIMS_PER_AGENT;
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function countActiveClaims(agentId) {
  let count = 0;
  for (const t of tasks) {
    if (t.assigned_agent !== agentId) continue;
    if (ACTIVE_STATUS_SET.has(t.status)) {
      count += 1;
    }
  }
  return count;
}

/**
 * §2.4b Fix 3 (v2.12.0). When a task holder writes to any one card, renew the
 * leases on every OTHER card they also hold, in the same lock — otherwise an
 * orchestrator busy on one card silently loses its siblings to the reaper even
 * though it was demonstrably active. Default ON; set KANBAN_HOLDER_WRITE_RENEWS_ALL=0
 * (or false) to disable.
 */
export function holderWriteRenewsAll() {
  const raw = process.env.KANBAN_HOLDER_WRITE_RENEWS_ALL;
  if (raw === undefined || raw === '') return true;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

function getReapIntervalMs() {
  const raw = process.env.KANBAN_REAP_INTERVAL_MS;
  if (raw === undefined || raw === '') return 30000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 30000;
}

/**
 * §2.4 orphan grace — how long an ownerless ACTIVE task may sit untouched before
 * the reaper treats it as structurally stuck.
 *
 * An active task with no owner/lease is normally created by a status-only PATCH
 * (the documented orchestrator flow: `PATCH {status:'IN_PROGRESS', role:'admin'}`).
 * That is a *legitimate* intermediate state — per-stage ownership deliberately
 * keeps `assigned_agent` as the lease holder rather than reassigning it — so
 * reaping it on the very next sweep destroys a card that was just written to.
 * The grace window is anchored on `updated`, so any later write (a log, a
 * transition) resets it. Defaults to a FIXED 5-minute window, deliberately
 * DECOUPLED from the claim TTL (v2.3.11): deriving it from `getClaimTtlMs()`
 * meant raising the TTL (300s -> 600s) silently doubled how long an ownerless
 * active card could sit unowned before being normalized. The two knobs answer
 * different questions — "how long may a lease run idle" vs "how long may a
 * nobody-owned card sit untouched" — so they no longer share a default.
 * `0` disables the grace (reap orphans immediately).
 */
function getOrphanGraceMs() {
  const raw = process.env.KANBAN_ORPHAN_GRACE_MS;
  if (raw === undefined || raw === '') return 300000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 300000;
}

export function isReaperEnabled() {
  const raw = process.env.KANBAN_REAP_ENABLED;
  if (raw !== undefined && raw !== '' && (raw === 'false' || raw === '0')) return false;
  // D9 (v3.12.6): `KANBAN_REAP_INTERVAL_MS <= 0` is documented as "no sweep"
  // (the deploy-drift monitor uses the same convention). The old interval
  // reader silently substituted 30000 for a non-positive value, so a
  // deliberately disabled reaper looked healthy in /api/health while the boot
  // path still started the timer. Treat it as disabled so both the health probe
  // and startServer agree, and no timer is scheduled.
  const interval = process.env.KANBAN_REAP_INTERVAL_MS;
  if (interval !== undefined && interval !== '') {
    const n = Number(interval);
    if (Number.isFinite(n) && n <= 0) return false;
  }
  return true;
}

export function isAutoPromoteEnabled() {
  const raw = process.env.KANBAN_AUTO_PROMOTE;
  if (raw === undefined || raw === '') return true;
  return raw !== 'false' && raw !== '0';
}

export function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

       // ---------------------------------------------------------------------------
       // §2.4 stale-task reaper
       // ---------------------------------------------------------------------------

       /**
       * reclaimTask inner — a DOCUMENTED SYSTEM OVERRIDE (like the §2.5 unlock). It
       * forces an active claim (PLANNING / IN_PROGRESS / IN_REVIEW / VALIDATION) back
       * to READY, which is NOT a legal agent transition per canTransition (only
       * PLANNING has a → READY edge). The reaper is ownerless and exempt from the agent state
       * machine; this is the single sanctioned place that exemption exists. Clears
       * owner + lease, bumps reclaim_count, and logs the reclaim. Persist-first →
       * in-memory → notify (KB-05 fail-closed): a storage failure leaves the active
       * claim untouched.
       *
       * UNLOCKED: the caller must already hold the mutation lock. This is required
       * because reapExpiredClaims (a single locked sweep) calls it per-task; a
       * promise-queue lock cannot safely re-enter itself, so the reclaim body is
       * kept out of withMutationLock and the public reclaimTask wrapper supplies the
       * one lock.
       */
  async function reclaimTaskInner(task, { reason = 'lease_expired', nowMs } = {}) {
    const activeStatus = ACTIVE_STATUS_SET.has(task.status);
    if (!task.assigned_agent && !activeStatus) {
      // Not currently held and not active — nothing to reclaim. Idempotent.
      return { task, status: 200, reclaimed: false };
    }
    const fromAgent = task.assigned_agent;
    const candidate = structuredClone(task);
    candidate.status = STATUSES.READY;
    candidate.assigned_agent = null;
    candidate.claim_expires_at = null;
    candidate.claim_lease_ms = null;
    candidate.reclaim_count = (Number.isInteger(task.reclaim_count) ? task.reclaim_count : 0) + 1;
    candidate.updated = isoFromMs(nowMs);
    candidate.version = nextVersionFor(task);
    if (!Array.isArray(candidate.agent_logs)) candidate.agent_logs = [];
    candidate.agent_logs.push({
      timestamp: candidate.updated,
      message: !fromAgent
        ? 'Task had no owner — reclaimed to READY by system normalizer.'
        : (reason === 'progress_stalled'
          ? 'PROGRESS STALLED — task reclaimed to READY by system reaper.'
          : (reason === 'lease_expired'
            ? 'LEASE EXPIRED — task reclaimed to READY by system reaper.'
            : `Task reclaimed to READY by system (${reason}).`)),
      agent_id: 'system',
      reason: !fromAgent ? reason : (reason || 'lease_expired'),
      reclaimed_from: fromAgent,
    });

    // KB-05: persist first, then mutate memory, then notify.
    await getStorage(candidate.project).saveTask(candidate, projectBucket(candidate.project, candidate));
    updateInMemoryTask(candidate);
    // §2.2/§2.9: surface a semantic 'reclaimed' event + audit who/why.
    notify({
      actor: 'system',
      reason: reason,
      semantic: new Map([[
        compositeKey(candidate.project, candidate.id),
        { kind: 'reclaimed', actor: 'system', reason, prevTask: task },
      ]]),
    });
    return { task: candidate, status: 200, reclaimed: true, reclaimed_from: fromAgent };
  }

  /**
   * reclaimTask(id, { reason, now }) — public, lock-wrapped reclaim. Delegates
   * to the unlocked inner so a caller that is already inside the lock
   * (reapExpiredClaims) does not deadlock on the promise-queue lock.
   */
  export async function reclaimTask(id, { reason = 'lease_expired', now, project } = {}) {
    return withMutationLock(async () => {
      const task = getTask(id, project);
      if (!task) return { error: 'Task not found', status: 404 };
      const nowMs = typeof now === 'number' ? now : nowFn();
      return reclaimTaskInner(task, { reason, nowMs });
    });
  }

  /**
   * reapExpiredClaims — sweep active claims whose lease has expired and reclaim
   * them. Runs in the mutation lock so it is serialized with every other writer
   * (a heartbeat that lands first commits before the sweep sees a fresh expiry).
   * `now` is injectable so tests can force expiry. Returns the reclaimed ids.
   * Calls the UNLOCKED reclaimTaskInner directly (it already holds the lock).
   */
  export async function reapExpiredClaims({ now } = {}) {
    return withMutationLock(async () => {
      const nowMs = typeof now === 'number' ? now : nowFn();
      const stallMs = getProgressStallMs();
      const candidateReasons = new Map();
      const candidates = tasks.filter((t) => {
        const active = ACTIVE_STATUS_SET.has(t.status);
        if (!active) {
          // READY is not an active status, so the sweep below never sees it —
          // but a card can be READY WITH an owner: a planner claims READY→PLANNING
          // (owner + lease set), then a role-gated PATCH drops it back to READY,
          // a transition that deliberately keeps the lease. Once that lease
          // lapses the card is permanently unclaimable (contention 409, and
          // nextClaim skips owned cards). Reclaim it the moment its lease dies.
          if (
            t.status === STATUSES.READY &&
            t.assigned_agent !== null &&
            t.claim_expires_at != null
          ) {
            const rdyExpires = Date.parse(t.claim_expires_at);
            if (!Number.isNaN(rdyExpires) && rdyExpires <= nowMs) {
              candidateReasons.set(t, 'lease_expired');
              return true;
            }
          }
          return false;
        }
        // Deep-review P1: a card in READY_TO_SHIP is DONE with its working
        // stages — the tester's job is finished; nothing legitimately advances
        // last_progress_at, so the stall sweep would reclaim approved work to
        // READY mid-release. Never reclaim a card awaiting release.
        if (t.status === STATUSES.READY_TO_SHIP) return false;
        if (t.assigned_agent === null || t.claim_expires_at === null || t.claim_expires_at === undefined) {
          // Orphan: active with no owner/lease. Normally this is a status-only
          // PATCH that has not yet been claimed — a legitimate intermediate state,
          // not a stuck card. Only reclaim once it has been untouched for the
          // grace window, so a freshly-written card survives the next sweep.
          const graceMs = getOrphanGraceMs();
          if (graceMs <= 0) {
            candidateReasons.set(t, 'orphan_normalized');
            return true;
          }
          const touchedMs = Date.parse(t.updated);
          if (Number.isNaN(touchedMs)) {
            candidateReasons.set(t, 'orphan_normalized');
            return true;
          }
          if (nowMs - touchedMs >= graceMs) {
            candidateReasons.set(t, 'orphan_normalized');
            return true;
          }
          return false;
        }

        if (stallMs > 0 && t.last_progress_at) {
          const lastProgMs = Date.parse(t.last_progress_at);
          if (!Number.isNaN(lastProgMs) && nowMs - lastProgMs >= stallMs) {
            candidateReasons.set(t, 'progress_stalled');
            return true;
          }
        }

        const expiresMs = Date.parse(t.claim_expires_at);
        if (Number.isNaN(expiresMs)) return false;
        if (expiresMs <= nowMs) {
          candidateReasons.set(t, 'lease_expired');
          return true;
        }
        return false;
      });
      let reclaimed = 0;
      const ids = [];
      for (const t of candidates) {
        // getTask MUST be given the candidate's own project: task ids are unique
        // only within a project, so the 1-arg form resolves against `default` and
        // either returns null (throwing, aborting the whole sweep) or — when the
        // same short id exists in `default` — reclaims the wrong task.
        const task = getTask(t.id, t.project);
        const reason = candidateReasons.get(t) || (
          (task.assigned_agent === null || task.claim_expires_at == null)
            ? 'orphan_normalized'
            : 'lease_expired'
        );
        const r = await reclaimTaskInner(task, { reason, nowMs });
        if (r && r.reclaimed) {
          reclaimed += 1;
          ids.push(compositeKey(t.project, t.id));
        }
      }
      if (reclaimed > 0) notify();
      return { reclaimed: ids, now: nowMs };
    });
  }

// ---------------------------------------------------------------------------
// §2.4 reaper timer — started ONLY in startServer (never in createApp, so the
// HTTP-contract tests never spawn a timer). The timer is unref()'d so an idle
// process can still exit, and startReaper/stopReaper let a caller control it.
// ---------------------------------------------------------------------------
let reapTimer = null;

export function startReaper() {
  if (reapTimer) return reapTimer;
  reapTimer = setInterval(() => {
     // Fire-and-forget; the lock serializes it with the other writers. Swallow
     // so a sweep throw can never kill the interval or the process.
    reapExpiredClaims().catch((err) => {
      log.error('sweep failed', { error: err && err.message });
     });
   }, getReapIntervalMs());
      // An unref'd timer must not keep a (possibly test-driven) process alive.
    reapTimer.unref();
    log.info('started', { interval_ms: getReapIntervalMs() });
    return reapTimer;
   }

export function stopReaper() {
  if (reapTimer) {
    clearInterval(reapTimer);
    reapTimer = null;
    return true;
   }
  return false;
}

export function isReaperRunning() {
  return reapTimer !== null;
}
