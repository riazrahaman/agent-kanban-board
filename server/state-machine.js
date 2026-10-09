/**
 * Loop state machine (KB-01, KB-02, KB-08) — the canonical lifecycle and the
 * role-ownership matrix, upgraded to AgentOS 8-state workflow (ADR-004, v3.0.0).
 *
 * States:
 * BACKLOG -> READY -> PLANNING -> IN_PROGRESS -> IN_REVIEW -> VALIDATION -> READY_TO_SHIP -> DONE
 * (+ side state BLOCKED)
 *
 * This module is pure: no I/O, no state, no imports. store.js re-exports every
 * symbol here so existing importers (`../store.js`) are unaffected.
 */

// ============================================================================
// Loop Statuses (KB-08) & State Machine (KB-01, KB-02, ADR-004)
// ============================================================================

export const STATUSES = {
  BACKLOG: 'BACKLOG',
  READY: 'READY',
  PLANNING: 'PLANNING',
  IN_PROGRESS: 'IN_PROGRESS',
  IN_REVIEW: 'IN_REVIEW',
  VALIDATION: 'VALIDATION',
  READY_TO_SHIP: 'READY_TO_SHIP',
  DONE: 'DONE',
  BLOCKED: 'BLOCKED',
};

export const VALID_STATUS_LIST = Object.values(STATUSES);

export const ACTIVE_STATUSES = [
  STATUSES.PLANNING,
  STATUSES.IN_PROGRESS,
  STATUSES.IN_REVIEW,
  STATUSES.VALIDATION,
];

export const ACTIVE_STATUS_SET = new Set(ACTIVE_STATUSES);

/**
 * Normalizes any status string (including legacy lowercase or aliases)
 * to canonical uppercase loop status.
 *
 * Legacy mappings:
 * - TODO -> BACKLOG
 * - BUILDING -> IN_PROGRESS
 * - IN_TEST -> VALIDATION
 */
export function normalizeStatus(status) {
  if (!status || typeof status !== 'string') return null;
  const s = status.trim().toUpperCase();
  if (s === 'TODO') return STATUSES.BACKLOG;
  if (s === 'BUILDING') return STATUSES.IN_PROGRESS;
  if (s === 'IN_TEST') return STATUSES.VALIDATION;
  if (VALID_STATUS_LIST.includes(s)) return s;
  return null;
}

export function isValidStatus(status) {
  return normalizeStatus(status) !== null;
}

/**
 * Valid transitions per AgentOS 8-state lifecycle (ADR-004):
 * BACKLOG        -> READY, BLOCKED
 * READY          -> PLANNING, IN_PROGRESS, BACKLOG, BLOCKED
 * PLANNING       -> IN_PROGRESS, READY, BLOCKED
 * IN_PROGRESS    -> IN_REVIEW, PLANNING, BLOCKED
 * IN_REVIEW      -> VALIDATION, IN_PROGRESS, BLOCKED
 * VALIDATION     -> READY_TO_SHIP, IN_PROGRESS, BLOCKED
 * READY_TO_SHIP  -> DONE, IN_PROGRESS, BLOCKED
 * BLOCKED        -> BACKLOG, READY, PLANNING, IN_PROGRESS, IN_REVIEW, VALIDATION
 * DONE           -> (terminal)
 */
export const VALID_TRANSITIONS = {
  [STATUSES.BACKLOG]: [STATUSES.READY, STATUSES.BLOCKED],
  [STATUSES.READY]: [STATUSES.PLANNING, STATUSES.IN_PROGRESS, STATUSES.BACKLOG, STATUSES.BLOCKED],
  [STATUSES.PLANNING]: [STATUSES.IN_PROGRESS, STATUSES.READY, STATUSES.BLOCKED],
  [STATUSES.IN_PROGRESS]: [STATUSES.IN_REVIEW, STATUSES.PLANNING, STATUSES.BLOCKED],
  [STATUSES.IN_REVIEW]: [STATUSES.VALIDATION, STATUSES.IN_PROGRESS, STATUSES.BLOCKED],
  [STATUSES.VALIDATION]: [STATUSES.READY_TO_SHIP, STATUSES.IN_PROGRESS, STATUSES.BLOCKED],
  [STATUSES.READY_TO_SHIP]: [STATUSES.DONE, STATUSES.IN_PROGRESS, STATUSES.BLOCKED],
  [STATUSES.BLOCKED]: [
    STATUSES.BACKLOG,
    STATUSES.READY,
    STATUSES.PLANNING,
    STATUSES.IN_PROGRESS,
    STATUSES.IN_REVIEW,
    STATUSES.VALIDATION,
  ],
  [STATUSES.DONE]: [],
};

export function canTransition(fromStatus, toStatus) {
  const from = normalizeStatus(fromStatus);
  const to = normalizeStatus(toStatus);
  if (!from || !to) return false;
  if (from === to) return true;
  const allowed = VALID_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

/**
 * Role ownership rules (ADR-004):
 * - planner: BACKLOG->READY, READY->PLANNING, PLANNING->IN_PROGRESS, and return to READY
 * - builder: -> IN_PROGRESS, -> IN_REVIEW
 * - reviewer: -> VALIDATION, or return to IN_PROGRESS
 * - tester / validator: -> READY_TO_SHIP, or return to IN_PROGRESS (cannot set DONE)
 * - releaser: READY_TO_SHIP -> DONE
 * - runner / system / human / admin: may set/clear BLOCKED and administer transitions
 */
export function canRoleTransition(role, fromStatus, toStatus) {
  const from = normalizeStatus(fromStatus);
  const to = normalizeStatus(toStatus);
  if (!from || !to) return false;
  if (from === to) return true;

  const r = typeof role === 'string' ? role.toLowerCase() : null;
  if (['runner', 'system', 'human', 'admin'].includes(r)) {
    return true;
  }

  // BLOCKED transition is runner/admin/privileged-only, no regular agent sets it manually
  if (to === STATUSES.BLOCKED) {
    return false;
  }

  if (r === 'planner') {
    return [STATUSES.READY, STATUSES.PLANNING, STATUSES.IN_PROGRESS].includes(to);
  }

  if (r === 'builder') {
    return [STATUSES.IN_PROGRESS, STATUSES.IN_REVIEW].includes(to);
  }

  if (r === 'reviewer') {
    return [STATUSES.VALIDATION, STATUSES.IN_PROGRESS].includes(to);
  }

  if (r === 'tester' || r === 'validator') {
    return [STATUSES.READY_TO_SHIP, STATUSES.IN_PROGRESS].includes(to);
  }

  if (r === 'releaser') {
    return [STATUSES.DONE, STATUSES.IN_PROGRESS].includes(to);
  }

  return false;
}
