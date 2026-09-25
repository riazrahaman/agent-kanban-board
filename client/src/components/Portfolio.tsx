import { useEffect, useState } from 'react'
import type { MetricsResponse, MilestoneSummary } from '../types'
import { getMetrics, getMilestones } from '../api'
import { backlogOf, blockedOf, formatDuration, wipOf } from '../lib/portfolioMetrics'

type Props = {
  /** Jump to a single project's board. */
  onSelectProject: (project: string) => void
  /** Bumped by the caller when the visible board's tasks change. */
  refreshKey: number
  /** How often to re-poll while visible, in ms. */
  pollMs?: number
}

export default function Portfolio({ onSelectProject, refreshKey, pollMs = 10000 }: Props) {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null)
  const [milestones, setMilestones] = useState<MilestoneSummary[]>([])
  const [error, setError] = useState<string | null>(null)

  // This view is cross-project but the task stream feeding `refreshKey` is
  // scoped to one board, so activity in every OTHER project is invisible to it
  // — and even in the visible one, a task moving BACKLOG→DONE does not change
  // the task count. Hence a poll while mounted rather than event-driven
  // refresh alone.
  useEffect(() => {
    let cancelled = false
    const load = () => {
      getMetrics()
        .then((data) => {
          if (cancelled) return
          setMetrics(data)
          setError(null)
        })
        .catch((err) => {
          if (cancelled) return
          setError(err instanceof Error ? err.message : 'Failed to load metrics')
        })
    }
    load()
    const timer = setInterval(load, pollMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [refreshKey, pollMs])

  // v2.11.0 (opt-milestones): milestone rollups load alongside the metrics and
  // share the same poll cadence. Failure is silent — milestones are optional.
  useEffect(() => {
    let cancelled = false
    const load = () => {
      getMilestones()
        .then((m) => {
          if (!cancelled) setMilestones(m)
        })
        .catch(() => undefined)
    }
    load()
    const timer = setInterval(load, pollMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [refreshKey, pollMs])

  if (error) {
    return (
      <div className="flex h-full flex-1 items-center justify-center font-mono text-xs text-fail">
        {error}
      </div>
    )
  }
  if (!metrics) {
    return (
      <div className="flex h-full flex-1 items-center justify-center font-mono text-xs text-muted">
        Loading portfolio…
      </div>
    )
  }
  if (metrics.projects.length === 0) {
    return (
      <div className="flex h-full flex-1 items-center justify-center font-mono text-xs text-muted">
        No projects yet.
      </div>
    )
  }

  const cell = 'px-3 py-2 text-right font-mono text-xs tabular-nums'
  const head = 'px-3 py-2 text-right font-mono text-[10px] uppercase tracking-wider text-muted'

  return (
    <div className="min-w-0 flex-1 overflow-auto">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-surface">
          <tr className="border-b border-line">
            <th scope="col" className={`${head} text-left`}>Project</th>
            <th scope="col" className={head}>Backlog</th>
            <th scope="col" className={head} title="Building + In review + In test">WIP</th>
            <th scope="col" className={head}>Blocked</th>
            <th scope="col" className={head} title="All completed work, archived included">Done</th>
            <th scope="col" className={head} title="Median time from created to completed">
              Cycle
            </th>
            <th scope="col" className={head} title="Agents holding an unexpired lease">
              Agents
            </th>
            <th scope="col" className={head} title="Leases reclaimed after expiry">
              Reclaims
            </th>
          </tr>
        </thead>
        <tbody>
          {metrics.projects.map((m) => {
            const blocked = blockedOf(m)
            return (
              <tr
                key={m.project}
                className="border-b border-line transition-colors hover:bg-muted-bg"
              >
                <td className="px-3 py-2 text-left">
                  <button
                    type="button"
                    onClick={() => m.project && onSelectProject(m.project)}
                    className="font-mono text-xs text-ink underline-offset-2 hover:underline"
                    title={`Open the ${m.project} board`}
                  >
                    {m.project}
                  </button>
                </td>
                <td className={cell}>{backlogOf(m)}</td>
                <td className={cell}>{wipOf(m)}</td>
                <td className={`${cell} ${blocked > 0 ? 'text-fail' : ''}`}>{blocked}</td>
                <td className={cell} title={`${m.done_count} on the live board, ${m.archived_count} archived`}>
                  {m.completed_count}
                </td>
                <td className={cell}>{formatDuration(m.cycle_time.median_ms)}</td>
                <td className={cell} title={m.active_agents.join(', ') || 'none'}>
                  {m.active_agent_count}
                </td>
                <td className={cell}>{m.reclaim_count}</td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-line bg-muted-bg">
            <td className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-muted">
              {metrics.aggregate.project_count} projects
            </td>
            <td className={cell}>{backlogOf(metrics.aggregate)}</td>
            <td className={cell}>{wipOf(metrics.aggregate)}</td>
            <td className={cell}>{blockedOf(metrics.aggregate)}</td>
            <td className={cell}>{metrics.aggregate.completed_count}</td>
            <td className={cell}>{formatDuration(metrics.aggregate.cycle_time.median_ms)}</td>
            <td className={cell}>{metrics.aggregate.active_agent_count}</td>
            <td className={cell}>{metrics.aggregate.reclaim_count}</td>
          </tr>
        </tfoot>
      </table>
      {milestones.length > 0 && (
        <section className="border-t border-line p-4">
          <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Milestones
          </h3>
          <ul className="mt-3 space-y-2">
            {milestones.map((m) => (
              <li
                key={`${m.project}/${m.milestone}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-l-2 border-live pl-3"
              >
                <span className="font-mono text-xs text-live" title={`Milestone: ${m.milestone}`}>
                  ◇ {m.milestone}
                </span>
                {m.project && (
                  <span
                    className="max-w-[12rem] truncate border border-line bg-muted-bg px-1.5 py-0.5 font-mono text-[10px] text-muted"
                    title={`Project: ${m.project}`}
                  >
                    {m.project}
                  </span>
                )}
                <span className="font-mono text-[11px] tabular-nums text-ink">
                  {m.done}/{m.total}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-muted" title={`${m.progress}% complete`}>
                  {m.progress}%
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
