import type { TaskStatus } from '../types'

type Props = { status: TaskStatus | string }

const STATUS_STYLES: Record<string, string> = {
  DONE: 'border-l-pass bg-pass-bg text-pass',
  IN_TEST: 'border-l-live bg-live-bg text-live',
  IN_REVIEW: 'border-l-warn bg-warn-bg text-warn',
  BUILDING: 'border-l-live bg-live-bg text-live',
  BLOCKED: 'border-l-block bg-block-bg text-block',
  BACKLOG: 'border-l-line bg-muted-bg text-muted',
  UNKNOWN: 'border-l-line bg-muted-bg text-muted',
}

export default function StatusBadge({ status }: Props) {
  const normalized = typeof status === 'string' && status.trim()
    ? status.toUpperCase()
    : 'UNKNOWN'
  const isRunning = normalized === 'BUILDING' || normalized === 'IN_TEST'
  const marker = normalized === 'IN_REVIEW' ? '▲ ' : isRunning ? '• ' : ''

  return (
    <span
      className={`inline-flex items-center border-l-[3px] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${STATUS_STYLES[normalized] ?? STATUS_STYLES.UNKNOWN}`}
      aria-label={`Status: ${normalized}`}
    >
      {marker}{normalized}
    </span>
  )
}
