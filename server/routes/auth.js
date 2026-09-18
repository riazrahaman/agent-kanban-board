import crypto from 'node:crypto';
import { Router } from 'express';
import { authSecret, createSessionToken } from '../sessionAuth.js';
import { VALID_ROLES } from '../middleware/auth.js';
import { isValidProjectId, defaultProjectName } from '../store.js';

const router = Router();

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
