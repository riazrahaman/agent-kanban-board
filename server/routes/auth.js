import crypto from 'node:crypto';
import { Router } from 'express';
import { authSecret, createSessionToken, verifySessionToken, revokeSessionToken } from '../sessionAuth.js';
import {
  createSessionChallenge,
  consumeSessionChallenge,
  sessionNonceMode,
} from '../sessionChallenge.js';
import { VALID_ROLES, parseProjectTokens, tokensMatch, emitRoleBindingMismatch, emitIdentityBindingMismatch, isKnownCredential, authLogEnabled, resolveDetailAccess, chargeInvalidReadToken } from '../middleware/auth.js';
import {
  MASTER_PASSWORD_MAX_LENGTH,
  createUnlockToken,
  masterPasswordMatches,
  masterPasswordConfigured,
  recordUnlockFailure,
  requestUnlock,
  unlockFailureLimit,
  unlockUsesOverflow,
  unlockClientKey,
  unlockLockedOut,
  unlockRetryAfterMs,
} from '../masterUnlock.js';
import { isValidProjectId, defaultProjectName, isPrivilegedRole, emitAudit } from '../store.js';
import { createStreamTicket } from '../streamTicket.js';
import { authHardCapExceeded, rejectFailedAuth, sendAuthThrottled } from '../middleware/rateLimit.js';

const router = Router();

