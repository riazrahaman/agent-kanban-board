/**
 * Authentication middleware for Agent Kanban API (spec Sec 6.3 A07, KB-04).
 *
 * Protects every mutating endpoint with the configured shared token. A missing
 * token is a configuration failure, not permission to run an open write API.
 *
 * §2.3 adds optional per-project isolation. When `KANBAN_PROJECT_TOKENS` is
 * configured, a token only authorizes the project(s) it was issued for, so an
 * agent compromised in one project cannot mutate another project's board. With
 * no per-project config the behaviour is exactly as before: one global
 * `KANBAN_AUTH_TOKEN` for every project.
 */
import { referencedProjects } from './projectScope.js';
import { isValidProjectId, defaultProjectName, emitAudit, isPrivilegedRole } from '../store.js';
import { authSecret, verifySessionToken } from '../sessionAuth.js';
import { verifyStreamTicket } from '../streamTicket.js';
import { authFailuresExceeded, recordAuthFailure } from './rateLimit.js';
import { noteRolePresentation } from '../utils/roleCrossing.js';

export const VALID_ROLES = new Set([
  'planner',
  'builder',
  'reviewer',
  'tester',
  'validator',
  'releaser',
  'runner',
  'system',
  'human',
  'admin',
]);

/**
 * Parses `KANBAN_PROJECT_TOKENS`, a JSON object mapping project id -> credential.
 *
 * Accepted value shapes (v3.8.0 role binding; v3.12.8 identity binding):
 *   "tok-a"                                      → legacy unbound credential
 *   {"token":"tok-a"}                            → unbound credential
 *   {"token":"tok-b","role":"builder"}           → ROLE-BOUND credential: the
 *                                                  role is conferred by the
 *                                                  credential itself, never by
 *                                                  the caller-declared header.
 *   {"token":"tok-e","agent_id":"agent-7"}       → IDENTITY-BOUND credential:
 *                                                  the agent id is conferred by
 *                                                  the credential, never by
 *                                                  X-Agent-Id / body agent_id.
 *   {"token":"tok-f","role":"tester",
 *    "agent_id":"agent-9"}                       → both bindings at once
 *   {"credentials":[{"token":"tok-c","role":"reviewer"},
 *                   {"token":"tok-d","role":"tester","agent_id":"agent-2"}]}
 *                                                → several credentials per project
 *
 * `agent_id`, when present, is a non-empty string (trimmed) of at most 64
 * characters drawn from `[A-Za-z0-9._@:/-]` — the same printable-ASCII shape the
 * X-Agent-Id header has always carried, with the separators agent ids use in
 * practice (`build.agent@lane:3`, `agent/7`). Anything else is a configuration
 * failure, never a silently ignored field.
 *
 * A token may authorize several projects by appearing under each. Roles that
 * confer privilege (runner/system/human/admin) must never be bound to a shared
 * map credential — privileged access belongs to KANBAN_ADMIN_TOKEN or a
 * server-issued session, the same rule §2.3b (SEC-02) set for destructive ops.
 * A token bound to DIFFERENT roles under different projects is ambiguous at
 * resolution time (roles resolve per referenced project) and is rejected; the
 * same rule applies to `agent_id` — one token bound to two different agent ids
 * across projects would change identity with scope, so it is rejected. A token
 * bound in one project and unbound in another is fine and resolves by first
 * referenced project.
 *
 * Malformed JSON (or any invalid entry — empty token, unknown role, privileged
 * role, invalid agent_id, empty credentials array, a value carrying both
 * `token` and `credentials`, or one token bound to conflicting roles/agent ids
 * across projects) is a configuration failure and returns a sentinel rather
 * than silently falling back to the global token — quietly
 * degrading to "one token opens every project" is precisely the isolation
 * failure this exists to stop.
 */
export const AGENT_ID_MAX_LENGTH = 64;
/** Identity charset: ASCII letters/digits plus `. _ @ : / -`. */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9._@:/-]+$/;

/**
 * Validates a credential-bound agent id. Returns the trimmed value, or null
 * when the value is absent/invalid. Callers distinguish "absent" (undefined or
 * null) from "invalid" themselves — this helper only answers "is this a usable
 * identity".
 */
