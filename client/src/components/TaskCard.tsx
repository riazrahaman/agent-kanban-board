import { memo, useState } from 'react'
import type { Task } from '../types'
import StatusBadge from './StatusBadge'
import { statusStyle } from '../status.js'
import { formatStageOwners } from '../lib/stageOwners'
import { decodeStored } from '../sanitize'
import { normalizePriority, priorityBadgeClass } from '../priority'
import { patchTask } from '../api'

type Props = {
  task: Task
  onOpen: (id: string) => void
  /** Show the owning project — only meaningful on the unscoped "all projects" board. */
  showProject?: boolean
  neighborAboveId?: string
  neighborBelowId?: string
  onReorder?: (sourceId: string, targetId: string) => void
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
    prev.showProject === next.showProject &&
    prev.neighborAboveId === next.neighborAboveId &&
    prev.neighborBelowId === next.neighborBelowId &&
    prev.onReorder === next.onReorder
  )
}

function TaskCard({
  task,
  onOpen,
  showProject = false,
  neighborAboveId,
  neighborBelowId,
  onReorder,
}: Props) {
  const stripe = statusStyle(task.status).stripe
  const isHigh = normalizePriority(task.priority) === 'high'
  const estimate = (task.metadata?.estimate ?? task.metadata?.points ?? task.metadata?.size) as string | number | undefined
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState(task.title)

  const handleSaveTitle = async (e?: React.SyntheticEvent) => {
    e?.stopPropagation()
    const trimmed = draftTitle.trim()
    if (!trimmed || trimmed === task.title) {
      setDraftTitle(task.title)
      setEditingTitle(false)
      return
    }
    try {
      await patchTask(task.id, { title: trimmed }, { project: task.project, expected_version: task.version })
    } catch {
      setDraftTitle(task.title)
    } finally {
      setEditingTitle(false)
    }
  }

  const handleMoveUp = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (neighborAboveId && onReorder) {
      onReorder(task.id, neighborAboveId)
    }
  }

  const handleMoveDown = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (neighborBelowId && onReorder) {
      onReorder(task.id, neighborBelowId)
    }
  }

  return (
    <div
      data-id={task.id}
      onClick={() => onOpen(task.id)}
      className={[
        'group cursor-pointer border border-line bg-surface p-3 transition-colors',
        'hover:bg-muted-bg/50',
        'border-l-[3px]',
        stripe,
        isHigh ? 'border-r-2 border-r-fail' : '',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        {/* The id is an identifier, not prose: it must stay on ONE line. Wrapping
            it (overflow-wrap:anywhere) was a regression — `anywhere` lowers the
            element's min-content size, and with `min-width:auto` in this flex row
            the span then absorbed nearly all the shrink, collapsing a long id into
            a ~30px sliver wrapped character-by-character over 11 lines. `min-w-0
            flex-1 truncate` lets it claim the row and ellipsise instead, with the
            full value in the tooltip. The badge group is pinned so it cannot be
            squeezed either. */}
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs tabular-nums text-ink tracking-wider"
          title={task.id}
        >
          {task.id}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {(neighborAboveId || neighborBelowId) && (
            <div className="flex items-center gap-0.5 border border-line bg-muted-bg px-0.5 py-0.2">
              {neighborAboveId && (
                <button
                  type="button"
                  onClick={handleMoveUp}
                  title="Move card up in column"
                  aria-label="Move card up in column"
                  className="px-0.5 font-mono text-[9px] text-muted hover:text-ink transition-colors active:scale-90"
                >
                  ▲
                </button>
              )}
              {neighborBelowId && (
                <button
                  type="button"
                  onClick={handleMoveDown}
                  title="Move card down in column"
                  aria-label="Move card down in column"
                  className="px-0.5 font-mono text-[9px] text-muted hover:text-ink transition-colors active:scale-90"
                >
                  ▼
                </button>
              )}
            </div>
          )}
          {showProject && task.project && (
            <span
              className="max-w-[10rem] truncate border border-line bg-muted-bg px-1 py-0.5 font-mono text-[10px] text-muted"
              title={`Project: ${task.project}`}
            >
              {task.project}
            </span>
          )}
          {estimate !== undefined && estimate !== '' && (
            <span
              className="border border-line bg-muted-bg px-1 py-0.5 font-mono text-[10px] tabular-nums text-muted"
              title={`Estimate / Effort: ${estimate}`}
            >
              ⚡ {String(estimate)}
            </span>
          )}
          <span
            className={`border px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider ${priorityBadgeClass(task.priority)}`}
            title={`Priority: ${task.priority}`}
          >
            {task.priority}
          </span>
          <StatusBadge status={task.status} />
        </div>
      </div>

      {editingTitle ? (
        <input
          type="text"
          value={draftTitle}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={handleSaveTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSaveTitle(e)
            if (e.key === 'Escape') {
              setDraftTitle(task.title)
              setEditingTitle(false)
            }
          }}
          autoFocus
          className="w-full border border-line bg-surface px-1.5 py-0.5 font-mono text-sm text-ink focus:outline-none"
        />
      ) : (
        <p
          className="text-sm font-medium leading-snug text-ink break-words [overflow-wrap:anywhere]"
          onDoubleClick={(e) => {
            e.stopPropagation()
            setDraftTitle(task.title)
            setEditingTitle(true)
          }}
          title="Double-click to edit title"
        >
          {decodeStored(task.title)}
        </p>
      )}

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line/60 pt-2 text-[11px]">
        {task.assigned_agent ? (
          /* Agent ids are identifiers: one line, ellipsised, full value in the
             tooltip. `inline-flex` + overflow-wrap let this wrap into a narrow
             column when the row was tight, so it is pinned the same way as the
             header id. */
          <span
            className="min-w-0 truncate font-mono text-ink tabular-nums"
            title={task.assigned_agent}
          >
            {task.assigned_agent}
          </span>
        ) : (
          <span className="font-mono text-muted/60 italic">unassigned</span>
        )}

        {task.issues && task.issues.length > 0 && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-warn px-1 py-0.5 bg-warn-bg border border-line">
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
