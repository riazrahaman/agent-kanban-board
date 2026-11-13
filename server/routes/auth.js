import crypto from 'node:crypto';
import { Router } from 'express';
import { authSecret, createSessionToken, verifySessionToken, revokeSessionToken } from '../sessionAuth.js';
import {
  createSessionChallenge,
  consumeSessionChallenge,
  sessionNonceMode,
} from '../sessionChallenge.js';
import { VALID_ROLES, parseProjectTokens, tokensMatch, emitRoleBindingMismatch, emitIdentityBindingMismatch } from '../middleware/auth.js';
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
    // Hardening: when per-project credentials are configured, the legacy global
    // token is not a source of privileged stream tickets.
    if (isPrivilegedRole(role) && cred.kind === 'global' && parseProjectTokens()?.map) {
      return res.status(403).json({
        error: `Role '${role}' is privileged — stream tickets for privileged roles require the admin token or a privileged session`,
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

  let boundAgentId = null;
  if (cred.kind === 'session') boundAgentId = cred.session.agent_id ?? null;
  else if (cred.kind === 'project') boundAgentId = cred.credential.agent_id ?? null;
  const minted = createStreamTicket({ role, project, agentId: boundAgentId });
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
 *
 * A5 (v3.12.2): this remains the LEGACY proof format (grace mode). The
 * challenge-bound format lives in `challengeProofInput` below — the signature
 * of `proofInput` is unchanged so existing callers and tests keep working.
 */
export function proofInput(clientNonce, role, project) {
  return `${clientNonce}:${role}:${project}`;
}

/**
 * A5 (v3.12.2) — the REQUIRED-mode proof input: the server-issued challenge is
 * bound first, `${challenge}:${clientNonce}:${role}:${project}`, so a captured
 * proof is only valid while its challenge is still live, and is single-use
 * (the challenge is consumed on first successful verification).
 */
export function challengeProofInput(serverNonce, clientNonce, role, project) {
  return `${serverNonce}:${clientNonce}:${role}:${project}`;
}

/**
 * POST /api/auth/challenge — A5 (v3.12.2), phase-0 of the handshake. The server
 * issues a random, short-TTL, single-use challenge the caller must bind into
 * its HMAC proof. In-memory only: a board restart forgets challenges, which is
 * safe (clients re-fetch one). Unauthenticated by design — the proof-of-secret
 * at /session is what authorizes minting; this endpoint only hands out nonce
 * material and is rate-limited like the rest of the handshake.
 */
router.post('/challenge', (req, res) => {
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

  const { challenge, expiresAt } = createSessionChallenge();
  return res.status(200).json({
    challenge,
    expires_at: expiresAt,
    // Surface the mode so a client can see whether the challenge is mandatory
    // yet (grace release) without a separate config endpoint.
    mode: sessionNonceMode(),
  });
});

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

  // A5 (v3.12.2): two-step handshake. When the caller presents a server_nonce
  // (the challenge from POST /api/auth/challenge), the proof must be bound to
  // it and the challenge is consumed single-use on success. In legacy grace
  // mode a challenge-less proof is still accepted over the historical
  // `clientNonce:role:project` input; in required mode it is rejected.
  const nonceMode = sessionNonceMode();
  const challenge =
    typeof body.server_nonce === 'string' && body.server_nonce !== '' ? body.server_nonce : null;

  if (nonceMode === 'required' && !challenge) {
    recordAuthFailure(req);
    return res.status(401).json({
      error:
        "Unauthorized: a fresh POST /api/auth/challenge nonce is required " +
        "(KANBAN_SESSION_NONCE_MODE='required')",
      nonce_mode: nonceMode,
    });
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(challenge
      ? challengeProofInput(challenge, clientNonce, role, project)
      : proofInput(clientNonce, role, project))
    .digest('hex');

  if (!tokensMatch(expected, proof.toLowerCase())) {
    recordAuthFailure(req);
    return res.status(401).json({ error: 'Unauthorized: invalid proof' });
  }

  // Single-use: consume the challenge on the FIRST successful verification, so
  // a replay of the same proof finds the challenge gone. Unknown/expired
  // challenges are rejected — a captured proof is inert.
  if (challenge && !consumeSessionChallenge(challenge)) {
    recordAuthFailure(req);
    return res.status(401).json({
      error: 'Unauthorized: challenge expired or already used',
      nonce_mode: nonceMode,
    });
  }

  const serverNonce = crypto.randomBytes(16).toString('hex');

  // A7 (v3.12.8): if the handshake caller ALSO presented a credential that
  // binds an agent identity, the minted session carries it. Identity is derived
  // from that resolved credential — never from `body.agent_id`, which is
  // caller-declared and would reintroduce the spoofing path inside the token.
  const handshakeCredential = resolveCredential(req);
  let boundAgentId = null;
  if (handshakeCredential?.kind === 'session') {
    boundAgentId = handshakeCredential.session.agent_id || null;
  } else if (handshakeCredential?.kind === 'project') {
    boundAgentId = handshakeCredential.credential.agent_id || null;
  }
  const declaredAgentId = typeof body.agent_id === 'string' ? body.agent_id.trim() : null;
  if (boundAgentId && declaredAgentId && declaredAgentId !== boundAgentId) {
    emitIdentityBindingMismatch(req, declaredAgentId, boundAgentId, project, 'body');
  }

  const { token, expiresAt } = createSessionToken({
    clientNonce,
    serverNonce,
    role,
    project,
    agentId: boundAgentId,
  });

  return res.status(200).json({
    token,
    server_nonce: serverNonce,
    expires_at: expiresAt,
    role,
    project,
    ...(boundAgentId ? { agent_id: boundAgentId } : {}),
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