export function normalizeAgentId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > AGENT_ID_MAX_LENGTH) return null;
  if (!AGENT_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function parseProjectTokensUncached(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { malformed: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { malformed: true };
  }
  const normalizeCredential = (token, role, agentId) => {
    if (typeof token !== 'string' || token === '') return null;
    let normalizedRole = null;
    if (role !== undefined && role !== null) {
      if (typeof role !== 'string') return null;
      normalizedRole = role.toLowerCase();
      // Only functional roles may be bound to a credential. Privileged roles in
      // the map would let a leaked shared token become a superuser credential.
      if (!VALID_ROLES.has(normalizedRole) || isPrivilegedRole(normalizedRole)) return null;
    }
    // A7 (v3.12.8): optional credential-bound agent identity. Reject an
    // invalid value outright — a typo silently ignored here would leave the
    // deployment believing identity is bound when it is not.
    let boundAgentId = null;
    if (agentId !== undefined && agentId !== null) {
      boundAgentId = normalizeAgentId(agentId);
      if (!boundAgentId) return null;
    }
    const cred = { token, role: normalizedRole };
    if (boundAgentId) cred.agent_id = boundAgentId;
    return cred;
  };
  const map = new Map();
  for (const [project, value] of Object.entries(parsed)) {
    if (!isValidProjectId(project)) return { malformed: true };
    let creds;
    if (typeof value === 'string') {
      if (value === '') return { malformed: true };
      creds = [{ token: value, role: null }];
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof value.token === 'string' && Array.isArray(value.credentials)) {
        // A value carrying BOTH key shapes is two configurations in one — the
        // silent winner would be whichever branch ran first. Fail closed.
        return { malformed: true };
      }
      if (typeof value.token === 'string') {
        const cred = normalizeCredential(value.token, value.role, value.agent_id);
        if (!cred) return { malformed: true };
        creds = [cred];
      } else if (Array.isArray(value.credentials)) {
        if (value.credentials.length === 0) return { malformed: true };
        creds = [];
        for (const entry of value.credentials) {
          const cred = entry && typeof entry === 'object' && !Array.isArray(entry)
            ? normalizeCredential(entry.token, entry.role, entry.agent_id)
            : null;
          if (!cred) return { malformed: true };
          creds.push(cred);
        }
      } else {
        return { malformed: true };
      }
    } else {
      return { malformed: true };
    }
    // The same token twice under one project is ambiguous — which role wins?
    // Fail closed instead of guessing.
    const seen = new Set();
    for (const cred of creds) {
      if (seen.has(cred.token)) return { malformed: true };
      seen.add(cred.token);
    }
    map.set(project, creds);
  }
  if (map.size === 0) return { malformed: true };
  // (M2, review of 5d2d4bc) One token bound to DIFFERENT roles under different
  // projects: the effective role would depend on which referenced project a
  // request names — an identity that changes with scope is exactly the kind of
  // ambiguity this parser exists to reject. Bound-vs-unbound mixing stays
  // legal (the unbound side keeps legacy header semantics, documented).
  const boundRolesByToken = new Map();
  for (const creds of map.values()) {
    for (const cred of creds) {
      if (!cred.role) continue;
      const roles = boundRolesByToken.get(cred.token) || new Set();
      roles.add(cred.role);
      boundRolesByToken.set(cred.token, roles);
    }
  }
  for (const roles of boundRolesByToken.values()) {
    if (roles.size > 1) return { malformed: true };
  }
  // A7 (v3.12.8) — same rule for identity: one token bound to DIFFERENT agent
  // ids under different projects would let its identity depend on which
  // project the request names. Absent/unbound entries are skipped, exactly like
  // the role check above (bound-vs-unbound mixing stays legal).
  const boundAgentsByToken = new Map();
  for (const creds of map.values()) {
    for (const cred of creds) {
      if (!cred.agent_id) continue;
      const agents = boundAgentsByToken.get(cred.token) || new Set();
      agents.add(cred.agent_id);
      boundAgentsByToken.set(cred.token, agents);
    }
  }
  for (const agents of boundAgentsByToken.values()) {
    if (agents.size > 1) return { malformed: true };
  }
  return { map };
}

