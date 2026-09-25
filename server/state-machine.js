/**
 * Loop state machine (KB-01, KB-02, KB-08) — the canonical lifecycle and the
 * role-ownership matrix, extracted verbatim from store.js (ENH-11, v2.10.0).
 *
 * This module is pure: no I/O, no state, no imports. store.js re-exports every
 * symbol here so existing importers (`../store.js`) are unaffected.
 */

// ============================================================================
// Loop Statuses (KB-08) & State Machine (KB-01, KB-02)
// ============================================================================

export const STATUSES = {
  BACKLOG: 'BACKLOG',
  BUILDING: 'BUILDING',
  IN_REVIEW: 'IN_REVIEW',
  IN_TEST: 'IN_TEST',
  BLOCKED: 'BLOCKED',
  DONE: 'DONE',
};

export const VALID_STATUS_LIST = Object.values(STATUSES);

/**
 * Normalizes any status string (including legacy lowercase or aliases)
 * to canonical uppercase loop status.
 */
export function normalizeStatus(status) {
  if (!status || typeof status !== 'string') return null;
  const s = status.trim().toUpperCase();
  if (s === 'TODO') return STATUSES.BACKLOG;
  if (s === 'IN_PROGRESS') return STATUSES.BUILDING;
  if (VALID_STATUS_LIST.includes(s)) return s;
  return null;
}

export function isValidStatus(status) {
  return normalizeStatus(status) !== null;
}

/**
 * Valid transitions per loop protocol (spec Sec 2, Sec 9.4.3 KB-01):
 * BACKLOG -> BUILDING
 * BUILDING -> IN_REVIEW, BLOCKED
 * IN_REVIEW -> IN_TEST, BUILDING, BLOCKED
 * IN_TEST -> DONE, BUILDING, BLOCKED
 * BLOCKED -> BUILDING, IN_REVIEW, IN_TEST, BACKLOG
 * DONE -> terminal
 */
export const VALID_TRANSITIONS = {
  [STATUSES.BACKLOG]: [STATUSES.BUILDING, STATUSES.BLOCKED],
  [STATUSES.BUILDING]: [STATUSES.IN_REVIEW, STATUSES.BLOCKED],
  [STATUSES.IN_REVIEW]: [STATUSES.IN_TEST, STATUSES.BUILDING, STATUSES.BLOCKED],
  [STATUSES.IN_TEST]: [STATUSES.DONE, STATUSES.BUILDING, STATUSES.BLOCKED],
  [STATUSES.BLOCKED]: [STATUSES.BUILDING, STATUSES.IN_REVIEW, STATUSES.IN_TEST, STATUSES.BACKLOG],
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
 * Role ownership rules (spec Sec 1, Sec 3.2, Sec 9.4.3 KB-02):
 * - builder: may set BUILDING, IN_REVIEW
 * - reviewer: may set IN_TEST or return to BUILDING
 * - tester: may set DONE or return to BUILDING
 * - runner / system / human: may set/clear BLOCKED and administer transitions
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

  // BLOCKED transition is runner-only (spec Sec 3.2), no active role sets it manually
  if (to === STATUSES.BLOCKED) {
    return false;
  }

  if (r === 'builder') {
    return [STATUSES.BUILDING, STATUSES.IN_REVIEW].includes(to);
  }

  if (r === 'reviewer') {
    return [STATUSES.IN_TEST, STATUSES.BUILDING].includes(to);
  }

  if (r === 'tester') {
    return [STATUSES.DONE, STATUSES.BUILDING].includes(to);
  }

  return false;
}
