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
     * Should match the server's `KANBAN_CLAIM_TTL_MS` (default 300000 = 5 min).
     */
  leaseMs?: number
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

  const remaining = leaseRemainingMs(task, nowMs)
    // No usable window → nothing to renew against.
  if (remaining === null) return false

  const fraction = config.renewAtFraction ?? 0.5
  const windowMs = config.leaseMs ?? 300000
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
  /not[ _]?(a[ _])?lease[ _]?holder|not[ _]?claimed|no[ _]?active[ _]?lease/i

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
    const remaining = leaseRemainingMs(task, nowMs)
    if (remaining !== null && remaining > maxRemaining) maxRemaining = remaining
  }
  return maxRemaining > 0 ? maxRemaining : previous
}
