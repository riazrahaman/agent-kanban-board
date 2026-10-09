const STATUS_STYLES = {
  DONE: { stripe: 'border-l-pass', badge: 'bg-pass-bg text-pass' },
  READY_TO_SHIP: { stripe: 'border-l-pass', badge: 'bg-pass-bg text-pass' },
  VALIDATION: { stripe: 'border-l-test', badge: 'bg-test-bg text-test' },
  IN_REVIEW: { stripe: 'border-l-warn', badge: 'bg-warn-bg text-warn' },
  IN_PROGRESS: { stripe: 'border-l-live', badge: 'bg-live-bg text-live' },
  PLANNING: { stripe: 'border-l-block', badge: 'bg-muted-bg text-muted' },
  READY: { stripe: 'border-l-line', badge: 'bg-muted-bg text-muted' },
  BLOCKED: { stripe: 'border-l-block', badge: 'bg-block-bg text-block' },
  BACKLOG: { stripe: 'border-l-line', badge: 'bg-muted-bg text-muted' },
  UNKNOWN: { stripe: 'border-l-line', badge: 'bg-muted-bg text-muted' },
}

const KNOWN_STATUSES = new Set(Object.keys(STATUS_STYLES).filter((status) => status !== 'UNKNOWN'))

export function normalizeStatus(status) {
  if (typeof status !== 'string' || !status.trim()) return 'UNKNOWN'
  const normalized = status.toUpperCase()
  if (normalized === 'TODO') return 'BACKLOG'
  if (normalized === 'BUILDING') return 'IN_PROGRESS'
  if (normalized === 'IN_TEST') return 'VALIDATION'
  return KNOWN_STATUSES.has(normalized) ? normalized : 'UNKNOWN'
}

export function statusStyle(status) {
  const normalized = normalizeStatus(status)
  return {
    normalized,
    ...(STATUS_STYLES[normalized] ?? STATUS_STYLES.UNKNOWN),
  }
}
