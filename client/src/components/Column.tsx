import { memo } from 'react'
import type { Task, TaskStatus } from '../types'
import TaskCard from './TaskCard'

type Props = {
  status: TaskStatus
  title: string
  tasks: Task[]
  onOpen: (id: string) => void
  /** Show each card's owning project (unscoped board only). */
  showProject?: boolean
}

// A bucket is unchanged when the id+version signature of its members is
// identical. `version` bumps on every committed mutation (§2.6), so two lists
// with the same ids in the same versions render identically even though the
// SSE stream re-serializes the whole array (and thus new object references)
// on every broadcast.
function sameBucket(a: Task[], b: Task[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].version !== b[i].version) return false
  }
  return true
}

function areEqual(prev: Props, next: Props): boolean {
  return (
    prev.status === next.status &&
    prev.title === next.title &&
    prev.onOpen === next.onOpen &&
    prev.showProject === next.showProject &&
    sameBucket(prev.tasks, next.tasks)
  )
}

function Column({ status, title, tasks, onOpen, showProject = false }: Props) {
  const isDone = status === 'DONE' || status === 'done'

  return (
    <div
      className={[
        'flex w-[85vw] shrink-0 snap-start flex-col border border-line bg-surface/40 transition-opacity md:w-72',
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
          <TaskCard key={task.id} task={task} onOpen={onOpen} showProject={showProject} />
        ))}
      </div>
    </div>
  )
}

export default memo(Column, areEqual)