// B4 (v3.12.2): parseProjectTokens used to JSON.parse and re-validate the raw
// env string on EVERY call — per request on the hot paths (getAuthorizedProjects,
// the mutation guard, /api/health, the handshake). The result is memoized
// keyed on the RAW string, so a changed KANBAN_PROJECT_TOKENS (tests, config
// reload) invalidates the cache automatically via string inequality. The
// malformed sentinel is memoized too, preserving the exact error semantics.
let cachedRaw;
let cachedResult;

export function parseProjectTokens(raw = process.env.KANBAN_PROJECT_TOKENS) {
  if (raw === cachedRaw) return cachedResult;
  const result = parseProjectTokensUncached(raw);
  cachedRaw = raw;
  cachedResult = result;
  return result;
}

// D3 (v3.12.6 round 2): the idempotency namespace must key on the SAME
// credential the middleware accepted. Exporting the canonical extractor keeps
// `Authorization: Bearer <tok>` and `x-api-token: <tok>` one caller instead of
// two, and prevents every project-token caller collapsing into one bucket.
export function extractToken(req) {
  const authHeader = req.headers['authorization'];
  const apiTokenHeader = req.headers['x-api-token'];
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
  if (apiTokenHeader) return String(apiTokenHeader).trim();
  return null;
}

export { tokensMatch } from '../utils/constantTime.js';
import { tokensMatch } from '../utils/constantTime.js';

/**
 * Truthy `KANBAN_AUTH_LOG` enables redacted auth-failure logging. Unset/empty
 * (or the common "0"/"false") keeps the original silent behaviour.
 */
function authLogEnabled() {
  const flag = process.env.KANBAN_AUTH_LOG;
  if (flag === undefined || flag === '') return false;
  return flag !== '0' && flag.toLowerCase() !== 'false';
}

/**
 * Emits a REDACTED auth-failure line: method, path, caller agent_id, and the
 * reason — never the token, the Authorization header, or any secret bytes.
 */
function logAuthFailure(req, status, reason) {
  if (!authLogEnabled()) return;
  const agentId = req.caller?.agent_id || 'anonymous';
  console.warn(
    `[kanban auth failure] ${status} on ${req.method} ${req.originalUrl} ` +
    `(agent: ${agentId}) reason: ${reason}`
  );
}

/**
 * §2.3c (ENH-01) — optional read authentication.
 *
 * Reads (GET/SSE) are open by design: the board is a public-read observability
 * viewport. `KANBAN_READ_AUTH=token` closes that: every read must then present
 * either the usual bearer token OR a short-lived single-use stream ticket (the
 * latter exists because EventSource cannot set headers). Unset/empty/"off"/"0"/
 * "false" keeps reads open, so existing deployments are unaffected.
 */
export function readAuthEnabled(raw = process.env.KANBAN_READ_AUTH) {
  if (raw === undefined || raw === null) return false;
  const value = String(raw).trim().toLowerCase();
  if (value === '' || value === 'off' || value === '0' || value === 'false') return false;
  return true;
}

/**
 * Paths that must stay readable even when KANBAN_READ_AUTH=token: liveness
 * probes are consumed by the platform's healthcheck and by the client's version
 * chip, neither of which can hold a write token. The auth handshake router is
 * mounted before this middleware already.
 */
function isProbePath(req) {
  const p = req.path || '';
  return p === '/api/health' || p === '/healthz' ||
    p.startsWith('/api/health/') || p.startsWith('/healthz/');
}

/**
 * §2.11 — Returns authorized project scope for a caller:
 *   - '*' if caller presents admin token (KANBAN_ADMIN_TOKEN) or global board token (KANBAN_AUTH_TOKEN)
 *   - Set<string> of project names if caller presents a project-scoped token or session token
 *   - null if unauthenticated or invalid token
 */
export function getAuthorizedProjects(req) {
  // Deep-review: must be computed at most ONCE per request — the stream-ticket
  // path CONSUMES a single-use ticket on its first verification, so a second
  // call (e.g. middleware-stash + authorizeRead) would discard it.
  if (req._authorizedProjects !== undefined) return req._authorizedProjects;
  const computed = computeAuthorizedProjects(req);
  req._authorizedProjects = computed;
  return computed;
}

