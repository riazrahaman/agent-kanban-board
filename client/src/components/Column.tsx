import { memo } from 'react'
import type { Task, TaskStatus } from '../types'
import TaskCard from './TaskCard'

type Props = {
  status: TaskStatus
  title: string
  stepNumber?: string
  tasks: Task[]
  onOpen: (id: string) => void
  /** Show each card's owning project (unscoped board only). */
  showProject?: boolean
  /** v2.5.0: resolved top-accent class override (per-project column colors). */
  accentClass?: string
}

const COLUMN_ACCENTS: Record<string, string> = {
  BACKLOG: 'border-t-2 border-t-muted/40',
  READY: 'border-t-2 border-t-line',
  PLANNING: 'border-t-2 border-t-block',
  IN_PROGRESS: 'border-t-2 border-t-live',
  IN_REVIEW: 'border-t-2 border-t-warn',
  VALIDATION: 'border-t-2 border-t-test',
  READY_TO_SHIP: 'border-t-2 border-t-pass',
  DONE: 'border-t-2 border-t-pass',
  BLOCKED: 'border-t-2 border-t-fail',
  UNKNOWN: 'border-t-2 border-t-line',
  ISSUES: 'border-t-2 border-t-warn',
  // Backward compatibility aliases
  BUILDING: 'border-t-2 border-t-live',
  IN_TEST: 'border-t-2 border-t-test',
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
    prev.stepNumber === next.stepNumber &&
    prev.onOpen === next.onOpen &&
    prev.showProject === next.showProject &&
    prev.accentClass === next.accentClass &&
    sameBucket(prev.tasks, next.tasks)
  )
}

function Column({ status, title, stepNumber, tasks, onOpen, showProject = false, accentClass }: Props) {
  const isDone = status === 'DONE' || status === 'done'
  const isBlocked = status === 'BLOCKED' || status === 'blocked'
  const normalizedStatus = String(status).toUpperCase()
  const topAccent = accentClass ?? COLUMN_ACCENTS[normalizedStatus] ?? 'border-t-2 border-t-line'

  return (
    <div
      className={[
        'kanban-column flex h-full w-[85vw] shrink-0 snap-start flex-col border border-line bg-surface/40 transition-opacity md:w-72',
        topAccent,
        isDone ? 'opacity-70' : '',
      ].join(' ')}
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-2 bg-surface">
        <div className="flex items-center gap-1.5 min-w-0">
          {stepNumber && (
            <span
              className="shrink-0 font-mono text-[10px] text-muted border border-line px-1 py-0.5 bg-muted-bg"
              title={`Workflow Step ${stepNumber}`}
            >
              {stepNumber}
            </span>
          )}
          <h2 className="truncate font-mono text-xs font-semibold uppercase tracking-wider text-ink">
            {title}
          </h2>
        </div>
        <span
          className={[
            'font-mono text-[11px] tabular-nums px-1.5 py-0.5 border border-line',
            isBlocked && tasks.length > 0
              ? 'bg-fail-bg text-fail border-fail/40 font-bold'
              : 'bg-muted-bg text-muted',
          ].join(' ')}
        >
          {tasks.length}
        </span>
      </div>
      <div
        data-status={status}
        // `column-list` is a phone-layout hook (index.css): on a touch phone
        // below md the list grows to full height and the DOCUMENT scrolls,
        // so content passes behind iOS Safari's floating toolbar; this
        // bottom padding lets the last card scroll clear of it. Keyed on
        // `pointer-coarse:` + `max-md:` (the same condition as the phone
        // layout), so a mouse window under 768px keeps dense padding.
        className="column-list flex min-h-[120px] flex-1 flex-col gap-2 overflow-y-auto overscroll-y-contain p-2 max-md:pointer-coarse:pb-[calc(5rem+env(safe-area-inset-bottom,0px))]"
      >
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            onOpen={onOpen}
            showProject={showProject}
          />
        ))}
      </div>
    </div>
  )
}

export default memo(Column, areEqual)
