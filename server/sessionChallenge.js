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
 * Grace (this release): KANBAN_SESSION_NONCE_MODE defaults to 'legacy', which
 * still accepts the old challenge-less proof so existing clients keep working;
 * 'required' rejects proofs without a valid unconsumed challenge. 'required'
 * becomes the default in the next release (see CHANGELOG).
 *
 * The issued-set mirrors streamTicket.js: challenge -> exp (epoch ms), pruned
 * opportunistically, with reset/count helpers so tests can assert the bound.
 */
import crypto from 'node:crypto';

const DEFAULT_CHALLENGE_TTL_MS = 120 * 1000;

/** challenge -> exp (epoch ms) for challenges that are live, unconsumed. */
const issued = new Map();

export function sessionChallengeTtlMs() {
  const raw = process.env.KANBAN_SESSION_CHALLENGE_TTL_MS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CHALLENGE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CHALLENGE_TTL_MS;
}

/**
 * KANBAN_SESSION_NONCE_MODE: 'required' enforces the challenge-bound proof;
 * anything else (unset, 'legacy', junk) keeps the legacy grace behaviour. The
 * loose reading is deliberate — a typo must degrade to the compatible mode,
 * never lock clients out.
 */
export function sessionNonceMode() {
  return process.env.KANBAN_SESSION_NONCE_MODE === 'required' ? 'required' : 'legacy';
}

/** Upper bound on live (unexpired, unconsumed) challenges. */
export const MAX_LIVE_SESSION_CHALLENGES = 10000;

// Map iteration order is insertion order and the TTL is constant, so expiry
// times are non-decreasing: stop at the first live entry instead of scanning
// the whole map on every call.
function prune(now = Date.now()) {
  for (const [challenge, exp] of issued) {
    if (Number.isInteger(exp) && exp > now) break;
    issued.delete(challenge);
  }
}

/** Test helper: forget every issued challenge. */
export function resetSessionChallenges() {
  issued.clear();
}

/** Number of live (issued, unconsumed) challenges. Exists to test the bound. */
export function liveSessionChallengeCount() {
  prune();
  return issued.size;
}

/**
 * Issues a fresh challenge nonce, or returns null when the live set is full. Server-side random (32 hex bytes), never
 * client-supplied, so a captured proof cannot be bound to an attacker nonce
 * retroactively.
 */
export function createSessionChallenge() {
  prune();
  // Full: refuse rather than evict, so pending legitimate challenges survive.
  if (issued.size >= MAX_LIVE_SESSION_CHALLENGES) return null;
  const challenge = crypto.randomBytes(32).toString('hex');
  const exp = Date.now() + sessionChallengeTtlMs();
  issued.set(challenge, exp);
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
  issued.delete(challenge);
  if (!Number.isInteger(exp) || exp <= Date.now()) return false;
  return true;
}