function computeAuthorizedProjects(req) {
  const ticket = typeof req.query?.ticket === 'string' ? req.query.ticket : null;
  if (ticket) {
    const scope = verifyStreamTicket(ticket);
    if (scope) {
      req.caller = { ...req.caller, role: scope.role ?? req.caller.role };
      if (scope.project) return new Set([scope.project]);
      return '*';
    }
  }

  const providedToken = extractToken(req);
  if (!providedToken) return null;

  const adminToken = process.env.KANBAN_ADMIN_TOKEN;
  if (adminToken && tokensMatch(providedToken, adminToken)) {
    return '*';
  }

  const session = verifySessionToken(providedToken);
  if (session) {
    if (session.role === 'admin') return '*';
    if (session.project) return new Set([session.project]);
    return new Set();
  }

  const projectTokens = parseProjectTokens();
  if (projectTokens?.map) {
    const authorized = new Set();
    for (const [project, creds] of projectTokens.map.entries()) {
      if (creds.some((cred) => tokensMatch(providedToken, cred.token))) {
        authorized.add(project);
      }
    }
    if (authorized.size > 0) return authorized;
  }

  const requiredToken = process.env.KANBAN_AUTH_TOKEN;
  if (requiredToken && tokensMatch(providedToken, requiredToken)) {
    return '*';
  }

  return null;
}

/**
 * Authorizes a read when read-auth is on: either a valid bearer token (session,
 * per-project, admin or global) or a single-use stream ticket in `?ticket=`.
 */
function authorizeRead(req) {
  return getAuthorizedProjects(req) !== null;
}

/**
 * §2.10 — does this request present a credential the board accepts?
 *
 * `isProbePath` deliberately exempts `/api/health` from read auth, so an
 * anonymous caller reaches that route even when `KANBAN_READ_AUTH=token` is on.
 * The route needs to tell an identified caller from an anonymous one on its own,
 * because the middleware has already waved it through: this is that check.
 *
 * It only *identifies*; it never rejects. A `false` result must not be treated
 * as an auth failure anywhere — callers use it to decide how much of a response
 * to disclose, not whether to serve one.
 *
 * Side effect matches the middleware's: on success `req.caller.role` may be
 * refined from a stream ticket. No failure is recorded, so calling this on a
 * probe path can never trip the auth-failure rate limiter.
 */
export function hasReadCredential(req) {
  return authorizeRead(req);
}

/** Upper bound on a caller-declared value echoed into a log/audit line. */
export const DECLARED_LABEL_MAX_LENGTH = 64;

/**
 * Renders a caller-declared value (agent id, role) for interpolation into a
 * console line and an audit `reason`. Control characters are removed first —
 * a newline or CR in `X-Agent-Id` / a body `agent_id` would otherwise let the
 * caller forge an extra log line (e.g. a fake `[kanban audit]` entry) — then the
 * value is capped at 64 characters, and backslashes/quotes are escaped so the
 * surrounding quoting cannot be broken. Never returns an empty string.
 */
export function sanitizeDeclaredLabel(value) {
  const raw = typeof value === 'string' ? value : '';
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, DECLARED_LABEL_MAX_LENGTH)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
  return cleaned === '' ? 'none' : cleaned;
}

/**
 * v3.8.0 — a caller-declared `X-Agent-Role` header disagreed with the role the
 * presented credential carries. The request is served with the CREDENTIAL's
 * role (the header cannot win), and the disagreement is made observable: one
 * redacted console line and a `role_binding_mismatch` audit entry. This is not
 * an auth failure — the caller proved identity — so it never touches the
 * failed-auth rate limiter.
 */
export function emitRoleBindingMismatch(req, declared, bound, scope) {
  const agentId = req.caller?.agent_id || 'anonymous';
  const declaredLabel = sanitizeDeclaredLabel(declared);
  console.warn(
    `[kanban auth] role_binding_mismatch on ${req.method} ${req.originalUrl} ` +
    `(project: ${scope || defaultProjectName()}, agent: ${agentId}) ` +
    `declared: '${declaredLabel}' — serving with credential-bound role '${bound}'`
  );
  emitAudit({
    ts: new Date().toISOString(),
    kind: 'role_binding_mismatch',
    project: scope || defaultProjectName(),
    task: null,
    actor: agentId,
    reason: `declared '${declaredLabel}' conflicts with credential-bound role '${bound}'`,
  });
}

