import type { Task } from '../types'

/**
 * Phase 2.2: client-side claim coordination.
 *
 * A browser (or agent-driven client) must keep its held tasks' leases alive
 * with periodic heartbeats, and pull the next eligible task when it has nothing
 * to do or its lease was reaped. This module holds the *pure* decision logic so
 * it can be unit-tested without a browser or timers; the React hook
 * `useClaimCoordinator` wires these decisions into `setTimeout` callbacks and
 * calls `heartbeatTask` / `nextClaim` from `api.ts`.
 *
 * Server contract (path B):
 * - lease deadline field: `claim_expires_at` (server-persisted ISO-8601).
 * - `renewLease` / `applyClaim({renew:true})` reset `claim_expires_at` to a
 *   fresh TTL on every heartbeat, so the client window self-baselines: fire a
 *   heartbeat when the remaining time drops to `renewAtFraction` of the lease
 *   window, and the server hands back a fresh window. No per-task renewal
 *   timestamp is needed on the client.
 * - `heartbeatTask` throws on any non-2xx; the hook matches `err.message` for a
 *   "not a lease holder" / "not claimed" hint and drops that lease so the
 *   auto-claim pass can pick up the orphaned task.
 */

export type CoordinatorConfig = {
     /** How often heartbeats fire, in ms. Default 5000. */
  heartbeatIntervalMs?: number
     /**
     * Renew a lease when its remaining time is less than this fraction of the
     * total lease window. Default 0.5 (renew at the halfway point).
     */
  renewAtFraction?: number
     /**
     * Total lease window requested on every heartbeat / new claim, in ms.
     * Fallback when a card has no per-task `claim_lease_ms`; should match the
     * server's `KANBAN_CLAIM_TTL_MS` (default 600000 = 10 min).
     */
  leaseMs?: number
     /**
     * Max idle time without card progress before the lease is considered stalled, in ms.
     * Default 1800000 (30 minutes).
     */
  progressStallMs?: number
     /**
     * Which projects this agent should participate in. Empty/undefined = all
     * projects.
     */
  projects?: string[]
}

/**
 * Lease time remaining, in ms. Returns `null` when the task has no usable lease
 * to reason about (unclaimed, or `claim_expires_at` unset/invalid). Returns a
 * negative number once the lease has lapsed.
 */
export function leaseRemainingMs(task: Task, nowMs: number): number | null {
  if (!task || !task.assigned_agent || !task.claim_expires_at) return null
  const expiry = Date.parse(task.claim_expires_at)
  if (Number.isNaN(expiry)) return null
  return expiry - nowMs
}

/**
 * Whether this agent actively holds `task` right now: assigned to it AND the
 * lease has not lapsed. A held-but-lapsed task is treated as unheld so the
 * coordinator immediately goes back to auto-claim.
 */
export function isMineHeld(task: Task, agentId: string, nowMs: number): boolean {
  if (task.assigned_agent !== agentId) return false
  const remaining = leaseRemainingMs(task, nowMs)
    // Assigned but no usable lease window yet — treat as held so we don't
  // hammer auto-claim before the first heartbeat response lands.
  if (remaining === null) return true
  return remaining > 0
}

/**
 * Whether the coordinator should heartbeat this task on this tick. True only
 * when the task is held by this agent AND its remaining lease time is ≤
 * `renewAtFraction` of the lease window. Because the server resets the window on
 * every renewal, measuring against a fixed `leaseMs` is correct and
 * self-baselining — no per-task timestamps are required.
 */
