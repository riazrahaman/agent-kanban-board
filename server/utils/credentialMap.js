/**
 * §2.10 — boot-time credential-map coverage check.
 *
 * WHY THIS EXISTS
 *   On 2026-10-08 a deployment typo overwrote `KANBAN_PROJECT_TOKENS` on the
 *   kanbann service, replacing a 10-entry map with a single entry. Eight
 *   projects lost API access. The server booted cleanly and served traffic; the
 *   only signal was 403s at the clients, hours later. Nothing in the logs said
 *   "eight of your nine projects can no longer authenticate".
 *
 *   A well-formed but UNDER-COVERED map is the dangerous shape: JSON.parse
 *   succeeds, so the existing `malformed` guard never fires, and the service
 *   looks healthy while most projects are locked out.
 *
 * WHAT THIS DOES
 *   At boot, compare the projects named in the token map against the projects
 *   that actually have a store file. Any disparity is reported loudly — as a
 *   warning line, and in `GET /api/health` as `credential_map`, so a monitoring
 *   probe can see it without reading logs.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *   It never throws and never exits. A coverage mismatch is an operator signal,
 *   not a reason to take the board down: the projects that ARE covered must keep
 *   working. Failing closed here would turn a partial outage into a total one.
 */

/**
 * Compares the projects covered by `KANBAN_PROJECT_TOKENS` with the projects
 * that have a store file.
 *
 * Accepts either:
 * - the direct result of `parseProjectTokens()` ({ map: Map } or { malformed: true } or null)
 * - a Map instance
 * - a plain object mapping project -> token
 * - legacy (storeProjects, tokenMap, parsed) signature for backwards compatibility.
 *
 * @param {string[]} storeProjects - project names present in the store.
 * @param {object|Map|null} tokenInput - parsed token result, Map, or object.
 * @param {{malformed?: boolean}} [parsedLegacy] - optional legacy parsed parameter.
 * @returns {object} a report; `status` is one of:
 *   'ok'          every store project is covered
 *   'undercovered' one or more store projects have no token (the 2026-10-08 case)
 *   'overcovered' the map names projects with no store file (usually harmless)
 *   'unset'       no map configured — legacy single-token mode, nothing to check
 *   'malformed'   the map is not a valid object; the auth layer already 503s
 */
export function checkCredentialCoverage(storeProjects = [], tokenInput = null, parsedLegacy = null) {
  if (parsedLegacy?.malformed || tokenInput?.malformed) {
    return { status: 'malformed', covered: [], missing: [], extra: [],
             summary: 'KANBAN_PROJECT_TOKENS is malformed JSON' };
  }

  let covered;
  if (!tokenInput || Array.isArray(tokenInput)) {
    return { status: 'unset', covered: [], missing: [], extra: [],
             summary: 'KANBAN_PROJECT_TOKENS is unset — legacy single-token mode' };
  } else if (tokenInput?.map instanceof Map) {
    covered = Array.from(tokenInput.map.keys()).sort();
  } else if (tokenInput instanceof Map) {
    covered = Array.from(tokenInput.keys()).sort();
  } else if (typeof tokenInput === 'object') {
    covered = Object.keys(tokenInput).sort();
  } else {
    return { status: 'unset', covered: [], missing: [], extra: [],
             summary: 'KANBAN_PROJECT_TOKENS is unset — legacy single-token mode' };
  }

  const projects = Array.isArray(storeProjects)
    ? [...new Set(storeProjects.filter(Boolean))].sort()
    : [];

  const coveredSet = new Set(covered);
  // A store project with no token can no longer mutate. This is the failure the
  // check exists to make visible.
  const missing = projects.filter((p) => !coveredSet.has(p));
  const storeSet = new Set(projects);
  const extra = covered.filter((p) => !storeSet.has(p));

  if (missing.length === 0) {
    return {
      status: extra.length > 0 ? 'overcovered' : 'ok',
      covered, missing, extra,
      summary: extra.length > 0
        ? `${covered.length} projects covered; ${extra.length} in the map have no store file`
        : `${covered.length} projects covered, all store projects have a token`,
    };
  }
  return {
    status: 'undercovered', covered, missing, extra,
    summary: `${missing.length} of ${projects.length} store projects have NO token`,
  };
}

/**
 * Emits the boot report to the console. One line on success, a block on a
 * mismatch — never fatal. Returns the report so a caller can expose it.
 *
 * Supports signatures:
 *   reportCredentialCoverage(storeProjects, tokenInput, log)
 *   reportCredentialCoverage(storeProjects, tokenMap, parsed, log)  [legacy]
 */
export function reportCredentialCoverage(storeProjects, tokenInput = null, parsedOrLog = null, log = console) {
  let parsed = null;
  let logger = log;

  // Handle flexible signature: if 3rd arg is a logger object (has info/error/warn methods), treat it as logger.
  if (parsedOrLog && typeof parsedOrLog.info === 'function' && typeof parsedOrLog.error === 'function') {
    logger = parsedOrLog;
  } else if (parsedOrLog) {
    parsed = parsedOrLog;
  }

  const report = checkCredentialCoverage(storeProjects, tokenInput, parsed);
  if (report.status === 'ok') {
    logger.info(`[kanban auth] credential map: ${report.summary}`);
    return report;
  }
  if (report.status === 'unset') {
    logger.warn('[kanban auth] credential map: KANBAN_PROJECT_TOKENS is unset; ' +
                'per-project isolation is OFF (legacy single-token mode)');
    return report;
  }
  if (report.status === 'malformed') {
    // The auth middleware already refuses mutations in this state; repeat the
    // reason here so the cause is visible at boot, not only on first request.
    logger.error('[kanban auth] credential map: KANBAN_PROJECT_TOKENS is malformed JSON; ' +
                 'mutating API is fail-closed');
    return report;
  }
  if (report.status === 'undercovered') {
    logger.error(
      `[kanban auth] CREDENTIAL MAP INCOMPLETE: ${report.summary} — ` +
      `projects without a token can no longer authenticate: ${report.missing.join(', ')}. ` +
      `Check KANBAN_PROJECT_TOKENS for a truncated or partially-overwritten value ` +
      `(Railway keeps NO variable history; recover from a previous deployment's variables).`
    );
    return report;
  }
  // overcovered
  logger.warn(`[kanban auth] credential map: ${report.summary} — ` +
              `unused entries: ${report.extra.join(', ')}`);
  return report;
}
