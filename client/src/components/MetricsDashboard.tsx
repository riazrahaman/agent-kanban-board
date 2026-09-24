import { useMemo } from 'react'
import type { Task } from '../types'
import { computeDashboardMetrics } from '../lib/dashboardMetrics'

type Props = {
  tasks: Task[]
  onClose?: () => void
}

export default function MetricsDashboard({ tasks, onClose }: Props) {
  const metrics = useMemo(() => computeDashboardMetrics(tasks), [tasks])

  return (
    <div
      role="region"
      aria-label="Metrics Dashboard"
      className="border-b border-line bg-surface/70 px-3 py-2.5 sm:px-4 backdrop-blur-sm transition-all animate-fadeIn"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Metrics Summary
          </span>
          <span className="font-mono text-[10px] text-muted border border-line bg-muted-bg px-1 py-0.2">
            Live
          </span>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close metrics dashboard"
            className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-ink transition-colors"
          >
            ✕ Close
          </button>
        )}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-7">
        <div className="border border-line bg-surface p-2 text-center">
          <div className="font-mono text-lg font-medium tabular-nums text-ink">
            {metrics.total}
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wider text-muted">
            Total Tickets
          </div>
        </div>

        <div className="border border-line bg-surface p-2 text-center">
          <div className="font-mono text-lg font-medium tabular-nums text-ink">
            {metrics.backlog}
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wider text-muted">
            Backlog
          </div>
        </div>

        <div className="border border-line bg-surface p-2 text-center">
          <div className="font-mono text-lg font-medium tabular-nums text-ink">
            {metrics.wip}
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wider text-muted">
            In Flight
          </div>
        </div>

        <div
          className={[
            'border p-2 text-center',
            metrics.blocked > 0 ? 'border-fail bg-fail-bg text-fail' : 'border-line bg-surface text-ink',
          ].join(' ')}
        >
          <div className="font-mono text-lg font-medium tabular-nums">
            {metrics.blocked}
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wider">
            Blocked
          </div>
        </div>

        <div className="border border-line bg-surface p-2 text-center">
          <div className="font-mono text-lg font-medium tabular-nums text-ink">
            {metrics.done}
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wider text-muted">
            Completed
          </div>
        </div>

        <div className="border border-line bg-surface p-2 text-center">
          <div className="font-mono text-lg font-medium tabular-nums text-ink">
            {metrics.avgCycleTimeFormatted}
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wider text-muted">
            Avg Cycle Time
          </div>
        </div>

        <div
          className={[
            'border p-2 text-center',
            metrics.overdueCount > 0
              ? 'border-warn bg-warn-bg text-warn'
              : 'border-line bg-surface text-ink',
          ].join(' ')}
        >
          <div className="font-mono text-lg font-medium tabular-nums">
            {metrics.overdueCount}
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wider">
            Overdue / Stalled
          </div>
        </div>
      </div>
    </div>
  )
}