export function needsHeartbeat(
  task: Task,
  agentId: string,
  nowMs: number,
  config: CoordinatorConfig = {}
): boolean {
  if (!isMineHeld(task, agentId, nowMs)) return false

  if (task.last_progress_at) {
    const lastProgress = Date.parse(task.last_progress_at)
    if (!Number.isNaN(lastProgress)) {
      const stallTimeout = config.progressStallMs ?? 1800000
      if (stallTimeout > 0 && nowMs - lastProgress >= stallTimeout) {
        return false
      }
    }
  }

  const remaining = leaseRemainingMs(task, nowMs)
    // No usable window → nothing to renew against.
  if (remaining === null) return false

  const fraction = config.renewAtFraction ?? 0.5
  // v2.12.0: a card may carry its own lease window (`claim_lease_ms`), chosen at
  // claim time; prefer it over the configured global default so a long-window
  // claim is not under-heartbeated.
  const windowMs = task.claim_lease_ms ?? config.leaseMs ?? 600000
  return remaining <= fraction * windowMs
}

/**
 * The subset of tasks this agent should heartbeat on this tick.
 */
export function selectTasksToHeartbeat(
  tasks: Task[],
  agentId: string,
  nowMs: number,
  config: CoordinatorConfig = {}
): Task[] {
  return tasks.filter((t) => needsHeartbeat(t, agentId, nowMs, config))
}

/**
 * The heartbeat requests to issue this tick: each is the task id plus **its own**
 * project.
 *
 * Task ids are unique only within a project, so a heartbeat that omits the scope
 * resolves against `default` and 404s for every task living anywhere else. The
 * scope must therefore come from the task, never from whichever project the
 * operator happens to be viewing — gating it on the UI filter meant that with the
 * board unscoped (the default view) no lease in a named project was ever renewed,
 * so every one of them silently lapsed and was reclaimed by the reaper.
 */
export function heartbeatTargets(
  tasks: Task[],
  agentId: string,
  nowMs: number,
  config: CoordinatorConfig = {}
): Array<{ id: string; project: string }> {
  return selectTasksToHeartbeat(tasks, agentId, nowMs, config).map((t) => ({
    id: t.id,
    project: t.project,
  }))
}

/**
 * Whether this agent is currently holding any task (i.e. NOT idle). Used to
 * decide whether to go ask for the next claim.
 */
export function hasActiveClaim(tasks: Task[], agentId: string, nowMs: number): boolean {
  return tasks.some((t) => isMineHeld(t, agentId, nowMs))
}

/**
 * Auto-claim decision: the agent should pull the next eligible task when it is
 * not currently holding anything actively.
 */
export function shouldAutoClaim(tasks: Task[], agentId: string, nowMs: number): boolean {
  return !hasActiveClaim(tasks, agentId, nowMs)
}

/**
 * A heartbeat rejection meaning "this lease is no longer yours". The server
 * reports these as `not_lease_holder` / `not_claimed` and `api.ts` formats them
 * into the thrown message as `heartbeat failed (409) (not_lease_holder)`. Both
 * the underscored wire form and a spaced prose form are matched, so a reworded
 * server message does not silently turn the recovery path back into dead code.
 */
export const LOST_LEASE_PATTERN =
  /not[ _]?(a[ _])?lease[ _]?holder|not[ _]?claimed|no[ _]?active[ _]?lease|progress[ _]?stalled/i

export function isLostLeaseError(message: string): boolean {
  return LOST_LEASE_PATTERN.test(message)
}

/**
 * Estimates the server's lease TTL by observation, since `KANBAN_CLAIM_TTL_MS`
 * is configurable and is not published to the client. Right after a claim or a
 * renewal a held task's remaining lease IS the full window, and remaining can
 * never exceed it, so the largest value ever seen converges on the true TTL.
 *
 * Assuming the 300000 default instead meant a server on a 60s TTL had
 * `remaining <= 0.5 * 300000` true on every tick, so every held task
 * heartbeated every 5s — and each heartbeat is a full persisted store mutation.
 *
 * `previous` is the running estimate; pass undefined on the first call.
 */
