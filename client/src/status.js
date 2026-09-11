const STATUS_STYLES = {
  DONE: { stripe: 'border-l-pass', badge: 'bg-pass-bg text-pass' },
  IN_TEST: { stripe: 'border-l-live', badge: 'bg-live-bg text-live' },
  IN_REVIEW: { stripe: 'border-l-warn', badge: 'bg-warn-bg text-warn' },
  BUILDING: { stripe: 'border-l-live', badge: 'bg-live-bg text-live' },
  BLOCKED: { stripe: 'border-l-block', badge: 'bg-block-bg text-block' },
  BACKLOG: { stripe: 'border-l-line', badge: 'bg-muted-bg text-muted' },
  UNKNOWN: { stripe: 'border-l-line', badge: 'bg-muted-bg text-muted' },
}

export function normalizeStatus(status) {
  if (typeof status !== 'string' || !status.trim()) return 'UNKNOWN'
  return status.toUpperCase()
}

export function statusStyle(status) {
  const normalized = normalizeStatus(status)
  return {
    normalized,
    ...(STATUS_STYLES[normalized] ?? STATUS_STYLES.UNKNOWN),
  }
}
