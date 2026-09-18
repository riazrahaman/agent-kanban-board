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
import { isValidProjectId, defaultProjectName, emitAudit } from '../store.js';
import { authSecret, verifySessionToken } from '../sessionAuth.js';

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

/**
 * Constant-time-ish comparison. Token values here are short shared secrets, not
 * password hashes, but avoiding an early-exit compare costs nothing.
 */
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function createAuthMiddleware() {
  return (req, res, next) => {
    // Extract caller identity
    const agentId = req.headers['x-agent-id'] || req.body?.agent_id || null;
    const rawRole = req.headers['x-agent-role'] || req.body?.role || null;
    const role = typeof rawRole === 'string' ? rawRole.toLowerCase() : null;
    req.caller = { agent_id: agentId, role };

    const isMutation = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);
    if (!isMutation) {
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
      console.warn(
        `[kanban auth failure] 401 on ${req.method} ${req.originalUrl} (agent: ${agentId || 'anonymous'})`
      );
      return res.status(401).json({
        error: 'Unauthorized: valid token required for mutating operations',
      });
    };
    if (!providedToken) return unauthorized();

    // Session-token path. A valid HMAC session token carries its own role and
    // project; authenticate against those without consulting a server-side
    // session table. Falls through to the static-token paths below on failure,
    // so the legacy KANBAN_AUTH_TOKEN / KANBAN_PROJECT_TOKENS path is unchanged.
    const session = verifySessionToken(providedToken);
    if (session) {
      req.caller.role = session.role;
      const referenced = referencedProjects(req);
      const scopes = referenced.length > 0 ? referenced : [defaultProjectName()];
      for (const scope of scopes) {
        if (scope !== session.project) {
          console.warn(
            `[kanban auth failure] 403 on ${req.method} ${req.originalUrl}: ` +
            `session token not valid for project '${scope}' (agent: ${agentId || 'anonymous'})`
          );
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
      const adminToken = process.env.KANBAN_ADMIN_TOKEN;
      const isAdmin = adminToken ? tokensMatch(providedToken, adminToken) : false;

      if (!isAdmin) {
        for (const scope of scopes) {
          const expected = projectTokens.map.get(scope);
          if (!expected || !tokensMatch(providedToken, expected)) {
            console.warn(
              `[kanban auth failure] 403 on ${req.method} ${req.originalUrl}: ` +
              `token not valid for project '${scope}' (agent: ${agentId || 'anonymous'})`
            );
            return res.status(403).json({
              error: `Forbidden: token is not authorized for project '${scope}'`,
            });
          }
        }
      } else {
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
      console.warn(
        `[kanban auth failure] 403 on ${req.method} ${req.originalUrl} (role: ${role || 'missing'})`
      );
      return res.status(403).json({
        error: 'A valid agent role is required for mutating operations',
      });
    }

    next();
  };
}
