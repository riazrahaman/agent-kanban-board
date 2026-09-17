import { useEffect, useState } from 'react'
import type { MetricsResponse } from '../types'
import { getMetrics } from '../api'
import { backlogOf, blockedOf, formatDuration, wipOf } from '../lib/portfolioMetrics'

type Props = {
  /** Jump to a single project's board. */
  onSelectProject: (project: string) => void
  /** Re-fetch whenever the live task stream changes. */
  refreshKey: number
}

export default function Portfolio({ onSelectProject, refreshKey }: Props) {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getMetrics()
      .then((data) => {
        if (!cancelled) {
          setMetrics(data)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load metrics')
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

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
    </div>
  )
}
