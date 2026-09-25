/**
 * HMAC session-token auth (variant B). Stateless two-phase handshake:
 *
 *   1. POST /api/auth/session  { client_nonce, proof }  ->  { token, ... }
 *   2. Authorization: Bearer <token>  ->  re-derived + constant-time checked.
 *
 * The token is self-describing so the server never keeps a session table:
 *
 *   <payload-base64url>.<mac-hex>
 *     payload  = base64url(JSON.stringify({ cn, sn, exp, role, project }))
 *     mac      = HMAC_SHA256(secret, payload) hex
 *
 * Verifying a presented token re-parses the payload to recover expiry + scope
 * (role/project), re-derives the MAC over the exact payload bytes, and compares
 * in constant time. Expiry is an integer epoch-ms compared against `Date.now()`.
 *
 * ENH-12 (v2.10.0) — revocation: the token carries a random `jti`, and a
 * process-local deny-list records revoked ids until their natural expiry. A
 * revoked token fails verification even though its MAC is still valid. This is
 * deliberately in-memory (same tradeoff as the SSE stream tickets): the board
 * runs a single long-lived Node process, so a restart clears the deny-list and
 * a restart already invalidates nothing else. Tokens issued before this change
 * have no `jti` and remain valid-but-irrevocable.
 */
import crypto from 'node:crypto';
import { tokensMatch } from './utils/constantTime.js';

const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** jti -> exp (epoch ms). Revoked session ids, pruned past their expiry. */
const revoked = new Map();

export function sessionExpiryMs() {
  return SESSION_EXPIRY_MS;
}

export function authSecret() {
  const secret = process.env.KANBAN_AUTH_SECRET;
  if (typeof secret !== 'string' || secret === '') return null;
  return secret;
}

function macHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function b64url(input) {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function b64urlDecode(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

/**
 * Issues a session token for the given caller scope. `client_nonce` and
 * `server_nonce` are non-secret strings that only need to be unique enough to
 * make the MAC inputs collision-resistant; the MAC is what carries integrity.
 */
export function createSessionToken({ clientNonce, serverNonce, role, project }) {
  const secret = authSecret();
  if (!secret) return null;
  const exp = Date.now() + SESSION_EXPIRY_MS;
  const jti = crypto.randomBytes(16).toString('hex');
  const payload = b64url(
    JSON.stringify({ cn: clientNonce, sn: serverNonce, jti, exp, role, project })
  );
  const mac = macHex(secret, payload);
  return { token: `${payload}.${mac}`, expiresAt: exp, jti };
}

/**
 * Verifies a self-describing session token. Returns the recovered scope on
 * success, or null when the secret is unset, the format is malformed, the MAC
 * does not match, or the token has expired.
 */
export function verifySessionToken(token) {
  const secret = authSecret();
  if (!secret || typeof token !== 'string') return null;

  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const expected = macHex(secret, payload);
  if (!tokensMatch(mac, expected)) return null;

  let parsed;
  try {
    parsed = JSON.parse(b64urlDecode(payload));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const { jti, exp, role, project } = parsed;
  if (!Number.isInteger(exp)) return null;
  if (exp <= Date.now()) return null;
  // ENH-12: a revoked jti fails even with a valid MAC. Tokens minted before
  // revocation existed carry no jti and stay valid (irrevocable, as before).
  if (typeof jti === 'string' && jti !== '' && revoked.has(jti)) {
    if (revoked.get(jti) <= Date.now()) revoked.delete(jti);
    else return null;
  }

  return { role, project, jti: typeof jti === 'string' ? jti : null };
}

/**
 * Revokes a session token so it fails verification until its natural expiry.
 * Returns the revoked `jti`, or null when the token is malformed / has no jti
 * (legacy token) / is already expired.
 */
export function revokeSessionToken(token) {
  const secret = authSecret();
  if (!secret || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(b64urlDecode(token.slice(0, dot)));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { jti, exp } = parsed;
  if (typeof jti !== 'string' || jti === '') return null;
  if (!Number.isInteger(exp) || exp <= Date.now()) return null;
  revoked.set(jti, exp);
  return jti;
}

/** Number of currently-tracked (unexpired) revoked session ids. */
export function revokedSessionCount() {
  const now = Date.now();
  for (const [jti, exp] of revoked) {
    if (!Number.isInteger(exp) || exp <= now) revoked.delete(jti);
  }
  return revoked.size;
}

/** Test helper: clear the deny-list. */
export function resetRevokedSessions() {
  revoked.clear();
}
