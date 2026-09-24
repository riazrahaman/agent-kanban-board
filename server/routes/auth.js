import crypto from 'node:crypto';
import { Router } from 'express';
import { authSecret, createSessionToken, verifySessionToken } from '../sessionAuth.js';
import { VALID_ROLES, parseProjectTokens } from '../middleware/auth.js';
import { isValidProjectId, defaultProjectName } from '../store.js';
import { createStreamTicket } from '../streamTicket.js';

const router = Router();

function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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
  if (hasValidCredential(req) !== true) {
    return res.status(401).json({ error: 'Unauthorized: valid token required' });
  }

  const body = req.body ?? {};
  const rawRole = body.role;
  const role = typeof rawRole === 'string' ? rawRole.toLowerCase() : null;
  if (!role || !VALID_ROLES.has(role)) {
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
 * POST /api/auth/session — phase-1 of the HMAC handshake. Gated by proof-of-
 * secret (the caller must HMAC their own nonce with KANBAN_AUTH_SECRET), not by
 * a pre-existing session token. Issues a stateless session token bound to the
 * caller's role + project.
 */
router.post('/session', (req, res) => {
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

  const expected = crypto
    .createHmac('sha256', secret)
    .update(clientNonce)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const proofBuf = Buffer.from(proof.toLowerCase(), 'hex');
  if (expectedBuf.length !== proofBuf.length) {
    return res.status(401).json({ error: 'Unauthorized: invalid proof' });
  }
  if (!crypto.timingSafeEqual(expectedBuf, proofBuf)) {
    return res.status(401).json({ error: 'Unauthorized: invalid proof' });
  }

  const rawRole = body.role;
  const role = typeof rawRole === 'string' ? rawRole.toLowerCase() : null;
  if (!role || !VALID_ROLES.has(role)) {
    return res.status(403).json({ error: 'A valid agent role is required' });
  }

  const rawProject = body.project;
  const project =
    typeof rawProject === 'string' && isValidProjectId(rawProject)
      ? rawProject
      : defaultProjectName();

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
