import { useMemo } from 'react'
import type { Task } from '../types'

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
    () => tasks.filter((t) => t.status === 'in_progress' && !!t.assigned_agent).length,
    [tasks],
  )

  const blocked = useMemo(
    () => tasks.filter((t) => t.status === 'blocked').length,
    [tasks],
  )

  const doneToday = useMemo(
    () =>
      tasks.filter(
        (t) => t.status === 'done' && t.agent_logs.some((l) => isToday(l.timestamp)),
      ).length,
    [tasks],
  )

  const activities = useMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = []
    for (const task of tasks) {
      for (const log of task.agent_logs) {
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
    <aside className="flex w-80 shrink-0 flex-col border-l border-zinc-200 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-900">
      {/* Rollup Stats */}
      <div className="border-b border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Signal Overview
        </h2>
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border border-zinc-200 bg-white p-2.5 text-center dark:border-zinc-800 dark:bg-zinc-800/60">
            <div className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              {active}
            </div>
            <div className="text-[11px] font-medium text-zinc-500">Active</div>
          </div>

          <div
            className={[
              'rounded-lg border p-2.5 text-center',
              blocked > 0
                ? 'border-red-200 bg-red-50/50 dark:border-red-500/30 dark:bg-red-500/10'
                : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-800/60',
            ].join(' ')}
          >
            <div
              className={[
                'text-xl font-semibold',
                blocked > 0
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-zinc-900 dark:text-zinc-100',
              ].join(' ')}
            >
              {blocked}
            </div>
            <div
              className={[
                'text-[11px] font-medium',
                blocked > 0
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-zinc-500',
              ].join(' ')}
            >
              Blocked
            </div>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-2.5 text-center dark:border-zinc-800 dark:bg-zinc-800/60">
            <div className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              {doneToday}
            </div>
            <div className="text-[11px] font-medium text-zinc-500">Done today</div>
          </div>
        </div>
      </div>

      {/* Activity Feed */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Activity
          </h2>
          <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
            {activities.length} recent
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-1">
          {activities.length === 0 ? (
            <div className="py-8 text-center text-xs text-zinc-400 dark:text-zinc-600">
              No recent activity
            </div>
          ) : (
            activities.map((item, idx) => (
              <button
                key={`${item.taskId}-${item.timestamp}-${idx}`}
                onClick={() => onOpen(item.taskId)}
                type="button"
                className="group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                title={`${item.taskTitle}: ${item.message}`}
              >
                <span className="shrink-0 rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 max-w-[70px] truncate">
                  {item.agentId}
                </span>
                <span className="flex-1 truncate text-xs text-zinc-600 dark:text-zinc-400 group-hover:text-zinc-900 dark:group-hover:text-zinc-200">
                  {item.message}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">
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
