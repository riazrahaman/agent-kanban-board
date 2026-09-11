/**
 * Canonical task-status vocabulary (ADR-001), matching server/store.js's
 * STATUSES exactly. This is what `status` on a Task returned by GET
 * /api/tasks always is. `client/src/types.ts`'s TaskStatus also lists legacy
 * lowercase aliases for backward compatibility with older stored data, but
 * new/live data is always one of these.
 */
export const CANONICAL_STATUSES = {
  BACKLOG: 'BACKLOG',
  BUILDING: 'BUILDING',
  IN_REVIEW: 'IN_REVIEW',
  IN_TEST: 'IN_TEST',
  BLOCKED: 'BLOCKED',
  DONE: 'DONE',
} as const

export type CanonicalStatus = (typeof CANONICAL_STATUSES)[keyof typeof CANONICAL_STATUSES]

/** The three statuses meaning "someone is actively working on this." */
export const ACTIVE_STATUSES: readonly CanonicalStatus[] = [
  CANONICAL_STATUSES.BUILDING,
  CANONICAL_STATUSES.IN_REVIEW,
  CANONICAL_STATUSES.IN_TEST,
]
