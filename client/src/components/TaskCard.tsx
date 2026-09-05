import type { Task } from '../types'

type Props = {
  task: Task
  onOpen: (id: string) => void
}

type StatusStyle = {
  stripe: string
  pillBg: string
  pillText: string
  glyph?: string
  pulsingDot?: boolean
}

function getStatusStyle(status: string): StatusStyle {
  const s = status?.toUpperCase() ?? 'BACKLOG'
  switch (s) {
    case 'DONE':
      return {
        stripe: 'border-l-pass',
        pillBg: 'bg-pass-bg',
        pillText: 'text-pass',
      }
    case 'IN_TEST':
      return {
        stripe: 'border-l-live',
        pillBg: 'bg-live-bg',
        pillText: 'text-live',
        pulsingDot: true,
      }
    case 'IN_REVIEW':
      return {
        stripe: 'border-l-warn',
        pillBg: 'bg-warn-bg',
        pillText: 'text-warn',
        glyph: '▲',
      }
    case 'BUILDING':
      return {
        stripe: 'border-l-live',
        pillBg: 'bg-live-bg',
        pillText: 'text-live',
        pulsingDot: true,
      }
    case 'BLOCKED':
      return {
        stripe: 'border-l-block',
        pillBg: 'bg-block-bg',
        pillText: 'text-block',
      }
    case 'BACKLOG':
    default:
      return {
        stripe: 'border-l-line',
        pillBg: 'bg-muted-bg',
        pillText: 'text-muted',
      }
  }
}

export default function TaskCard({ task, onOpen }: Props) {
  const statusStyle = getStatusStyle(task.status)

  return (
    <div
      data-id={task.id}
      onClick={() => onOpen(task.id)}
      className={[
        'group cursor-pointer border border-line bg-surface p-3 transition-colors',
        'hover:bg-muted-bg/50',
        'border-l-[3px]',
        statusStyle.stripe,
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="font-mono text-xs tabular-nums text-muted tracking-wider">
          {task.id}
        </span>
        <div className="flex items-center gap-1.5">
          <span
            className={[
              'inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]',
              statusStyle.pillBg,
              statusStyle.pillText,
            ].join(' ')}
          >
            {statusStyle.glyph && <span>{statusStyle.glyph}</span>}
            {statusStyle.pulsingDot && (
              <span className="inline-block h-1.5 w-1.5 animate-ping rounded-full bg-current opacity-75" />
            )}
            {task.status}
          </span>
        </div>
      </div>

      <p className="text-sm font-medium leading-snug text-ink">
        {task.title}
      </p>

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line/60 pt-2 text-[11px]">
        {task.assigned_agent ? (
          <span className="inline-flex items-center gap-1 font-mono text-muted tabular-nums">
            <span aria-hidden>👤</span>
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
