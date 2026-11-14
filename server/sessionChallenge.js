/**
 * A5 (v3.12.2) — single-use session handshake challenges.
 *
 * The HMAC session handshake used to accept a proof over a CLIENT-chosen nonce
 * with no freshness or single-use check, so a captured proof was replayable
 * for up to its (long) validity window. This module supplies the missing
 * server-side ingredient: a short-TTL, single-use challenge the server issues
 * and the proof must be bound to (and which is consumed on first successful
 * verification — a replay of the same proof finds the challenge gone).
 *
 * Flow (required mode):
 *   POST /api/auth/challenge  -> { challenge, expires_at }
 *   POST /api/auth/session    { server_nonce: challenge, client_nonce, proof, role, project }
 *   proof = HMAC_SHA256(KANBAN_AUTH_SECRET, `${challenge}:${client_nonce}:${role}:${project}`)
 *
 * Default (v3.13.1+): 'required' — a proof without a valid unconsumed
 * challenge is rejected. KANBAN_SESSION_NONCE_MODE=legacy is the explicit
 * opt-out that still accepts the old challenge-less proof for clients that
 * have not moved to the two-step flow; the server logs a warning at startup
 * while it is set.
 *
 * The issued-set mirrors streamTicket.js: challenge -> exp (epoch ms), pruned
 * opportunistically, with reset/count helpers so tests can assert the bound.
 */
import crypto from 'node:crypto';

const DEFAULT_CHALLENGE_TTL_MS = 120 * 1000;

/** challenge -> exp (epoch ms) for challenges that are live, unconsumed. */
const issued = new Map();

/**
 * Per-address cap on outstanding challenges: one address that floods the
 * endpoint evicts only its own oldest challenges, never other clients'.
 */
export const MAX_LIVE_CHALLENGES_PER_ADDRESS = 50;
/** challenge -> owner key, and owner key -> Set of its challenges (insertion order). */
const owners = new Map();
const byOwner = new Map();

function forget(challenge) {
  issued.delete(challenge);
  const owner = owners.get(challenge);
  if (owner === undefined) return;
  owners.delete(challenge);
  const set = byOwner.get(owner);
  if (set) {
    set.delete(challenge);
    if (set.size === 0) byOwner.delete(owner);
  }
}

export function sessionChallengeTtlMs() {
  const raw = process.env.KANBAN_SESSION_CHALLENGE_TTL_MS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CHALLENGE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CHALLENGE_TTL_MS;
}

/**
 * KANBAN_SESSION_NONCE_MODE: only the exact value 'legacy' opts out of the
 * challenge-bound proof. Anything else (unset, 'required', a typo) means
 * 'required' — a misspelt opt-out must fail closed, not silently reopen the
 * challenge-less path.
 */
export function sessionNonceMode() {
  return process.env.KANBAN_SESSION_NONCE_MODE === 'legacy' ? 'legacy' : 'required';
}

/** Upper bound on live (unexpired, unconsumed) challenges. */
export const MAX_LIVE_SESSION_CHALLENGES = 10000;

// Map iteration order is insertion order and the TTL is constant, so expiry
// times are non-decreasing: stop at the first live entry instead of scanning
// the whole map on every call.
function prune(now = Date.now()) {
  for (const [challenge, exp] of issued) {
    if (Number.isInteger(exp) && exp > now) break;
    forget(challenge);
  }
}

/** Test helper: forget every issued challenge. */
export function resetSessionChallenges() {
  issued.clear();
  owners.clear();
  byOwner.clear();
}

/** Number of live (issued, unconsumed) challenges. Exists to test the bound. */
export function liveSessionChallengeCount() {
  prune();
  return issued.size;
}

/**
 * Issues a fresh challenge nonce, evicting the oldest pending one when the live set is full. Server-side random (32 hex bytes), never
 * client-supplied, so a captured proof cannot be bound to an attacker nonce
 * retroactively.
 */
export function createSessionChallenge(address = null) {
  prune();
  const owner = typeof address === 'string' && address !== '' ? address : null;
  if (owner !== null) {
    const mine = byOwner.get(owner);
    if (mine && mine.size >= MAX_LIVE_CHALLENGES_PER_ADDRESS) {
      forget(mine.values().next().value);
    }
  }
  // Full: evict the oldest (O(1)). A real client consumes its challenge within
  // milliseconds, and refusing instead would let anonymous traffic block every
  // new handshake.
  if (issued.size >= MAX_LIVE_SESSION_CHALLENGES) {
    forget(issued.keys().next().value);
  }
  const challenge = crypto.randomBytes(32).toString('hex');
  const exp = Date.now() + sessionChallengeTtlMs();
  issued.set(challenge, exp);
  if (owner !== null) {
    owners.set(challenge, owner);
    let set = byOwner.get(owner);
    if (!set) byOwner.set(owner, (set = new Set()));
    set.add(challenge);
  }
  return { challenge, expiresAt: exp };
}

/**
 * Consumes a challenge: returns true only when it is live (issued, unexpired,
 * not yet used) — and deletes it, so the SECOND verification of the same
 * proof fails. Unknown, malformed and expired challenges are all rejected.
 */
export function consumeSessionChallenge(challenge) {
  if (typeof challenge !== 'string' || challenge === '') return false;
  if (!issued.has(challenge)) return false;
  const exp = issued.get(challenge);
  // Consume FIRST: a used challenge is inert even if it had not yet expired.
  forget(challenge);
  if (!Number.isInteger(exp) || exp <= Date.now()) return false;
  return true;
}
