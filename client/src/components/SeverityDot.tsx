import { deriveTaskOwnership, ownershipTooltip, SEVERITY_COLORS } from '../lib/ownership'
import type { Task } from '../types'

type Props = {
  task: Task
}

export default function SeverityDot({ task }: Props) {
  const summary = deriveTaskOwnership(task)
  if (summary.severity === 'none') return null

  const color = SEVERITY_COLORS[summary.severity]
  const tooltip = ownershipTooltip(summary)

  return (
    <span
      className="group/tooltip relative inline-flex h-[11px] w-[11px] shrink-0 cursor-help rounded-[50%] outline-none focus-visible:ring-1 focus-visible:ring-blue focus-visible:ring-offset-1"
      style={{ backgroundColor: color }}
      tabIndex={0}
      role="img"
      aria-label={tooltip}
    >
      <span className="pointer-events-none absolute left-0 top-full z-20 mt-1 w-56 rounded border border-line bg-surface p-2 font-sans text-[11px] leading-snug text-ink opacity-0 transition-opacity duration-150 group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100">
        {tooltip}
      </span>
    </span>
  )
}
