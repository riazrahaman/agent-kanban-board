/**
 * Canonical task-status vocabulary (ADR-001), matching server/store.js's
 * STATUSES exactly. This is what `status` on a Task returned by GET
 * /api/tasks always is. `client/src/types.ts`'s TaskStatus also lists legacy
 * lowercase aliases for backward compatibility with older stored data, but
 * new/live data is always one of these.
 */
export const CANONICAL_STATUSES = {
  BACKLOG: 'BACKLOG',
  READY: 'READY',
  PLANNING: 'PLANNING',
  IN_PROGRESS: 'IN_PROGRESS',
  IN_REVIEW: 'IN_REVIEW',
  VALIDATION: 'VALIDATION',
  READY_TO_SHIP: 'READY_TO_SHIP',
  DONE: 'DONE',
  BLOCKED: 'BLOCKED',
} as const

export type CanonicalStatus = (typeof CANONICAL_STATUSES)[keyof typeof CANONICAL_STATUSES]

/** The four statuses meaning "someone is actively working on this." */
export const ACTIVE_STATUSES: readonly CanonicalStatus[] = [
  CANONICAL_STATUSES.PLANNING,
  CANONICAL_STATUSES.IN_PROGRESS,
  CANONICAL_STATUSES.IN_REVIEW,
  CANONICAL_STATUSES.VALIDATION,
]

export const CANONICAL_STATUS_LIST = Object.values(CANONICAL_STATUSES)

/**
 * Normalizes any status string (including legacy aliases) to a canonical status.
 */
export function normalizeStatus(status: unknown): CanonicalStatus | 'UNKNOWN' {
  if (typeof status !== 'string' || !status.trim()) return 'UNKNOWN'
  const normalized = status.toUpperCase()
  if (normalized === 'TODO') return CANONICAL_STATUSES.BACKLOG
  if (normalized === 'BUILDING') return CANONICAL_STATUSES.IN_PROGRESS
  if (normalized === 'IN_TEST') return CANONICAL_STATUSES.VALIDATION
  return (CANONICAL_STATUS_LIST as string[]).includes(normalized)
    ? (normalized as CanonicalStatus)
    : 'UNKNOWN'
}
