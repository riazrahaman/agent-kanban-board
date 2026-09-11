import type { TaskStatus } from '../types'
import { statusStyle } from '../status.js'

type Props = { status: TaskStatus | string }

export default function StatusBadge({ status }: Props) {
  const style = statusStyle(status)
  const { normalized } = style
  const isRunning = normalized === 'BUILDING' || normalized === 'IN_TEST'
  const marker = normalized === 'IN_REVIEW' ? '▲ ' : isRunning ? '• ' : ''

  return (
    <span
      className={`inline-flex items-center border-l-[3px] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${style.stripe} ${style.badge}`}
      aria-label={`Status: ${normalized}`}
    >
      {marker}{normalized}
    </span>
  )
}
