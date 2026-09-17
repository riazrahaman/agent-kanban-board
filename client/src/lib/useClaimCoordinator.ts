import { useEffect, useRef, useState } from 'react'
import type { Task } from '../types'
import { heartbeatTask, nextClaim } from '../api'
import {
  heartbeatTargets,
  isLostLeaseError,
  observedLeaseWindowMs,
  shouldAutoClaim,
} from './claimCoordinator'

/**
 * Phase 2.2: the live claim coordinator hook.
 *
 * Given an agent id and the live task stream, this hook:
 *  1. Heartbeats every task the agent is actively holding (server resets the
 *     lease window on each renewal).
 *  2. Auto-claims the next eligible task when the agent is not holding anything.
 *
 * Pure decision logic lives in `claimCoordinator.ts` so this hook stays thin and
 * the decisions are covered by the `.test.mjs` unit tests.
 */

export type ClaimCoordinatorOptions = {
  agentId: string | null
  tasks: Task[]
       /** How often the tick fires. Default 5s. */
  intervalMs?: number
      /** Which projects to participate in. Empty/undefined = all projects. */
  projects?: string[]
}

export type CoordinatorResult = {
        /** Heartbeats that succeeded on the most recent tick. */
  lastHeartbeatCount: number
        /** Id of the task most recently auto-claimed, if any. */
  lastClaimedId: string | null
        /** Human-readable last coordination error, if any. */
  lastError: string | null
}

export function useClaimCoordinator({
  agentId,
  tasks,
  intervalMs = 5000,
  projects,
}: ClaimCoordinatorOptions): CoordinatorResult {
        // State, not a ref: the header renders lastClaimedId / lastError, and a
        // ref mutation never tells React to re-render, so the display only
        // refreshed when something unrelated happened to re-render the tree.
  const [result, setResult] = useState<CoordinatorResult>({
    lastHeartbeatCount: 0,
    lastClaimedId: null,
    lastError: null,
        })

        // Keep the latest values reachable from a stable timer closure.
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  const agentRef = useRef(agentId)
  agentRef.current = agentId

  const projectsRef = useRef(projects)
  projectsRef.current = projects

        // Running estimate of the server's lease TTL; see observedLeaseWindowMs.
  const leaseMsRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    let stop = false
    let timer: ReturnType<typeof setTimeout> | null = null

     async function runOnce() {
       const who = agentRef.current
        if (!who || stop) return
        const proj = projectsRef.current?.length ? projectsRef.current[0] : undefined
        const nowMs = Date.now()
        leaseMsRef.current = observedLeaseWindowMs(
          tasksRef.current, who, nowMs, leaseMsRef.current,
          )

              // 1. Heartbeat every task this agent is actively holding.
        const toBeat = heartbeatTargets(tasksRef.current, who, nowMs, {
          leaseMs: leaseMsRef.current,
            })
        let beat = 0
        for (const task of toBeat) {
          // A cancelled coordinator must stop MUTATING immediately, not merely
          // stop rescheduling: `stop` was previously only consulted before
          // setResult, so a discarded run kept issuing writes. React StrictMode
          // mounts every effect twice in development, so the throwaway mount was
          // claiming real tasks alongside the live one.
          if (stop) return
          try {
            // Always the task's OWN project: gating this on the UI filter meant an
            // unscoped board sent no scope at all, so every heartbeat for a task
            // outside `default` 404'd and the lease lapsed.
            await heartbeatTask(task.id, who, { project: task.project })
            beat += 1
                 } catch (err) {
                  // A "not a lease holder" / "not claimed" hint means this lease
                   // was reaped or stolen; drop it and let the auto-claim pass
                   // pick up the orphaned task.
              const msg = err instanceof Error ? err.message : String(err)
              if (isLostLeaseError(msg)) {
                continue
                     }
              if (stop) return
              setResult((r) => ({ ...r, lastHeartbeatCount: beat, lastError: msg }))
              return
                 }
               }

              // 2. If we are now idle, pull the next eligible task.
        let claimedId: string | null = null
        let claimError: string | null = null
        if (!stop && shouldAutoClaim(tasksRef.current, who, Date.now())) {
          try {
            const claimed = await nextClaim(who, proj ? { project: proj, role: 'builder' } : { role: 'builder' })
            if (claimed) claimedId = claimed.id
                } catch (err) {
              claimError = err instanceof Error ? err.message : 'next-claim failed'
                 }
               }

        if (stop) return
        setResult((r) => ({
          lastHeartbeatCount: beat,
          lastClaimedId: claimedId ?? r.lastClaimedId,
          lastError: claimError,
            }))
          }

       async function loop() {
         await runOnce()
        if (stop) return
          timer = setTimeout(loop, intervalMs)
          }
       loop()

      return () => {
        stop = true
        if (timer) clearTimeout(timer)
          }
       }, [agentId, intervalMs])

  return result
}
