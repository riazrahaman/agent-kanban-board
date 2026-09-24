import type { Task } from '../types'
import { ACTIVE_STATUSES, CANONICAL_STATUSES } from './status'
import { formatDuration } from './portfolioMetrics'

export type DashboardMetrics = {
  total: number
  backlog: number
  wip: number
  blocked: number
  done: number
  avgCycleTimeMs: number | null
  avgCycleTimeFormatted: string
  overdueCount: number
  activeAgentsCount: number
}

// 2 hours threshold without update for active tasks
export const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000

export function computeDashboardMetrics(tasks: Task[], now: number = Date.now()): DashboardMetrics {
  const total = tasks.length
  let backlog = 0
  let wip = 0
  let blocked = 0
  let done = 0
  let overdueCount = 0
  const activeAgents = new Set<string>()
  const cycleTimes: number[] = []

  for (const task of tasks) {
    const status = task.status
    if (status === CANONICAL_STATUSES.BACKLOG) {
      backlog++
    } else if ((ACTIVE_STATUSES as readonly string[]).includes(status)) {
      wip++
      if (task.assigned_agent) {
        activeAgents.add(task.assigned_agent)
      }
      const lastActivity = task.updated
        ? new Date(task.updated).getTime()
        : task.created_at
        ? new Date(task.created_at).getTime()
        : NaN
      if (Number.isFinite(lastActivity) && now - lastActivity > STALE_THRESHOLD_MS) {
        overdueCount++
      }
    } else if (status === CANONICAL_STATUSES.BLOCKED) {
      blocked++
    } else if (status === CANONICAL_STATUSES.DONE) {
      done++
      const start = task.created_at ? new Date(task.created_at).getTime() : NaN
      const end = task.completed_at
        ? new Date(task.completed_at).getTime()
        : task.updated
        ? new Date(task.updated).getTime()
        : NaN
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        cycleTimes.push(end - start)
      }
    }
  }

  const avgCycleTimeMs =
    cycleTimes.length > 0
      ? Math.round(cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length)
      : null

  return {
    total,
    backlog,
    wip,
    blocked,
    done,
    avgCycleTimeMs,
    avgCycleTimeFormatted: formatDuration(avgCycleTimeMs),
    overdueCount,
    activeAgentsCount: activeAgents.size,
  }
}
