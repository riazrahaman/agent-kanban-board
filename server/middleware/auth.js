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

export const VALID_ROLES = new Set([
  'builder',
  'reviewer',
  'tester',
  'runner',
  'system',
  'human',
  'admin',
]);

/**
 * Parses `KANBAN_PROJECT_TOKENS`, a JSON object mapping project id -> token:
 *   {"alpha":"tok-a","beta":"tok-b"}
 * A token may authorize several projects by appearing under each. Returns null
 * when unset/empty, which selects the legacy single-token path.
 *
 * Malformed JSON is a configuration failure and returns a sentinel rather than
 * silently falling back to the global token — quietly degrading to "one token
 * opens every project" is precisely the isolation failure this exists to stop.
 */
export function parseProjectTokens(raw = process.env.KANBAN_PROJECT_TOKENS) {
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
  const map = new Map();
  for (const [project, token] of Object.entries(parsed)) {
    if (typeof token !== 'string' || token === '') return { malformed: true };
    if (!isValidProjectId(project)) return { malformed: true };
    map.set(project, token);
  }
  if (map.size === 0) return { malformed: true };
  return { map };
}

function extractToken(req) {
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
 * Authorizes a read when read-auth is on: either a valid bearer token (session,
 * per-project, admin or global) or a single-use stream ticket in `?ticket=`.
 */
function authorizeRead(req) {
  const ticket = typeof req.query?.ticket === 'string' ? req.query.ticket : null;
  if (ticket) {
    const scope = verifyStreamTicket(ticket);
    if (scope) {
      req.caller = { ...req.caller, role: scope.role ?? req.caller.role };
      return true;
    }
  }
  const providedToken = extractToken(req);
  if (!providedToken) return false;
  if (verifySessionToken(providedToken)) return true;

  const projectTokens = parseProjectTokens();
  if (projectTokens?.map) {
    for (const token of projectTokens.map.values()) {
      if (tokensMatch(providedToken, token)) return true;
    }
  }
  const adminToken = process.env.KANBAN_ADMIN_TOKEN;
  if (adminToken && tokensMatch(providedToken, adminToken)) return true;
  const requiredToken = process.env.KANBAN_AUTH_TOKEN;
  if (requiredToken && tokensMatch(providedToken, requiredToken)) return true;
  return false;
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

    // Extract caller identity
    const agentId = req.headers['x-agent-id'] || req.body?.agent_id || null;
    const rawRole = req.headers['x-agent-role'] || req.body?.role || null;
    const role = typeof rawRole === 'string' ? rawRole.toLowerCase() : null;
    req.caller = { agent_id: agentId, role };

    const isMutation = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);
    if (!isMutation) {
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
      req.caller.privileged = isPrivilegedRole(session.role);
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
        for (const scope of scopes) {
          const expected = projectTokens.map.get(scope);
          if (!expected || !tokensMatch(providedToken, expected)) {
            logAuthFailure(req, 403, `token not valid for project '${scope}'`);
            recordAuthFailure(req);
            return res.status(403).json({
              error: `Forbidden: token is not authorized for project '${scope}'`,
            });
          }
        }
        // A per-project token is by-convention a worker credential: functional
        // roles (builder/reviewer/tester) stay assertable, privileged ops do not.
        req.caller.privileged = false;
      } else {
        req.caller.privileged = true;
        // Admin token spans every project — intended superuser behaviour, but
        // kept observable. Emit a distinct audit entry so admin usage is
        // distinguishable from ordinary per-project writes in the audit log.
        const scopesStr = scopes.length > 0 ? scopes.join(',') : defaultProjectName();
        console.warn(
          `[kanban auth] ADMIN write on ${req.method} ${req.originalUrl} ` +
          `(project: ${scopesStr}, agent: ${agentId || 'anonymous'}) role: admin`
        );
        emitAudit({
          ts: new Date().toISOString(),
          kind: 'admin_write',
          project: scopes.length > 0 ? scopes[0] : defaultProjectName(),
          task: null,
          actor: agentId || 'admin',
          reason: 'admin_token',
        });
      }
    } else if (!tokensMatch(providedToken, requiredToken)) {
      return unauthorized();
    }

    if (!role || !VALID_ROLES.has(role)) {
      logAuthFailure(req, 403, `invalid-role (role: ${role || 'missing'})`);
      recordAuthFailure(req);
      return res.status(403).json({
        error: 'A valid agent role is required for mutating operations',
      });
    }

    next();
  };
}