/**
 * ADR-006 — one agent presented BOUND credentials for more than one role on
 * this project. The request is served normally: the signal is a REVIEW PROMPT,
 * not a violation, and the server cannot judge intent (an orchestrator, a CI
 * runner, or an agent doing planner+builder work all cross legitimately).
 *
 * Emitted only when `KANBAN_ROLE_CROSSING_AUDIT` is enabled — the default is
 * OFF, so a deployment that has not opted in behaves exactly as before.
 * Never an auth failure, so it never touches the failed-auth rate limiter.
 */
export function emitRoleCrossing(req, roles, scope) {
  const agentId = req.caller?.agent_id || 'anonymous';
  const roleList = Array.from(roles).sort().join(', ');
  console.warn(
    `[kanban auth] role_crossing on ${req.method} ${req.originalUrl} ` +
    `(project: ${scope || defaultProjectName()}, agent: ${agentId}) ` +
    `agent presented bound credentials for roles: ${roleList}`
  );
  emitAudit({
    ts: new Date().toISOString(),
    kind: 'role_crossing',
    project: scope || defaultProjectName(),
    task: null,
    actor: agentId,
    reason: `agent presented bound credentials for roles: ${roleList}`,
  });
}

/**
 * A7 (v3.12.8) — a caller-declared `X-Agent-Id` (or, for privileged callers, a
 * body `agent_id`) disagreed with the agent identity the presented credential
 * carries. Mirrors `role_binding_mismatch`: the request is SERVED with the
 * credential-bound identity (the declaration can never win), and the
 * disagreement becomes observable — one redacted console line plus an
 * `identity_binding_mismatch` audit entry. Never an auth failure, so it never
 * touches the failed-auth rate limiter. Never echoes a token value.
 */
export function emitIdentityBindingMismatch(req, declared, bound, scope, channel = 'header') {
  const scopeName = scope || defaultProjectName();
  // A caller can put ANYTHING in the declared channel (the header for an
  // unprivileged caller, header or body for a privileged one). Sanitize before
  // interpolation so a newline cannot forge a second log line and a >64-char
  // value cannot flood the audit reason. The bound id is credential-validated
  // but is rendered through the same helper for one consistent shape.
  const declaredLabel = sanitizeDeclaredLabel(declared);
  const boundLabel = sanitizeDeclaredLabel(bound);
  console.warn(
    `[kanban auth] identity_binding_mismatch on ${req.method} ${req.originalUrl} ` +
    `(project: ${scopeName}, agent: ${boundLabel}) ` +
    `declared ${channel}: '${declaredLabel}' — serving with credential-bound agent_id '${boundLabel}'`
  );
  emitAudit({
    ts: new Date().toISOString(),
    kind: 'identity_binding_mismatch',
    project: scopeName,
    task: null,
    actor: bound,
    reason: `declared ${channel} '${declaredLabel}' conflicts with credential-bound agent_id '${boundLabel}'`,
  });
}

/** The caller-declared X-Agent-Id header, trimmed, or null. Never the body. */
function declaredHeaderIdentity(req) {
  const value = req.headers?.['x-agent-id'];
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== 'string') return null;
  const trimmed = first.trim();
  return trimmed === '' ? null : trimmed;
}

