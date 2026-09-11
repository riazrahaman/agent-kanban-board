import type { Task } from '../types.ts'
import { ACTIVE_STATUSES, CANONICAL_STATUSES } from './status.ts'

export type SignalStats = {
  active: number
  blocked: number
  doneToday: number
}

export function isToday(ts: string, now: Date = new Date()): boolean {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return false
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  )
}

/**
 * Pure computation behind the "Signal Overview" stat tiles. Previously this
 * compared `task.status` against lowercase strings ('in_progress', 'blocked',
 * 'done') that stopped matching real data once the board standardized on the
 * uppercase canonical vocabulary (ADR-001) — the tiles were permanently stuck
 * at 0 regardless of actual board state. This uses the canonical statuses.
 */
export function computeSignalStats(tasks: Task[], now: Date = new Date()): SignalStats {
  const active = tasks.filter((t) =>
    (ACTIVE_STATUSES as readonly string[]).includes(t.status),
  ).length

  const blocked = tasks.filter((t) => t.status === CANONICAL_STATUSES.BLOCKED).length

  const doneToday = tasks.filter(
    (t) =>
      t.status === CANONICAL_STATUSES.DONE &&
      Array.isArray(t.agent_logs) &&
      t.agent_logs.some((l) => isToday(l.timestamp, now)),
  ).length

  return { active, blocked, doneToday }
}
