/**
 * §2.3c (ENH-01, v2.5.7) — short-lived stream tickets.
 *
 * `EventSource` cannot set request headers, so a browser cannot present the
 * ordinary `Authorization: Bearer <token>` to the SSE endpoint. Putting the
 * long-lived token in the query string would leak it into access logs, proxy
 * logs and browser history. Instead the client exchanges its token for a
 * single-use, 60-second ticket and presents THAT in the query string:
 *
 *   POST /api/auth/stream-ticket   (token-gated)  ->  { ticket, expires_at }
 *   GET  /api/events?ticket=<t>    (read-auth)    -> 200 text/event-stream
 *
 * Format: `<payload-base64url>.<mac-hex>` where
 *   payload = base64url(JSON.stringify({ jti, exp, role, project }))
 *   mac     = HMAC_SHA256(secret, payload) hex
 *
 * Single-use is enforced with a small in-memory issued-set: a ticket's `jti` is
 * recorded at mint time and deleted on first successful verification, so a
 * replayed or leaked ticket is inert. The client re-mints on every (re)connect.
 *
 * Signing key: `KANBAN_AUTH_SECRET` when set, else the global `KANBAN_AUTH_TOKEN`
 * — so tickets work in any read-auth deployment without forcing a new secret.
 */
import crypto from 'node:crypto';
import { authSecret } from './sessionAuth.js';

const TICKET_TTL_MS = 60 * 1000;

/** jti -> exp (epoch ms) for tickets that have been issued but not yet used. */
const issued = new Map();

export function streamTicketTtlMs() {
  return TICKET_TTL_MS;
}

/** Signing key: the session secret, or the global token as a fallback. */
function ticketSecret() {
  const secret = authSecret();
  if (secret) return secret;
  const token = process.env.KANBAN_AUTH_TOKEN;
  if (typeof token === 'string' && token !== '') return token;
  return null;
}

function macHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function prune(now = Date.now()) {
  for (const [jti, exp] of issued) {
    if (!Number.isInteger(exp) || exp <= now) issued.delete(jti);
  }
}

/** Test helper: forget every issued ticket. */
export function resetStreamTickets() {
  issued.clear();
}

/** Number of live (issued, unused) tickets. Exists to test the bound. */
export function liveStreamTicketCount() {
  prune();
  return issued.size;
}

/**
 * Mints a stream ticket bound to a role + project. Returns null when no signing
 * key is configured, so a deployment without any secret cannot hand out tickets.
 */
export function createStreamTicket({ role, project } = {}) {
  const secret = ticketSecret();
  if (!secret) return null;
  const jti = crypto.randomBytes(16).toString('hex');
  const exp = Date.now() + TICKET_TTL_MS;
  const payload = Buffer.from(
    JSON.stringify({ jti, exp, role: role ?? null, project: project ?? null }),
    'utf8'
  ).toString('base64url');
  const token = `${payload}.${macHex(secret, payload)}`;
  prune();
  issued.set(jti, exp);
  return { ticket: token, expiresAt: exp };
}

/**
 * Verifies and CONSUMES a stream ticket. Returns `{ role, project }` on success,
 * or null when the key is unset, the format is malformed, the MAC fails, the
 * ticket has expired, or it was never issued / has already been used.
 */
export function verifyStreamTicket(ticket) {
  const secret = ticketSecret();
  if (!secret || typeof ticket !== 'string') return null;

  const dot = ticket.indexOf('.');
  if (dot <= 0) return null;
  const payload = ticket.slice(0, dot);
  const mac = ticket.slice(dot + 1);

  if (!tokensMatch(mac, macHex(secret, payload))) return null;

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const { jti, exp, role, project } = parsed;
  if (!Number.isInteger(exp) || exp <= Date.now()) return null;
  if (typeof jti !== 'string' || !issued.has(jti)) return null;

  // Single-use: consume on first successful verification.
  issued.delete(jti);
  return { role, project };
}
