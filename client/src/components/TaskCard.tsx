import { memo } from 'react'
import type { Task } from '../types'
import StatusBadge from './StatusBadge'
import { statusStyle } from '../status.js'
import { formatStageOwners } from '../lib/stageOwners'

type Props = {
  task: Task
  onOpen: (id: string) => void
  /** Show the owning project — only meaningful on the unscoped "all projects" board. */
  showProject?: boolean
}

// A task's `version` bumps on every committed mutation (§2.6), so id+version
// is a sound identity for a card: unchanged version == unchanged card. This
// remains correct for `stage_owners`, which is only ever mutated by a persisted
// write that also bumps `version` — so id+version stays a sufficient key.
function areEqual(prev: Props, next: Props): boolean {
  return (
    prev.task.id === next.task.id &&
    prev.task.version === next.task.version &&
    prev.onOpen === next.onOpen &&
    prev.showProject === next.showProject
  )
}

function TaskCard({ task, onOpen, showProject = false }: Props) {
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
          <span className="font-mono text-xs tabular-nums text-ink tracking-wider break-words [overflow-wrap:anywhere]">
          {task.id}
        </span>
        <div className="flex items-center gap-1.5">
          {showProject && task.project && (
            <span
              className="max-w-[10rem] truncate border border-line bg-muted-bg px-1 py-0.5 font-mono text-[10px] text-muted"
              title={`Project: ${task.project}`}
            >
              {task.project}
            </span>
          )}
          <StatusBadge status={task.status} />
        </div>
      </div>

      <p className="text-sm font-medium leading-snug text-ink break-words [overflow-wrap:anywhere]">
        {task.title}
      </p>

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line/60 pt-2 text-[11px]">
        {task.assigned_agent ? (
          <span className="inline-flex items-center gap-1 font-mono text-ink tabular-nums break-words [overflow-wrap:anywhere]">
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

      {task.stage_owners && Object.keys(task.stage_owners).length > 0 && (
        <div
          className="mt-1 truncate font-mono text-[10px] text-muted"
          title={formatStageOwners(task.stage_owners)}
        >
          {formatStageOwners(task.stage_owners)}
        </div>
      )}
    </div>
  )
}

export default memo(TaskCard, areEqual)
