import crypto from 'node:crypto';
import { Router } from 'express';
import { authSecret, createSessionToken, verifySessionToken, revokeSessionToken } from '../sessionAuth.js';
import { VALID_ROLES, parseProjectTokens, tokensMatch, emitRoleBindingMismatch } from '../middleware/auth.js';
import { isValidProjectId, defaultProjectName, isPrivilegedRole } from '../store.js';
import { createStreamTicket } from '../streamTicket.js';
import { authFailuresExceeded, recordAuthFailure } from '../middleware/rateLimit.js';

const router = Router();

function extractToken(req) {
  const authHeader = req.headers['authorization'];
  const apiTokenHeader = req.headers['x-api-token'];
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
  if (apiTokenHeader) return String(apiTokenHeader).trim();
  return null;
}

/**
 * The mutation auth middleware runs AFTER this router (the handshake must be
 * reachable unauthenticated), so the ticket endpoint performs its own token
 * check. Any recognized credential is accepted: a session token, a per-project
 * credential, the admin token, or the global token.
 *
 * (M1, review of 5d2d4bc) The endpoint returns a CREDENTIAL DESCRIPTOR, not a
 * boolean, because v3.8.0 derives the ticket role from whatever the caller
 * proved, the same way the mutation middleware does — never from a caller-
 * asserted body role alone.
 */
function resolveCredential(req) {
  const provided = extractToken(req);
  if (!provided) return null;
  const session = verifySessionToken(provided);
  if (session) return { kind: 'session', session };
  const projectTokens = parseProjectTokens();
  if (projectTokens?.map) {
    // Map values are credential ARRAYS since role binding shipped (v3.8.0).
    // Deep-review (auth P1): a token valid under several projects may mint for
    // ANY of them; never find-first and let the caller name a different one.
    const matches = [];
    for (const [proj, creds] of projectTokens.map.entries()) {
      const match = creds.find((c) => tokensMatch(provided, c.token));
      if (match) matches.push({ project: proj, credential: match });
    }
    if (matches.length) {
      return { kind: 'project', credential: matches[0].credential, projects: matches.map((m) => m.project) };
    }
  }
  const adminToken = process.env.KANBAN_ADMIN_TOKEN;
  if (adminToken && tokensMatch(provided, adminToken)) return { kind: 'admin' };
  const requiredToken = process.env.KANBAN_AUTH_TOKEN;
  if (requiredToken && tokensMatch(provided, requiredToken)) return { kind: 'global' };
  return null;
}

/**
 * POST /api/auth/stream-ticket — exchange a bearer credential for a 60-second
 * single-use ticket. The SSE client appends `?ticket=<t>` because EventSource
 * cannot set request headers (and the long-lived token must not go in a URL).
 *
 * v3.8.0 (M1): for bound credentials the role is DERIVED from the credential
 * (session role, admin token, or the credential's bound role) — `body.role` is
 * only honored by legacy UNBOUND credentials, exactly matching the mutation
 * middleware. A privileged role can never be minted from a non-privileged
 * credential, mirroring §2.3b: per-project credentials never confer privileged
 * ops; the legacy global token keeps its historical superuser semantics.
 */
router.post('/stream-ticket', (req, res) => {
  // ENH-09: rate-limit failed auth (these routes run before the main middleware).
  const retryAfter = authFailuresExceeded(req);
  if (retryAfter !== null) {
    recordAuthFailure(req);
    return res.status(429).json({
      error: 'Too many failed authentication attempts',
      retry_after_ms: retryAfter,
    });
  }

  const cred = resolveCredential(req);
  if (!cred) {
    recordAuthFailure(req);
    return res.status(401).json({ error: 'Unauthorized: valid token required' });
  }

  const body = req.body ?? {};
  const rawRole = typeof body.role === 'string' ? body.role.toLowerCase() : null;

  // Derive the role the credential carries (M1): session role, admin token, or
  // the credential's bound role — body.role is only consulted for UNBOUND
  // credentials, exactly matching the mutation middleware.
  let role;
  let derived = true;
  if (cred.kind === 'session') {
    role = cred.session.role;
  } else if (cred.kind === 'admin') {
    role = 'admin';
  } else if (cred.kind === 'project' && cred.credential.role) {
    role = cred.credential.role;
  } else {
    // Legacy UNBOUND credential (per-project or global): the caller asserts its
    // role — validated below against VALID_ROLES.
    role = null;
    derived = false;
  }

  if (derived) {
    if (rawRole && rawRole !== role) {
      emitRoleBindingMismatch(req, rawRole, role, defaultProjectName());
    }
    // Privileged roles cannot be bound into the map, and sessions carry their
    // own privilege — this is a defensive guard, not the policy seam.
    if (isPrivilegedRole(role) && cred.kind === 'project') {
      return res.status(403).json({ error: `Role '${role}' is privileged and cannot be minted from this credential` });
    }
  } else {
    if (!rawRole || !VALID_ROLES.has(rawRole)) {
      recordAuthFailure(req);
      return res.status(403).json({ error: 'A valid agent role is required' });
    }
    role = rawRole;
    // SEC-02 alignment: a per-project credential is by-convention a worker
    // credential. It may mint tickets for its own functional role, never for a
    // privileged one. The legacy GLOBAL token keeps its historical semantics.
    if (isPrivilegedRole(role) && cred.kind === 'project') {
      return res.status(403).json({
        error: `Role '${role}' is privileged — stream tickets for privileged roles require the admin token, a privileged session, or the legacy global token`,
      });
    }
  }

  const rawProject = body.project;
  let project;
  if (typeof rawProject === 'string' && isValidProjectId(rawProject)) {
    project = rawProject;
  } else if (cred.kind === 'session') {
    project = cred.session.project ?? defaultProjectName();
  } else if (cred.kind === 'project' && cred.projects.length === 1) {
    project = cred.projects[0];
  } else {
    project = defaultProjectName();
  }

  // Deep-review (auth P1): a stream ticket carries role AND project — so the
  // mint must be scope-checked, or a caller mints a ticket for a project its
  // credential cannot see and the enforced read gates are bypassed.
  if (cred.kind === 'project' && !cred.projects.includes(project)) {
    return res.status(403).json({
      error: `Forbidden: token is not authorized for project '${project}'`,
    });
  }
  if (cred.kind === 'session' && cred.session.project && project !== cred.session.project) {
    return res.status(403).json({
      error: `Forbidden: token is not authorized for project '${project}'`,
    });
  }

  const minted = createStreamTicket({ role, project });
  if (!minted) {
    return res.status(503).json({ error: 'Stream tickets are unavailable (no signing secret configured)' });
  }
  return res.status(200).json({
    ticket: minted.ticket,
    expires_at: minted.expiresAt,
    role,
    project,
  });
});

