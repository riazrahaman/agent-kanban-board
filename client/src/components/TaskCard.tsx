import type { Task } from '../types'

const PRIORITY_STYLES: Record<Task['priority'], { dot: string; label: string }> = {
  high: { dot: 'bg-red-600 dark:bg-red-500', label: 'High' },
  medium: { dot: 'bg-amber-600 dark:bg-amber-500', label: 'Medium' },
  low: { dot: 'bg-zinc-400 dark:bg-zinc-500', label: 'Low' },
}

type Props = {
  task: Task
  onOpen: (id: string) => void
}

export default function TaskCard({ task, onOpen }: Props) {
  const priority = PRIORITY_STYLES[task.priority]
  const isActive = task.status === 'in_progress' && !!task.assigned_agent

  return (
    <div
      data-id={task.id}
      onClick={() => onOpen(task.id)}
      className={[
        'group cursor-pointer rounded-lg border border-zinc-200 bg-white p-3 shadow-sm transition-all',
        'hover:border-zinc-300 hover:bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-800/60 dark:hover:border-zinc-700 dark:hover:bg-zinc-800',
        isActive
          ? 'ring-2 ring-emerald-600/35 border-emerald-600/35 dark:ring-emerald-500/50 dark:border-emerald-800/50'
          : '',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-snug text-zinc-900 dark:text-zinc-100">{task.title}</p>
        <span
          title={`${priority.label} priority`}
          className={`mt-1 h-2 w-2 shrink-0 rounded-full ${priority.dot}`}
        />
      </div>

      {task.assigned_agent && (
        <div className="mt-2 flex items-center gap-1">
          <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            <span aria-hidden>👤</span>
            {task.assigned_agent}
          </span>
        </div>
      )}
    </div>
  )
}
