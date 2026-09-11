import { useMemo } from 'react'
import type { Task } from '../types'
import { normalizeStatus } from '../status.js'

type Props = {
  tasks: Task[]
  onOpen: (id: string) => void
}

type ActivityItem = {
  taskId: string
  taskTitle: string
  agentId: string
  message: string
  timestamp: string
}

function isToday(ts: string): boolean {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return false
  const now = new Date()
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  )
}

function formatRelative(ts: string): string {
  const date = new Date(ts)
  const time = date.getTime()
  if (Number.isNaN(time)) return ts
  const diffMs = Math.max(0, Date.now() - time)
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return `${diffSec}s`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h`
  const diffDays = Math.floor(diffHr / 24)
  return `${diffDays}d`
}

export default function SignalRail({ tasks, onOpen }: Props) {
  const active = useMemo(
    () => tasks.filter((t) => normalizeStatus(t.status) === 'BUILDING' && !!t.assigned_agent).length,
    [tasks],
  )

  const blocked = useMemo(
    () => tasks.filter((t) => normalizeStatus(t.status) === 'BLOCKED').length,
    [tasks],
  )

   const doneToday = useMemo(
     () =>
       tasks.filter(
         (t) => normalizeStatus(t.status) === 'DONE' && Array.isArray(t.agent_logs) && t.agent_logs.some((l) => isToday(l.timestamp)),
       ).length,
     [tasks],
   )

   const activities = useMemo<ActivityItem[]>(() => {
     const items: ActivityItem[] = []
     for (const task of tasks) {
       for (const log of Array.isArray(task.agent_logs) ? task.agent_logs : []) {
        items.push({
          taskId: task.id,
          taskTitle: task.title,
          agentId: log.agent_id,
          message: log.message,
          timestamp: log.timestamp,
        })
      }
    }
    return items
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 20)
  }, [tasks])

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-surface/40">
      {/* Rollup Stats */}
      <div className="border-b border-line p-4">
        <h2 className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Signal Overview
        </h2>
        <div className="grid grid-cols-3 gap-2">
          <div className="border border-line bg-surface p-2.5 text-center">
            <div className="font-mono text-xl font-medium tabular-nums text-ink">
              {active}
            </div>
            <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">Active</div>
          </div>

          <div
            className={[
              'border p-2.5 text-center',
              blocked > 0
                ? 'border-fail bg-fail-bg'
                : 'border-line bg-surface',
            ].join(' ')}
          >
            <div
              className={[
                'font-mono text-xl font-medium tabular-nums',
                blocked > 0 ? 'text-fail' : 'text-ink',
              ].join(' ')}
            >
              {blocked}
            </div>
            <div
              className={[
                'mt-0.5 font-mono text-[10px] uppercase tracking-wider',
                blocked > 0 ? 'text-fail' : 'text-ink',
              ].join(' ')}
            >
              Blocked
            </div>
          </div>

          <div className="border border-line bg-surface p-2.5 text-center">
            <div className="font-mono text-xl font-medium tabular-nums text-ink">
              {doneToday}
            </div>
            <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">Done today</div>
          </div>
        </div>
      </div>

      {/* Activity Feed */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5 bg-surface/50">
          <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Activity
          </h2>
          <span className="font-mono text-[10px] tabular-nums text-ink">
            {activities.length} recent
          </span>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-line/40">
          {activities.length === 0 ? (
            <div className="py-8 text-center font-mono text-xs text-muted">
              No recent activity
            </div>
          ) : (
            activities.map((item, idx) => (
              <button
                key={`${item.taskId}-${item.timestamp}-${idx}`}
                onClick={() => onOpen(item.taskId)}
                type="button"
                className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted-bg/50 transition-colors"
                title={`${item.taskTitle}: ${item.message}`}
              >
                <span className="shrink-0 border border-line bg-muted-bg px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-ink max-w-[70px] truncate">
                  {item.agentId}
                </span>
                <span className="flex-1 truncate text-xs text-ink/90 group-hover:text-ink">
                  {item.message}
                </span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted">
                  {formatRelative(item.timestamp)}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </aside>
  )
}
