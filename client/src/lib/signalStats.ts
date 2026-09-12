import type { Task } from '../types.ts'
import { ACTIVE_STATUSES, CANONICAL_STATUSES } from './status.ts'

export type SignalStats = {
  active: number
  blocked: number
  done: number
}

/**
 * Pure computation behind the "Signal Overview" stat tiles. Previously this
 * compared `task.status` against lowercase strings ('in_progress', 'blocked',
 * 'done') that stopped matching real data once the board standardized on the
 * uppercase canonical vocabulary (ADR-001) — the tiles were permanently stuck
 * at 0 regardless of actual board state. This uses the canonical statuses.
 *
 * `done` is the total count of tasks in the DONE state. It used to be a
 * rolling "done today" window keyed on agent_log/updated local-calendar day,
 * which silently dropped tasks that were finalized without agent_logs or that
 * crossed a day boundary — so a board with 12 completed tasks could read 1.
 */
export function computeSignalStats(tasks: Task[], _now: Date = new Date()): SignalStats {
  const active = tasks.filter((t) =>
     (ACTIVE_STATUSES as readonly string[]).includes(t.status),
    ).length

  const blocked = tasks.filter((t) => t.status === CANONICAL_STATUSES.BLOCKED).length

  const done = tasks.filter((t) => t.status === CANONICAL_STATUSES.DONE).length

  return { active, blocked, done }
}