export function observedLeaseWindowMs(
  tasks: Task[],
  agentId: string,
  nowMs: number,
  previous?: number
): number | undefined {
  let maxRemaining = previous ?? 0
  for (const task of tasks) {
    if (task.assigned_agent !== agentId) continue
    // Deep-review: a card with its own claim_lease_ms follows ITS OWN window
    // — never fold it into the shared estimate, or a 2h custom lease poisons
    // the observed window and the other (default-TTL) leases never renew.
    if (task.claim_lease_ms) continue
    const remaining = leaseRemainingMs(task, nowMs)
    if (remaining !== null && remaining > maxRemaining) maxRemaining = remaining
  }
  return maxRemaining > 0 ? maxRemaining : previous
}

/**
 * COR-03: a claim this coordinator made that the live task stream may not show
 * yet. `nextClaim` answers with the claimed task, but the board state the
 * coordinator reads is fed only by the event stream; if the stream is slow,
 * reconnecting or not delivering, the next tick would see "nothing held" and
 * claim yet another card. The pending claim bridges that gap.
 */
export type PendingClaim = {
  project: string
  id: string
  /** Lease deadline from the claim (or latest heartbeat) response, epoch ms. */
  expiresAtMs: number
  /** `version` of the task as returned by the server for this claim. */
  version: number
  /** The server's copy of the task, used for heartbeats until the stream catches up. */
  task: Task
}

/** Fallback lease when a claim response carries no usable `claim_expires_at`. */
const PENDING_FALLBACK_LEASE_MS = 600000

/**
 * Builds a pending claim from a successful `nextClaim` / heartbeat response.
 * Returns null when the response is not a claim held by `agentId`.
 */
export function pendingClaimFromTask(task: Task | null | undefined, agentId: string, nowMs: number): PendingClaim | null {
  if (!task || task.assigned_agent !== agentId) return null
  const parsed = task.claim_expires_at ? Date.parse(task.claim_expires_at) : NaN
  const expiresAtMs = Number.isNaN(parsed)
    ? nowMs + (task.claim_lease_ms ?? PENDING_FALLBACK_LEASE_MS)
    : parsed
  return {
    project: task.project,
    id: task.id,
    expiresAtMs,
    version: typeof task.version === 'number' ? task.version : 0,
    task,
  }
}

/**
 * Re-evaluates a pending claim against the stream's view of the board:
 * - lapsed lease → dropped (the reaper will take it back; claiming again is fine);
 * - the stream shows the task at the claim's version or newer → the stream has
 *   caught up, so its view is authoritative (held by us → the normal held
 *   logic covers it; held by someone else / released → lost) and the pending
 *   entry is dropped either way;
 * - otherwise (absent from the stream, or an older revision) → still pending.
 */
export function reconcilePendingClaim(
  pending: PendingClaim | null,
  tasks: Task[],
  nowMs: number,
): PendingClaim | null {
  if (!pending) return null
  if (nowMs >= pending.expiresAtMs) return null
  const seen = tasks.find((t) => t.id === pending.id && t.project === pending.project)
  if (seen && typeof seen.version === 'number' && seen.version >= pending.version) return null
  return pending
}

/**
 * The task list the coordinator should reason about: the stream's tasks, with a
 * still-pending claim's server copy standing in for the (missing or stale)
 * stream copy, so heartbeats keep the lease alive while the stream lags.
 */
export function effectiveTasks(tasks: Task[], pending: PendingClaim | null): Task[] {
  if (!pending) return tasks
  const rest = tasks.filter((t) => !(t.id === pending.id && t.project === pending.project))
  return [...rest, pending.task]
}

/**
 * Auto-claim decision including the coordinator's own unconfirmed claim.
 * `streamUp === false` (stream known to be down) never claims: without live
 * state the coordinator cannot see what it already holds. `undefined` means the
 * stream state is unknown and does not block.
 */
export function shouldAutoClaimNow(
  tasks: Task[],
  agentId: string,
  nowMs: number,
  opts: { pending?: PendingClaim | null; streamUp?: boolean } = {},
): boolean {
  if (opts.streamUp === false) return false
  if (reconcilePendingClaim(opts.pending ?? null, tasks, nowMs)) return false
  return shouldAutoClaim(tasks, agentId, nowMs)
}