/**
 * SEC-03 (v2.6.0) — the proof is now bound to the caller's asserted role and
 * project, not just the nonce. The input string `clientNonce:role:project`
 * means a proof minted for (builder, alpha) cannot be replayed to obtain an
 * (admin, alpha) or (builder, beta) session token. Exported so tests can build
 * the expected proof without duplicating the format.
 */
export function proofInput(clientNonce, role, project) {
  return `${clientNonce}:${role}:${project}`;
}

/**
 * POST /api/auth/session — phase-1 of the HMAC handshake. Gated by proof-of-
 * secret (the caller must HMAC their own nonce with KANBAN_AUTH_SECRET), not by
 * a pre-existing session token. Issues a stateless session token bound to the
 * caller's role + project.
 */
router.post('/session', (req, res) => {
  // ENH-09: rate-limit failed auth (these routes run before the main middleware).
  const retryAfter = authFailuresExceeded(req);
  if (retryAfter !== null) {
    recordAuthFailure(req);
    return res.status(429).json({
      error: 'Too many failed authentication attempts',
      retry_after_ms: retryAfter,
    });
  }

  const secret = authSecret();
  if (!secret) {
    return res.status(503).json({
      error: 'Session auth is not enabled (KANBAN_AUTH_SECRET is unset)',
    });
  }

  const body = req.body ?? {};
  const clientNonce = body.client_nonce;
  const proof = body.proof;

  if (typeof clientNonce !== 'string' || clientNonce === '') {
    return res.status(400).json({ error: 'client_nonce must be a non-empty string' });
  }
  if (typeof proof !== 'string' || proof === '') {
    return res.status(400).json({ error: 'proof must be a non-empty string' });
  }

  // SEC-03: validate role (403) and resolve project BEFORE the proof check so
  // the proof input is bound to a concrete role + project. A proof minted for
  // (builder, alpha) will not match (admin, alpha) and cannot be replayed to
  // escalate privileges.
  const rawRole = body.role;
  const role = typeof rawRole === 'string' ? rawRole.toLowerCase() : null;
  if (!role || !VALID_ROLES.has(role)) {
    recordAuthFailure(req);
    return res.status(403).json({ error: 'A valid agent role is required' });
  }

  const rawProject = body.project;
  const project =
    typeof rawProject === 'string' && isValidProjectId(rawProject)
      ? rawProject
      : defaultProjectName();

  const expected = crypto
    .createHmac('sha256', secret)
    .update(proofInput(clientNonce, role, project))
    .digest('hex');

  if (!tokensMatch(expected, proof.toLowerCase())) {
    recordAuthFailure(req);
    return res.status(401).json({ error: 'Unauthorized: invalid proof' });
  }

  const serverNonce = crypto.randomBytes(16).toString('hex');
  const { token, expiresAt } = createSessionToken({
    clientNonce,
    serverNonce,
    role,
    project,
  });

  return res.status(200).json({
    token,
    server_nonce: serverNonce,
    expires_at: expiresAt,
    role,
    project,
  });
});

/**
 * POST /api/auth/revoke — ENH-12 (v2.10.0). Voluntarily revoke a session token
 * before its natural expiry. The caller must present the very token they wish
 * to revoke (Bearer) — you can only kill a session you already hold, so this
 * endpoint cannot be used to disable someone else's credential.
 */
router.post('/revoke', (req, res) => {
  const retryAfter = authFailuresExceeded(req);
  if (retryAfter !== null) {
    recordAuthFailure(req);
    return res.status(429).json({
      error: 'Too many failed authentication attempts',
      retry_after_ms: retryAfter,
    });
  }

  const provided = extractToken(req);
  if (!provided || !verifySessionToken(provided)) {
    recordAuthFailure(req);
    return res.status(401).json({ error: 'Unauthorized: a valid session token is required' });
  }

  const jti = revokeSessionToken(provided);
  if (!jti) {
    return res.status(400).json({ error: 'Token cannot be revoked (no jti — legacy token)' });
  }
  return res.status(200).json({ revoked: true, jti });
});

export default router;
