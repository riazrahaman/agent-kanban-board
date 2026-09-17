import { useEffect, useRef } from 'react'
import type { Task } from '../types'
import { heartbeatTask, nextClaim } from '../api'
import { selectTasksToHeartbeat, shouldAutoClaim } from './claimCoordinator'

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
  const resultRef = useRef<CoordinatorResult>({
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

  const leaseMsRef = useRef<number | undefined>(undefined)
  leaseMsRef.current = undefined // use server default TTL

  useEffect(() => {
    let stop = false
    let timer: ReturnType<typeof setTimeout> | null = null

     async function runOnce() {
       const who = agentRef.current
        if (!who) return
        const result = resultRef.current
        const proj = projectsRef.current?.length ? projectsRef.current[0] : undefined

              // 1. Heartbeat every task this agent is actively holding.
        const toBeat = selectTasksToHeartbeat(tasksRef.current, who, Date.now(), {
          leaseMs: leaseMsRef.current,
            })
        let beat = 0
        for (const task of toBeat) {
          try {
            await heartbeatTask(task.id, who, proj ? { project: task.project } : {})
            beat += 1
                 } catch (err) {
                  // A "not a lease holder" / "not claimed" hint means this lease
                   // was reaped or stolen; drop it and let the auto-claim pass
                   // pick up the orphaned task.
              const msg = err instanceof Error ? err.message : String(err)
              if (/not a (lease )?holder|not claimed|no active lease/i.test(msg)) {
                continue
                     }
              result.lastError = msg
              return
                 }
               }
        result.lastHeartbeatCount = beat

              // 2. If we are now idle, pull the next eligible task.
        if (shouldAutoClaim(tasksRef.current, who, Date.now())) {
          try {
            const claimed = await nextClaim(who, proj ? { project: proj, role: 'builder' } : { role: 'builder' })
            if (claimed) {
              result.lastClaimedId = claimed.id
                 }
             result.lastError = null
                } catch (err) {
              result.lastError = err instanceof Error ? err.message : 'next-claim failed'
                 }
               }
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

  return resultRef.current
}
