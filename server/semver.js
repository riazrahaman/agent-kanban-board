/**
 * v3.12.7 - the smallest semver comparison the deploy-drift monitor needs.
 *
 * Why this exists: the monitor used to ask one question with string equality
 * (`running === latest`). That answer is wrong in two directions:
 *
 *   - the running build may be AHEAD of the newest release. That is not drift;
 *     it is a release that has not been published yet (or a hotfix deploy).
 *     String equality called it drift and alerted after the grace window.
 *   - "which tag is newest" is not array order and is not lexicographic:
 *     `3.12.10` sorts before `3.12.9` as a string, and the GitHub tags endpoint
 *     returns tags in the order they were created, not in version order.
 *
 * Scope, deliberately narrow: `vX.Y.Z` with an optional prerelease/build suffix
 * and an optional leading `v` (either case). Anything else - `unknown`, `main`,
 * `2026-11-11` - is UNPARSABLE and returns null; the caller treats that as
 * `unknown`, never as drift.
 *
 * Prerelease ordering follows semver.org 11.4: a version WITH a prerelease is
 * LOWER than the same numeric triple without one (`3.12.7-rc.1 < 3.12.7`), and
 * prerelease identifiers compare numerically when both are numeric, otherwise
 * lexicographically with numeric identifiers ranking lower. Build metadata
 * (`+sha`) is parsed and ignored, as the spec requires.
 *
 * This module is pure: no I/O, no clock, no imports.
 */

// Case-insensitive `v` only on the prefix; the rest of the grammar is semver's.
const SEMVER_RE = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parse a version string into its numeric triple plus prerelease identifiers.
 *
 * @param {unknown} value
 * @returns {{major: number, minor: number, patch: number, prerelease: string[]} | null}
 *   `null` when the value is not a version this module understands.
 */
export function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = SEMVER_RE.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** True when `value` parses as a version this module can order. */
export function isValidVersion(value) {
  return parseSemver(value) !== null;
}

function cmpNumbers(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** semver 11.4 identifier ordering: numeric identifiers rank below alphanumeric. */
function cmpIdentifiers(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return cmpNumbers(Number(a), Number(b));
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function cmpParsed(a, b) {
  const triple = cmpNumbers(a.major, b.major) || cmpNumbers(a.minor, b.minor) || cmpNumbers(a.patch, b.patch);
  if (triple !== 0) return triple;

  // Same numeric triple: no prerelease beats a prerelease.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    // A shorter identifier list ranks lower when every shared id is equal.
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    const diff = cmpIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Order two version strings.
 *
 * @returns {-1|0|1|null} -1 when `a < b`, 0 when equal, 1 when `a > b`, and
 *   `null` when either side is unparsable. Callers decide what unparsable
 *   means; the deploy-drift monitor maps it to `unknown`, never to drift.
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  return cmpParsed(pa, pb);
}

/**
 * Pick the HIGHEST version from a list of tag strings or `{ name }` objects
 * (the shape GitHub's `/tags` endpoint returns).
 *
 * Ignores unparsable entries, never relies on array order, and returns the
 * original tag spelling (so `v3.12.7` stays `v3.12.7`). Returns null when no
 * entry parses.
 *
 * @param {unknown} tags
 * @returns {string|null}
 */
export function pickHighestTag(tags) {
  if (!Array.isArray(tags)) return null;
  let best = null;
  let bestTag = null;
  for (const entry of tags) {
    const raw = typeof entry === 'string' ? entry : entry && typeof entry.name === 'string' ? entry.name : null;
    if (!raw) continue;
    const parsed = parseSemver(raw);
    if (!parsed) continue;
    if (best === null || cmpParsed(parsed, best) > 0) {
      best = parsed;
      bestTag = raw;
    }
  }
  return bestTag;
}

export default { parseSemver, compareSemver, pickHighestTag, isValidVersion };