/** A body-declared `agent_id`, trimmed, or null. Advisory only (see A7). */
function declaredBodyIdentity(req) {
  const value = req.body?.agent_id;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Resolves `req.caller.agent_id` / `req.caller.agentSource` from the credential
 * that proved the request and the identity the caller declared.
 *
 * A7 (v3.12.8) precedence:
 *   1. credential-bound agent_id (project credential or session) ALWAYS wins;
 *      a conflicting header/body declaration is audited, never honored.
 *   2. an UNBOUND credential keeps the documented legacy header semantics, but
 *      for a NON-privileged caller the body `agent_id` is no longer identity —
 *      that fallback was the spoofing path. Only X-Agent-Id is accepted.
 *   3. privileged callers (admin token / privileged session / legacy global
 *      token with a privileged header role) may still assert via header or body.
 *
 * `audit` is false on reads: binding is silent there so a misconfigured reader
 * cannot flood the audit log on every poll.
 */
function bindCallerIdentity(req, {
  boundAgentId = null,
  privileged = false,
  source = 'header',
  scope = null,
  audit = true,
} = {}) {
  const headerId = declaredHeaderIdentity(req);
  const bodyId = declaredBodyIdentity(req);

  if (boundAgentId) {
    if (audit && headerId && headerId !== boundAgentId) {
      emitIdentityBindingMismatch(req, headerId, boundAgentId, scope, 'header');
    }
    if (audit && bodyId && bodyId !== boundAgentId) {
      emitIdentityBindingMismatch(req, bodyId, boundAgentId, scope, 'body');
    }
    req.caller.agent_id = boundAgentId;
    req.caller.agentSource = source; // 'credential' | 'session'
    return boundAgentId;
  }

  if (privileged) {
    req.caller.agent_id = headerId ?? bodyId ?? null;
    req.caller.agentSource = source; // 'admin_token' | 'session' | 'header'
    return req.caller.agent_id;
  }

  // A7: the body is never identity for a non-privileged caller.
  req.caller.agent_id = headerId;
  req.caller.agentSource = headerId ? 'header' : null;
  return req.caller.agent_id;
}

/**
 * Read-path credential resolution, used only to bind identity. Mirrors the
 * middleware's precedence (admin, session, per-project, global). Returns null
 * when no token is presented (anonymous reads have no identity to bind).
 */
function resolveReadCredential(req) {
  const providedToken = extractToken(req);
  if (!providedToken) return null;

  const adminToken = process.env.KANBAN_ADMIN_TOKEN;
  if (adminToken && tokensMatch(providedToken, adminToken)) {
    return { boundAgentId: null, privileged: true, source: 'admin_token' };
  }
  const session = verifySessionToken(providedToken);
  if (session) {
    return {
      boundAgentId: session.agent_id || null,
      privileged: isPrivilegedRole(session.role),
      source: 'session',
    };
  }
  const projectTokens = parseProjectTokens();
  if (projectTokens?.map) {
    for (const creds of projectTokens.map.values()) {
      const match = creds.find((cred) => tokensMatch(providedToken, cred.token));
      if (match) {
        return {
          boundAgentId: match.agent_id || null,
          privileged: false,
          source: 'credential',
        };
      }
    }
  }
  return { boundAgentId: null, privileged: false, source: 'header' };
}

export function createAuthMiddleware() {
  return (req, res, next) => {
    // ENH-09: rate-limit failed auth attempts per client IP. Checked first so a
    // flood of bad tokens never reaches the token-comparison logic. Inert by
    // default (no env => authFailuresExceeded returns null).
    const retryAfter = authFailuresExceeded(req);
    if (retryAfter !== null) {
      recordAuthFailure(req);
      return res.status(429).json({
        error: 'Too many failed authentication attempts',
        retry_after_ms: retryAfter,
      });
    }

    // Extract the CALLER-DECLARED assertions only. They are advisory: a
    // credential-bound role/identity always overrides them, and a body role is
    // rejected downstream (v3.8.0 Phase 2). The provisional agent_id is
    // header-only so an anonymous/legacy failure log can never echo a body-
    // supplied spoof as if it were identity.
    const declaredAgentId = declaredHeaderIdentity(req);
    const rawRole = req.headers['x-agent-role'] || null;
    const role = typeof rawRole === 'string' ? rawRole.toLowerCase() : null;
    req.caller = { agent_id: declaredAgentId, role };

    const isMutation = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);
    if (!isMutation) {
      // Deep-review (auth P2): attach the caller's AUTHORIZED PROJECTS to every
      // read, not only when read-auth is on — item reads, metrics, milestones,
      // audit and SSE clamp against it. getAuthorizedProjects returns null for
      // anonymous/admin/global/unscoped credentials (reads stay open).
      req.caller.authorizedProjects = getAuthorizedProjects(req);
      // A7: identify the reader from the credential too (silently — a read has
      // no attribution consequence, and auditing every poll would flood).
      const readCred = resolveReadCredential(req);
      if (readCred) bindCallerIdentity(req, { ...readCred, audit: false });
      if (!readAuthEnabled() || isProbePath(req)) return next();
      if (!authorizeRead(req)) {
        logAuthFailure(req, 401, 'read-auth-required');
        recordAuthFailure(req);
        return res.status(401).json({
          error: 'Unauthorized: read access requires a valid token or stream ticket',
        });
      }
      return next();
    }

    const projectTokens = parseProjectTokens();
    if (projectTokens?.malformed) {
      console.error('[kanban auth] KANBAN_PROJECT_TOKENS is malformed; refusing mutation');
      return res.status(503).json({
        error: 'Mutating API is unavailable until KANBAN_PROJECT_TOKENS is valid JSON',
      });
    }

    const requiredToken = process.env.KANBAN_AUTH_TOKEN;
    const sessionEnabled = authSecret() !== null;
    if (!projectTokens && !requiredToken && !sessionEnabled) {
      console.error('[kanban auth] no auth mechanism is configured; refusing mutation');
      return res.status(503).json({
        error: 'Mutating API is unavailable until an auth token is configured',
      });
    }

    const providedToken = extractToken(req);
    const unauthorized = () => {
      logAuthFailure(req, 401, 'invalid-token');
      recordAuthFailure(req);
      return res.status(401).json({
        error: 'Unauthorized: valid token required for mutating operations',
      });
    };
    if (!providedToken) return unauthorized();

    /**
     * §2.3b (SEC-02, v2.5.2): the asserted `X-Agent-Role` is caller-declared and
     * must NEVER confer a destructive privilege on its own. Destructive
     * operations (task delete / purge) additionally require `caller.privileged`,
     * which is DERIVED from the credential that proved the request, not from
     * the header: the admin token, or a session token whose server-issued role
     * is privileged. When neither is configured the legacy single-token mode
     * keeps its historical semantics (any valid bearer token may claim admin),
     * so single-token deployments keep working; per-project deployments are the
     * configuration this hardening targets, and there project tokens never
     * confer privileged ops.
     */
    const adminToken = process.env.KANBAN_ADMIN_TOKEN;

    // Session-token path. A valid HMAC session token carries its own role and
    // project; authenticate against those without consulting a server-side
    // session table. Falls through to the static-token paths below on failure,
    // so the legacy KANBAN_AUTH_TOKEN / KANBAN_PROJECT_TOKENS path is unchanged.
    const session = verifySessionToken(providedToken);
    if (session) {
      req.caller.role = session.role;
      req.caller.roleSource = 'session';
      const sessionPrivileged = isPrivilegedRole(session.role);
      req.caller.privileged = sessionPrivileged;
      const referenced = referencedProjects(req);
      const scopes = referenced.length > 0 ? referenced : [defaultProjectName()];
      for (const scope of scopes) {
        if (scope !== session.project) {
          logAuthFailure(req, 403, `session-token not valid for project '${scope}'`);
          recordAuthFailure(req);
          return res.status(403).json({
            error: `Forbidden: token is not authorized for project '${scope}'`,
          });
        }
      }
      // A7: a session minted from an identity-bound credential carries that
      // identity; it outranks anything the caller declares now.
      bindCallerIdentity(req, {
        boundAgentId: session.agent_id || null,
        privileged: sessionPrivileged,
        source: 'session',
        scope: scopes[0],
      });
      return next();
    }

    if (projectTokens) {
      // §2.3 per-project isolation. Authorize against EVERY project the request
      // references, not one resolved "effective" value: the store lets a body
      // `project` outrank `?project=`, so checking a single channel would let a
      // token for project A create a task in project B.
      const referenced = referencedProjects(req);
      const scopes = referenced.length > 0 ? referenced : [defaultProjectName()];

      // An admin token, when configured, spans every project.
      const isAdmin = adminToken ? tokensMatch(providedToken, adminToken) : false;

      if (!isAdmin) {
        // First token match wins for binding resolution; v3.8.0 map values are
        // credential arrays, so the same token under two projects resolves its
        // role from the first referenced project — document in operator manual.
        let binding = null;
        let bindingScope = null;
        for (const scope of scopes) {
          const expected = projectTokens.map.get(scope);
          const matched = expected?.find((cred) => tokensMatch(providedToken, cred.token));
          if (!matched) {
            logAuthFailure(req, 403, `token not valid for project '${scope}'`);
            recordAuthFailure(req);
            return res.status(403).json({
              error: `Forbidden: token is not authorized for project '${scope}'`,
            });
          }
          if (!binding) {
            binding = matched;
            bindingScope = scope;
          }
        }
        // A per-project token is by-convention a worker credential: functional
        // roles (builder/reviewer/tester) stay assertable, privileged ops do not.
        req.caller.privileged = false;
        // A7 (v3.12.8): bind identity BEFORE the role-mismatch emission. Both
        // audits interpolate req.caller.agent_id as their actor, and identity
        // binding is what settles it — running it afterwards left the
        // role_binding_mismatch entry attributed to whatever the caller had
        // declared instead of the credential-bound id that actually served the
        // request. Identity binding is independent of role binding: a
        // credential may bind a role, an agent id, both, or neither.
        bindCallerIdentity(req, {
          boundAgentId: binding.agent_id || null,
          privileged: false,
          source: 'credential',
          scope: bindingScope,
        });
        if (binding.role) {
          // v3.8.0: the role comes from the credential. A conflicting header is
          // ignored and audited — it can neither escalate nor downgrade.
          if (role && role !== binding.role) {
            emitRoleBindingMismatch(req, role, binding.role, bindingScope);
          }
          req.caller.role = binding.role;
          req.caller.roleSource = 'credential';
          // ADR-006: note the bound role this agent presented. When the same
          // agent presents a DIFFERENT bound role on this project, the signal
          // fires — a review prompt, never a rejection. Disabled by default.
          // A7: prefer the credential-bound identity; the declared header is the
          // fallback for identity-unbound (legacy) credentials.
          const crossingAgentId = binding.agent_id || declaredAgentId;
          const crossing = noteRolePresentation(bindingScope, crossingAgentId, binding.role);
          if (crossing?.crossing) {
            emitRoleCrossing(req, crossing.roles, bindingScope);
          }
        } else if (role) {
          // Legacy unbound credential keeps the historical header semantics.
          req.caller.roleSource = 'header';
        }
      } else {
        req.caller.privileged = true;
        // v3.8.0: the admin token DERIVES its role from the credential — 'admin'
        // is what the credential says, never what the header asserts.
        if (role && role !== 'admin') {
          emitRoleBindingMismatch(req, role, 'admin', scopes[0] || undefined);
        }
        req.caller.role = 'admin';
        req.caller.roleSource = 'admin_token';
        // A7: privileged — may assert identity via header or body.
        const adminAgentId = bindCallerIdentity(req, {
          boundAgentId: null,
          privileged: true,
          source: 'admin_token',
          scope: scopes[0],
        });
        // Admin token spans every project — intended superuser behaviour, but
        // kept observable. Emit a distinct audit entry so admin usage is
        // distinguishable from ordinary per-project writes in the audit log.
        const scopesStr = scopes.length > 0 ? scopes.join(',') : defaultProjectName();
        console.warn(
          `[kanban auth] ADMIN write on ${req.method} ${req.originalUrl} ` +
          `(project: ${scopesStr}, agent: ${adminAgentId || 'anonymous'}) role: admin`
        );
        emitAudit({
          ts: new Date().toISOString(),
          kind: 'admin_write',
          project: scopes.length > 0 ? scopes[0] : defaultProjectName(),
          task: null,
          actor: adminAgentId || 'admin',
          reason: 'admin_token',
        });
      }
    } else if (!tokensMatch(providedToken, requiredToken)) {
      return unauthorized();
    } else {
      // Legacy single-token (KANBAN_AUTH_TOKEN) deployment: no credential map,
      // so identity stays caller-asserted. A privileged header role keeps the
      // historical body fallback; everyone else is header-only (A7).
      const referenced = referencedProjects(req);
      bindCallerIdentity(req, {
        boundAgentId: null,
        privileged: isPrivilegedRole(req.caller.role),
        source: 'header',
        scope: referenced[0],
      });
    }

    // Validate the RESOLVED role (credential-bound or header-declared), not the
    // raw declaration — a bound credential is valid even when the header is
    // absent or garbled, because the credential is the authority.
    const effectiveRole = req.caller.role;
    if (!effectiveRole || !VALID_ROLES.has(effectiveRole)) {
      logAuthFailure(req, 403, `invalid-role (role: ${effectiveRole || 'missing'})`);
      recordAuthFailure(req);
      return res.status(403).json({
        error: 'A valid agent role is required for mutating operations',
      });
    }

    next();
  };
}
