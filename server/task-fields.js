/**
 * Pure task-field validation & ranking (ENH-11, v2.10.0) — extracted verbatim
 * from store.js. No state, no I/O: these are the shape/bounds rules the create
 * and patch paths both apply.
 *
 * Not extracted: `dependencyGate` and `validateDependencyGraph` — they resolve
 * tasks through `getTask()`, so they stay in the stateful store core. store.js
 * re-exports the symbols below so existing importers are unaffected.
 */

export const PRIVILEGED_ROLE_SET = new Set(['runner', 'system', 'human', 'admin']);

export function isPrivilegedRole(role) {
  return typeof role === 'string' && PRIVILEGED_ROLE_SET.has(role.toLowerCase());
}

/**
 * BUG-02 (v2.5.4): priority must be a string in {low, medium, high}
 * (case-insensitive). Absent/null defaults to medium; anything else is a 400.
 * Returns an error message or null when valid.
 */
export function validatePriority(priority) {
  if (priority === undefined || priority === null || priority === '') return null;
  if (typeof priority !== 'string') return 'priority must be a string (low, medium, or high)';
  if (!['low', 'medium', 'high'].includes(priority.toLowerCase())) {
    return 'priority must be one of: low, medium, high';
  }
  return null;
}

// BUG-05 (v2.5.8) input bounds. Live data peaks at ~108-char titles and
// ~2.5k descriptions, and a metadata blob under 1 KB; these caps are generous
// yet stop an unbounded payload from being copied into every partition rewrite
// and every SSE snapshot.
export const MAX_TITLE_LEN = 200;
export const MAX_DESCRIPTION_LEN = 20000;
export const MAX_METADATA_BYTES = 8000;

/**
 * BUG-05 (v2.5.8): `depends_on` must be an array of non-empty strings. A bare
 * string (a common typo) used to be silently coerced to `[]`, hiding the
 * caller's intent; reject it instead. Returns an error message or null.
 */
export function validateDependsOn(dependsOn) {
  if (dependsOn === undefined || dependsOn === null) return null;
  if (!Array.isArray(dependsOn)) return 'depends_on must be an array of task ids';
  for (const dep of dependsOn) {
    if (typeof dep !== 'string' || dep.trim() === '') {
      return 'depends_on must contain only non-empty task ids';
    }
  }
  return null;
}

/**
 * BUG-05 (v2.5.8): `metadata` must be a plain object small enough to persist.
 * A string/array/number silently became `{}` before, discarding the caller's
 * data without a word; a huge blob bloated every rewrite. Returns an error
 * message or null.
 */
export function validateMetadata(metadata) {
  if (metadata === undefined || metadata === null) return null;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    return 'metadata must be a JSON object';
  }
  let serialized;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    return 'metadata must be JSON-serializable';
  }
  if (serialized === undefined) return 'metadata must be a JSON object';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) {
    return `metadata must be at most ${MAX_METADATA_BYTES} bytes`;
  }
  return null;
}

/**
 * §2.7 priority rank for the fair claim queue: high < medium < low (ascending).
 * Unknown / absent priority defaults to medium (matching create-time default).
 */
export function priorityRank(priority) {
  if (priority === 'high' || priority === 'HIGH') return 0;
  if (priority === 'low' || priority === 'LOW') return 2;
  return 1;
}
