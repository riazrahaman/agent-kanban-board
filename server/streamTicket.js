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
 * Signing key: `KANBAN_AUTH_SECRET` when set, else a random per-process key
 * (3.18.1). It is never the global `KANBAN_AUTH_TOKEN`: a project-token holder
 * can mint tickets, and a ticket MACed with the shared token would let them
 * test guesses of that token offline.
 */
import crypto from 'node:crypto';
import { authSecret } from './sessionAuth.js';
import { tokensMatch } from './utils/constantTime.js';

const TICKET_TTL_MS = 60 * 1000;

/** jti -> { exp (epoch ms), owner } for tickets that have been issued but not yet used. */
const issued = new Map();
/** credential id (truncated hash, never the token) -> number of outstanding tickets. */
const perOwner = new Map();

export function streamTicketTtlMs() {
  return TICKET_TTL_MS;
}

/**
 * Signing key: the session secret (`KANBAN_AUTH_SECRET`) when set, otherwise a
 * RANDOM PER-PROCESS key. Never a value a client holds or could guess: not the
 * shared `KANBAN_AUTH_TOKEN` (3.18.1; a project-token holder mints tickets, so
 * signing with the shared token handed them an offline oracle for it), not the
 * master password. Tickets live 60 seconds, are single-use and are tracked in
 * this process's memory anyway (the issued-set), so a ticket never verifies in
 * another process or after a restart whatever the key; losing the per-process
 * key on restart costs nothing (the client re-mints on every reconnect).
 */
let processTicketKey = null;

function ticketSecret() {
  const secret = authSecret();
  if (secret) return secret;
  if (processTicketKey === null) processTicketKey = crypto.randomBytes(32);
  return processTicketKey;
}

/** Test helper: drop the per-process fallback key (as a restart would). */
export function resetProcessTicketKey() {
  processTicketKey = null;
}

function macHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function drop(jti) {
  const entry = issued.get(jti);
  if (!entry) return;
  issued.delete(jti);
  const n = (perOwner.get(entry.owner) ?? 1) - 1;
  if (n <= 0) perOwner.delete(entry.owner);
  else perOwner.set(entry.owner, n);
}

// Map iteration order is insertion order and the TTL is constant, so expiry
// times are non-decreasing: sweep from the head and stop at the first live
// entry. Mint, redeem and expiry are all O(1) amortised.
function prune(now = Date.now()) {
  for (const [jti, entry] of issued) {
    if (Number.isInteger(entry.exp) && entry.exp > now) break;
    drop(jti);
  }
}

/** Upper bound on outstanding tickets. A full table refuses new mints. */
export const MAX_LIVE_STREAM_TICKETS = 10000;
/**
 * Upper bound on outstanding tickets per credential. Keyed by a stable,
 * non-secret credential id, so one credential cannot starve others (including
 * ones in the same project); the global bound still applies.
 */
export const MAX_LIVE_STREAM_TICKETS_PER_CREDENTIAL = 50;

/** Milliseconds until the oldest outstanding ticket expires (for Retry-After). */
export function streamTicketRetryAfterMs() {
  prune();
  const first = issued.values().next();
  if (first.done) return 1000;
  return Math.max(1000, first.value.exp - Date.now());
}

/** Test helper: forget every issued ticket. */
export function resetStreamTickets() {
  issued.clear();
  perOwner.clear();
}

/** Number of live (issued, unused) tickets. Exists to test the bound. */
export function liveStreamTicketCount() {
  prune();
  return issued.size;
}

/**
 * Mints a stream ticket bound to a role + project. A signing key is always
 * available (see ticketSecret); who may mint is decided by the route.
 */
export function createStreamTicket({ role, project, agentId = null, credentialId = null, masterUntil = null } = {}) {
  // ticketSecret() always yields a key (KANBAN_AUTH_SECRET or the per-process
  // fallback), so a mint never fails for want of one.
  const secret = ticketSecret();
  prune();
  // Never evict a live ticket: a credential at its own cap, or a full table,
  // refuses the mint instead (the caller answers 429 + Retry-After). Callers
  // without a credential id share the '*' bucket.
  const owner = typeof credentialId === 'string' && credentialId !== '' ? credentialId : '*';
  if ((perOwner.get(owner) ?? 0) >= MAX_LIVE_STREAM_TICKETS_PER_CREDENTIAL || issued.size >= MAX_LIVE_STREAM_TICKETS) {
    return { refused: true, retryAfterMs: streamTicketRetryAfterMs() };
  }
  const jti = crypto.randomBytes(16).toString('hex');
  const exp = Date.now() + TICKET_TTL_MS;
  const claims = { typ: 'stream', jti, exp, role: role ?? null, project: project ?? null };
  if (typeof agentId === 'string' && agentId !== '') claims.agent_id = agentId;
  // A MASTER ticket (minted from an unlock token, not a board credential): it
  // carries no role or project, only the instant the unlock itself expires.
  if (Number.isInteger(masterUntil)) claims.master_until = masterUntil;
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const token = `${payload}.${macHex(secret, payload)}`;
  issued.set(jti, { exp, owner });
  perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
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

  const { typ, jti, exp, role, project, agent_id: agentId, master_until: masterUntil } = parsed;
  if (typ !== 'stream') return null;
  if (!Number.isInteger(exp) || exp <= Date.now()) return null;
  if (typeof jti !== 'string' || !issued.has(jti)) return null;

  // Single-use: consume on first successful verification.
  drop(jti);
  return {
    role,
    project,
    agent_id: typeof agentId === 'string' && agentId !== '' ? agentId : null,
    // Present only on a master ticket: details-only, never a board credential.
    master_until: Number.isInteger(masterUntil) ? masterUntil : null,
  };
}
