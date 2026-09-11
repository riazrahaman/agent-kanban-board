import type { Task } from '../types'
import StatusBadge from './StatusBadge'
import { statusStyle } from '../status.js'

type Props = {
  task: Task
  onOpen: (id: string) => void
}

export default function TaskCard({ task, onOpen }: Props) {
  const stripe = statusStyle(task.status).stripe

  return (
    <div
      data-id={task.id}
      onClick={() => onOpen(task.id)}
      className={[
        'group cursor-pointer border border-line bg-surface p-3 transition-colors',
        'hover:bg-muted-bg/50',
        'border-l-[3px]',
        stripe,
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
          <span className="font-mono text-xs tabular-nums text-ink tracking-wider">
          {task.id}
        </span>
        <div className="flex items-center gap-1.5">
          <StatusBadge status={task.status} />
        </div>
      </div>

      <p className="text-sm font-medium leading-snug text-ink">
        {task.title}
      </p>

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line/60 pt-2 text-[11px]">
        {task.assigned_agent ? (
          <span className="inline-flex items-center gap-1 font-mono text-ink tabular-nums">
            {task.assigned_agent}
          </span>
        ) : (
          <span className="font-mono text-muted/60 italic">unassigned</span>
        )}

        {task.issues && task.issues.length > 0 && (
          <span className="font-mono text-[10px] tabular-nums text-warn px-1 py-0.5 bg-warn-bg border border-line">
            {task.issues.length} {task.issues.length === 1 ? 'issue' : 'issues'}
          </span>
        )}
      </div>
    </div>
  )
}
