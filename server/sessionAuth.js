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
 */
import crypto from 'node:crypto';

const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;

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
 * Constant-time comparison over two ASCII strings. Rejects on length mismatch
 * without leaking which index diverged.
 */
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
  const payload = b64url(
    JSON.stringify({ cn: clientNonce, sn: serverNonce, exp, role, project })
  );
  const mac = macHex(secret, payload);
  return { token: `${payload}.${mac}`, expiresAt: exp };
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

  const { exp, role, project } = parsed;
  if (!Number.isInteger(exp)) return null;
  if (exp <= Date.now()) return null;

  return { role, project };
}