/** Stable, non-secret id for the presented credential: a truncated SHA-256, never the token. */
function credentialIdFor(req) {
  const t = extractToken(req);
  return t ? crypto.createHash('sha256').update(t).digest('hex').slice(0, 16) : null;
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
 * (session role, admin token, or the credential's bound role) — the asserted
 * role (`body.role`, else the `X-Agent-Role` header) is only honored by legacy
 * UNBOUND credentials, exactly matching the mutation
 * middleware. A privileged role can never be minted from a non-privileged
 * credential, mirroring §2.3b: per-project credentials never confer privileged
 * ops; the legacy global token keeps its historical superuser semantics.
 */
router.post('/stream-ticket', (req, res) => {
  // ENH-09: failed auth is throttled at the failure point (rejectFailedAuth), so
  // a valid credential is served even while its address is over budget. Past
  // the hard cap the address is refused outright until the window ends.
  const hardCapRetry = authHardCapExceeded(req);
  if (hardCapRetry !== null) return sendAuthThrottled(res, hardCapRetry);
  const cred = resolveCredential(req);
  if (!cred) {
    // Master password: an unlocked browser holds no board credential, only its
    // unlock token (X-Kanban-Unlock). It gets a MASTER ticket: no role, no
    // project, good for card details on one stream and nothing else. Checked
    // only after the credential path, so a real credential always wins.
    const unlock = requestUnlock(req);
    if (unlock) {
      const owner = unlock.jti
        ? `unlock:${crypto.createHash('sha256').update(unlock.jti).digest('hex').slice(0, 16)}`
        : 'unlock';
      const mintedMaster = createStreamTicket({ role: null, project: null, credentialId: owner, masterUntil: unlock.exp });
      if (mintedMaster?.refused) {
        res.set('Retry-After', String(Math.ceil(mintedMaster.retryAfterMs / 1000)));
        return res.status(429).json({ error: 'Too many outstanding stream tickets', retry_after_ms: mintedMaster.retryAfterMs });
      }
      return res.status(200).json({
        ticket: mintedMaster.ticket,
        expires_at: mintedMaster.expiresAt,
        role: null,
        project: null,
        scope: 'details',
      });
    }
    return rejectFailedAuth(req, res, 401, { error: 'Unauthorized: valid token required' });
  }

  const body = req.body ?? {};
  // The body role wins; the `X-Agent-Role` header (which every client mutation
  // already sends) is the fallback, so a client that only declares its role as a
  // header can still mint for an unbound credential. Either way it is only an
  // ASSERTION, subject to exactly the same checks below.
  const headerRole = req.get('x-agent-role');
  const assertedRole =
    typeof body.role === 'string' && body.role !== ''
      ? body.role
      : typeof headerRole === 'string' && headerRole.trim() !== ''
        ? headerRole.trim()
        : null;
  const rawRole = assertedRole ? assertedRole.toLowerCase() : null;

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
    // Only an explicit body role is reported as a mismatch (unchanged); the
    // header fallback exists for unbound credentials.
    const bodyRole = typeof body.role === 'string' && body.role !== '' ? body.role.toLowerCase() : null;
    if (bodyRole && bodyRole !== role) {
      emitRoleBindingMismatch(req, bodyRole, role, defaultProjectName());
    }
    // Privileged roles cannot be bound into the map, and sessions carry their
    // own privilege — this is a defensive guard, not the policy seam.
    if (isPrivilegedRole(role) && cred.kind === 'project') {
      return res.status(403).json({ error: `Role '${role}' is privileged and cannot be minted from this credential` });
    }
  } else {
    if (!rawRole || !VALID_ROLES.has(rawRole)) {
      // Not counted as an auth failure: the credential already verified, so this
      // is a malformed request, not a credential guess.
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

  // The ticket's scope must never exceed what the same credential reads as a
  // bearer (computeAuthorizedProjects in middleware/auth.js): an admin
  // session and the admin/global tokens read every project, a project token
  // reads exactly the projects it is listed under, any other session reads
  // its own project.
  const adminSession = cred.kind === 'session' && cred.session.role === 'admin';
  // A non-admin session with no project reads nothing as a bearer
  // (computeAuthorizedProjects returns an empty set), so it gets no ticket at
  // all, whatever project it names. /api/auth/session always stamps a
  // project, so only a session record minted some other way can reach this.
  if (cred.kind === 'session' && !adminSession && !cred.session.project) {
    return res.status(403).json({
      error: 'Forbidden: this session has no project, so it cannot mint a stream ticket',
    });
  }
  const rawProject = body.project;
  let project;
  let projects = null;
  if (typeof rawProject === 'string' && isValidProjectId(rawProject)) {
    project = rawProject;
  } else if (adminSession || cred.kind === 'admin' || cred.kind === 'global') {
    // Unscoped ('*') as bearers, so unscoped tickets (project null). The admin
    // role is checked BEFORE session.project: /api/auth/session always stamps
    // a project (the default one when none is named), and an admin session's
    // ticket used to stay pinned to it while the same session as a bearer
    // read every project.
    project = null;
  } else if (cred.kind === 'session') {
    // A non-admin session reads only its own project (a session without one
    // was refused above).
    project = cred.session.project;
  } else if (cred.kind === 'project' && cred.projects.length === 1) {
    project = cred.projects[0];
  } else if (cred.kind === 'project') {
    // A token listed under several projects, with none named (the browser's
    // "All projects" view): a ticket for exactly that set. Before, the mint
    // fell back to the default project and 403'd unless the token held it.
    project = null;
    projects = [...cred.projects];
  } else {
    project = defaultProjectName();
  }

  // Deep-review (auth P1): a stream ticket carries role AND project — so the
  // mint must be scope-checked, or a caller mints a ticket for a project its
  // credential cannot see and the enforced read gates are bypassed.
  if (cred.kind === 'project' && projects === null && !cred.projects.includes(project)) {
    return res.status(403).json({
      error: `Forbidden: token is not authorized for project '${project}'`,
    });
  }
  // Second guard behind the early return above: never a ticket for a
  // non-admin session without a project.
  if (cred.kind === 'session' && !adminSession && (!cred.session.project || project !== cred.session.project)) {
    return res.status(403).json({
      error: `Forbidden: token is not authorized for project '${project}'`,
    });
  }

  let boundAgentId = null;
  if (cred.kind === 'session') boundAgentId = cred.session.agent_id ?? null;
  else if (cred.kind === 'project') boundAgentId = cred.credential.agent_id ?? null;
  const minted = createStreamTicket({ role, project, projects, agentId: boundAgentId, credentialId: credentialIdFor(req) });
  if (minted?.refused) {
    res.set('Retry-After', String(Math.ceil(minted.retryAfterMs / 1000)));
    return res.status(429).json({ error: 'Too many outstanding stream tickets', retry_after_ms: minted.retryAfterMs });
  }
  return res.status(200).json({
    ticket: minted.ticket,
    expires_at: minted.expiresAt,
    role,
    project,
    ...(projects ? { projects: [...projects].sort() } : {}),
  });
});

/**
 * POST /api/auth/unlock — exchange the master password for an unlock token.
 *
 * This is also the header box's ONE classification call: the browser cannot
 * tell an API token from the master password by looking at it, so it asks, and
 * it stores only what the server recognises:
 *
 *   { unlocked: true, token, expires_at }   the master password
 *   { unlocked: false, credential: true }   a valid board credential (API token)
 *   { unlocked: false, credential: false }  neither: the browser stores nothing
 *
 * The last answer is the same whether the value was a wrong guess, a typo or
 * the feature is not configured at all, so the endpoint says nothing about the
 * configuration that an anonymous read does not already show.
 *
 * Throttling is its own per-address counter (see masterUnlock.js), checked
 * BEFORE any comparison, and it is a hard lockout: while an address is locked
 * out even the correct password is refused. Every unrecognised value counts;
 * a valid board credential does not. Nothing here touches the board's
 * failed-auth limiter, so typing into the box can never lock out an agent that
 * shares the address. `req.ip` is the key, so behind a reverse proxy
 * KANBAN_TRUST_PROXY must be set or every visitor shares one counter.
 *
 * The value travels only in the POST body and is never logged, audited or
 * echoed: failures are logged by address and count alone.
 */
function noteUnlockFailure(req, ip, count) {
  const limit = unlockFailureLimit();
  if (authLogEnabled()) {
    console.warn(`[kanban auth failure] unlock attempt not recognised (address: ${ip}, ${count} of ${limit} in window)`);
  }
  // Once per window, on the failure that uses up the allowance: the address
  // goes to the server console only; the audit entry (which board readers can
  // reach through the audit stream) carries none.
  if (count === limit) {
    const who = unlockUsesOverflow(ip) ? 'the shared overflow bucket' : `address ${ip}`;
    console.warn(
      `[kanban auth] unlock lockout for ${who}: ${count} unrecognised attempts in the current window; ` +
      'POST /api/auth/unlock answers 429 for it until the window ends'
    );
    emitAudit({
      ts: new Date().toISOString(),
      kind: 'unlock_lockout',
      project: defaultProjectName(),
      task: null,
      actor: 'system',
      reason: `unlock lockout (${count} unrecognised attempts in window)`,
    });
  }
}

router.post('/unlock', (req, res) => {
  const ip = unlockClientKey(req);
  res.set('Cache-Control', 'no-store');
  if (unlockLockedOut(ip)) {
    const ms = unlockRetryAfterMs(ip);
    res.set('Retry-After', String(Math.max(1, Math.ceil(ms / 1000))));
    return res.status(429).json({ error: 'too_many_attempts', retry_after_ms: ms });
  }
  const raw = req.body?.password;
  const provided = typeof raw === 'string' ? raw.trim() : '';
  if (provided === '' || provided.length > MASTER_PASSWORD_MAX_LENGTH) {
    return res.status(400).json({ error: 'password_required' });
  }
  if (masterPasswordMatches(provided)) {
    const minted = createUnlockToken();
    if (minted) {
      return res.status(200).json({ unlocked: true, token: minted.token, expires_at: minted.expiresAt });
    }
  }
  if (isKnownCredential(provided)) {
    return res.status(200).json({ unlocked: false, credential: true });
  }
  noteUnlockFailure(req, ip, recordUnlockFailure(ip));
  return res.status(200).json({ unlocked: false, credential: false });
});

/**
 * GET /api/auth/details — what THIS caller may read, as the server sees it.
 * The browser uses it so its lock indicator reflects the server's answer, not
 * what happens to be in localStorage (a stored unlock may have been revoked by
 * a password rotation, and an empty board has no tasks to infer it from).
 *
 *   details: true   card details are served to this caller
 *   unlock:  true   the X-Kanban-Unlock token it sent is valid right now
 *
 * It reveals nothing an anonymous GET /api/tasks does not (whether details are
 * withheld) and identifies only. But it does tell a valid token from an invalid
 * one, so on a board that gates reads (KANBAN_READ_AUTH=token) an invalid
 * bearer / x-api-token counts a failed-auth strike here exactly as on a read,
 * with the same 429 once the address is over budget (3.18.1). Anonymous callers
 * and a valid unlock are unaffected.
 */
router.get('/details', (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  if (chargeInvalidReadToken(req, res)) return undefined;
  res.vary('Authorization');
  res.vary('X-API-Token');
  res.vary('X-Kanban-Unlock');
  const unlock = masterPasswordConfigured() ? requestUnlock(req) : null;
  return res.status(200).json({
    details: resolveDetailAccess(req).access,
    unlock: unlock !== null,
    ...(unlock ? { expires_at: unlock.exp } : {}),
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
 * material; it is refused only past the failed-auth hard cap.
 */
router.post('/challenge', (req, res) => {
  // Pre-auth: no credential is presented here. Since the challenge became
  // mandatory for /session (A5), throttling it at the ordinary failed-auth
  // limit would block every valid session handshake from an address that a
  // single misconfigured client pushed over the limit. So it follows the same
  // rule as the credential-checked routes: refused only past the hard cap.
  // Guessing is still throttled where it happens (/session failures), and the
  // challenge itself is stateless (issuance holds no server state).
  const hardCapRetry = authHardCapExceeded(req);
  if (hardCapRetry !== null) return sendAuthThrottled(res, hardCapRetry);

  const secret = authSecret();
  if (!secret) {
    return res.status(503).json({
      error: 'Session auth is not enabled (KANBAN_AUTH_SECRET is unset)',
    });
  }

  const issuedChallenge = createSessionChallenge();
  const { challenge, expiresAt } = issuedChallenge;
  return res.status(200).json({
    challenge,
    expires_at: expiresAt,
    // Surface the mode ('required' by default; 'legacy' only when explicitly
    // opted out) so a client can tell without a separate config endpoint.
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
  // ENH-09: failed auth is throttled at the failure point (rejectFailedAuth): a
  // valid proof is served even while its address is over budget. Past the
  // hard cap the address is refused outright until the window ends.
  const hardCapRetry = authHardCapExceeded(req);
  if (hardCapRetry !== null) return sendAuthThrottled(res, hardCapRetry);

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
    return rejectFailedAuth(req, res, 403, { error: 'A valid agent role is required' });
  }

  const rawProject = body.project;
  const project =
    typeof rawProject === 'string' && isValidProjectId(rawProject)
      ? rawProject
      : defaultProjectName();

  // A5 (v3.12.2): two-step handshake. When the caller presents a server_nonce
  // (the challenge from POST /api/auth/challenge), the proof must be bound to
  // it and the challenge is consumed single-use on success. 'required' is the
  // default: a challenge-less proof is rejected. Only an explicit
  // KANBAN_SESSION_NONCE_MODE=legacy still accepts the historical
  // `clientNonce:role:project` input.
  const nonceMode = sessionNonceMode();
  const challenge =
    typeof body.server_nonce === 'string' && body.server_nonce !== '' ? body.server_nonce : null;

  if (nonceMode === 'required' && !challenge) {
    return rejectFailedAuth(req, res, 401, {
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
    return rejectFailedAuth(req, res, 401, { error: 'Unauthorized: invalid proof' });
  }

  // Single-use: consume the challenge on the FIRST successful verification, so
  // a replay of the same proof finds the challenge gone. Unknown/expired
  // challenges are rejected — a captured proof is inert.
  if (challenge && !consumeSessionChallenge(challenge)) {
    return rejectFailedAuth(req, res, 401, {
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
  // Throttled at the failure point, like /session and /stream-ticket. Past the
  // hard cap the address is refused outright until the window ends.
  const hardCapRetry = authHardCapExceeded(req);
  if (hardCapRetry !== null) return sendAuthThrottled(res, hardCapRetry);
  const provided = extractToken(req);
  if (!provided || !verifySessionToken(provided)) {
    return rejectFailedAuth(req, res, 401, { error: 'Unauthorized: a valid session token is required' });
  }

  const jti = revokeSessionToken(provided);
  if (!jti) {
    return res.status(400).json({ error: 'Token cannot be revoked (no jti — legacy token)' });
  }
  return res.status(200).json({ revoked: true, jti });
});

export default router;
