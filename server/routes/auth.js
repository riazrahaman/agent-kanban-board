import crypto from 'node:crypto';
import { Router } from 'express';
import { authSecret, createSessionToken, verifySessionToken } from '../sessionAuth.js';
import { VALID_ROLES, parseProjectTokens, tokensMatch } from '../middleware/auth.js';
import { isValidProjectId, defaultProjectName } from '../store.js';
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
 * token, the admin token, or the global token.
 */
function hasValidCredential(req) {
  const provided = extractToken(req);
  if (!provided) return null;
  if (verifySessionToken(provided)) return true;
  const projectTokens = parseProjectTokens();
  if (projectTokens?.map) {
    for (const token of projectTokens.map.values()) {
      if (tokensMatch(provided, token)) return true;
    }
  }
  const adminToken = process.env.KANBAN_ADMIN_TOKEN;
  if (adminToken && tokensMatch(provided, adminToken)) return true;
  const requiredToken = process.env.KANBAN_AUTH_TOKEN;
  if (requiredToken && tokensMatch(provided, requiredToken)) return true;
  return null;
}

/**
 * POST /api/auth/stream-ticket — exchange a bearer credential for a 60-second
 * single-use ticket. The SSE client appends `?ticket=<t>` because EventSource
 * cannot set request headers (and the long-lived token must not go in a URL).
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

  if (hasValidCredential(req) !== true) {
    recordAuthFailure(req);
    return res.status(401).json({ error: 'Unauthorized: valid token required' });
  }

  const body = req.body ?? {};
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

export default router;
