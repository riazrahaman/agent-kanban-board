import { deriveTaskOwnership, severityPresentation, SEVERITY_COLORS } from '../lib/ownership'
import type { Task } from '../types'

type Props = {
  task: Task
}

export default function SeverityDot({ task }: Props) {
  const summary = deriveTaskOwnership(task)
  const mark = severityPresentation(summary, task.status)
  if (!mark) return null

  // v3.9.6: a card filed straight into DONE has no stage history. A hollow mark
  // says "nobody witnessed this work", which is different from "separation held"
  // (green) and from an unstarted card (no mark at all).
  const hollow = mark.tone === 'hollow'
  const color = mark.tone === 'hollow' ? 'transparent' : SEVERITY_COLORS[mark.tone]
  const tooltip = mark.tooltip

  return (
    <span
      className={`group/tooltip relative inline-flex h-[11px] w-[11px] shrink-0 cursor-help rounded-[50%] outline-none focus-visible:ring-1 focus-visible:ring-blue focus-visible:ring-offset-1${hollow ? ' border border-muted bg-transparent' : ''}`}
      style={hollow ? undefined : { backgroundColor: color }}
      tabIndex={0}
      role="img"
      aria-label={tooltip}
    >
      <span className="pointer-events-none absolute right-0 top-full z-20 mt-1 w-56 rounded border border-line bg-surface p-2 font-sans text-[11px] leading-snug text-ink opacity-0 transition-opacity duration-150 group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100">
        {tooltip}
      </span>
    </span>
  )
}
