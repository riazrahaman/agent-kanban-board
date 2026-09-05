import type { Task, TaskStatus } from '../types'
import TaskCard from './TaskCard'

type Props = {
  status: TaskStatus
  title: string
  tasks: Task[]
  onOpen: (id: string) => void
}

export default function Column({ status, title, tasks, onOpen }: Props) {
  const isDone = status === 'DONE' || status === 'done'

  return (
    <div
      className={[
        'flex w-72 shrink-0 flex-col border border-line bg-surface/40 transition-opacity',
        isDone ? 'opacity-70' : '',
      ].join(' ')}
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-2 bg-surface">
        <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
          {title}
        </h2>
        <span className="font-mono text-[11px] tabular-nums text-muted px-1.5 py-0.5 border border-line bg-muted-bg">
          {tasks.length}
        </span>
      </div>
      <div
        data-status={status}
        className="flex min-h-[120px] flex-1 flex-col gap-2 overflow-y-auto p-2"
      >
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onOpen={onOpen} />
        ))}
      </div>
    </div>
  )
}
