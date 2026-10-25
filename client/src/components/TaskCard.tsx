import { memo, useState } from 'react'
import type { Task } from '../types'
import StatusBadge from './StatusBadge'
import SeverityDot from './SeverityDot'
import { statusStyle } from '../status.js'
import { formatStageOwners } from '../lib/stageOwners'
import { decodeStored } from '../sanitize'
import { normalizePriority, priorityBadgeClass } from '../priority'
import { patchTask } from '../api'

type Props = {
  task: Task
  onOpen: (project: string, id: string) => void
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

function TaskCard({
  task,
  onOpen,
  showProject = false,
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

  return (
    <div
      data-id={task.id}
      onClick={() => onOpen(task.project, task.id)}
      className={[
        'group cursor-pointer border border-line bg-surface p-3 transition-colors',
        'hover:bg-muted-bg/50',
        'border-l-[3px]',
        stripe,
        isHigh ? 'border-r-2 border-r-fail' : '',
      ].join(' ')}
    >
      <div className="mb-1.5 flex items-center gap-2">
        {/* The id is an identifier, not prose: it stays on ONE line and
            ellipsises, with the full value in the tooltip.
            v3.9.1 (option C): the header carries ONLY the id, priority, status
            and the severity dot. Project, milestone and estimate moved to the
            footer meta row. The old header put up to five fixed-width chips
            beside the id with `shrink-0 sm:flex-nowrap`, so a 10rem milestone
            chip made the row wider than the card: the id absorbed all the
            shrink (collapsing to `re…`) and the chips still overflowed and were
            clipped by the column. `min-w-[4ch]` keeps the id readable; the
            footer chips use `flex-wrap` + `max-w-full truncate`, so any length
            of milestone ellipsises inside the card instead of pushing its
            neighbours out. */}
        <span
          className="min-w-[4ch] flex-1 truncate font-mono text-xs tabular-nums text-ink tracking-wider"
          title={task.id}
        >
          {task.id}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={`border px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider ${priorityBadgeClass(task.priority)}`}
            title={`Priority: ${task.priority}`}
          >
            {task.priority}
          </span>
          <StatusBadge status={task.status} />
        </div>
        {/* Ownership/severity mark sits LAST in the header row: after the pinned
            badge group instead of beside the id — the 11px dot next to a
            truncated mono id read as part of the id chips and collided with
            project/priority/status on narrow columns (placement feedback,
            variant B: far-right of the header row). */}
        <SeverityDot task={task} />
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

      <div className="mt-2.5 border-t border-line/60 pt-2">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 text-[11px]">
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

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {showProject && task.project && (
            <span
              className="max-w-full min-w-0 truncate border border-line bg-muted-bg px-1 py-0.5 font-mono text-[10px] text-muted"
              title={`Project: ${task.project}`}
            >
              {task.project}
            </span>
          )}
          {task.milestone && (
            <span
              className="max-w-full min-w-0 truncate border border-live bg-live-bg px-1 py-0.5 font-mono text-[10px] text-live"
              title={`Milestone: ${task.milestone}`}
            >
              ◇ {task.milestone}
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
          {task.issues && task.issues.length > 0 && (
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-warn px-1 py-0.5 bg-warn-bg border border-line">
              {task.issues.length} {task.issues.length === 1 ? 'issue' : 'issues'}
            </span>
          )}
        </div>
        </div>
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
