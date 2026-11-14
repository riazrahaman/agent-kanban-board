/**
 * A5 (v3.12.2) — single-use session handshake challenges, stateless issuance.
 *
 * The HMAC session handshake requires a server-issued, short-TTL, single-use
 * challenge that the proof is bound to, so a captured proof cannot be replayed.
 * Issuance holds NO server state: the challenge is self-authenticating,
 *
 *   server_nonce = base64url( issuedAtMs (8 bytes BE) | random (16 bytes) | mac (32 bytes) )
 *   mac          = HMAC-SHA256( key, issuedAtMs | random ),  key = HMAC(secret, 'session-challenge-v1')
 *
 * so anonymous callers cannot exhaust anything by requesting challenges. At
 * POST /api/auth/session the MAC (constant-time) and TTL are verified; replay
 * protection is a consumed-nonce set that is written ONLY after a fully valid
 * proof (so unauthenticated traffic can never fill it), pruned by TTL and
 * bounded: if it were ever full, proofs are refused, issuance never is.
 *
 * Flow (required mode):
 *   POST /api/auth/challenge  -> { challenge, expires_at }
 *   POST /api/auth/session    { server_nonce: challenge, client_nonce, proof, role, project }
 *   proof = HMAC_SHA256(KANBAN_AUTH_SECRET, `${challenge}:${client_nonce}:${role}:${project}`)
 *
 * Default (v3.13.1+): 'required'. KANBAN_SESSION_NONCE_MODE=legacy is the
 * explicit opt-out that still accepts the old challenge-less proof.
 */
import crypto from 'node:crypto';
import { authSecret } from './sessionAuth.js';
import { tokensMatch } from './utils/constantTime.js';

const DEFAULT_CHALLENGE_TTL_MS = 120 * 1000;

/**
 * Challenges already used by a valid proof, grouped by ISSUE second (a
 * property of the nonce itself, so a replay always finds its own bucket):
 * bucket second -> Set of nonces. Consumption order need not match expiry
 * order (a newer challenge can be consumed before an older one), so expiry is
 * swept by bucket, never by insertion order.
 */
const consumed = new Map();
let consumedSize = 0;
/** Every bucket second below this has already been swept. */
let sweepCursorSec = 0;

/** Upper bound on replay-tracked nonces. A full set refuses proofs, never issuance. */
export const MAX_CONSUMED_SESSION_CHALLENGES = 100000;

export function sessionChallengeTtlMs() {
  const raw = process.env.KANBAN_SESSION_CHALLENGE_TTL_MS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CHALLENGE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CHALLENGE_TTL_MS;
}

/**
 * KANBAN_SESSION_NONCE_MODE: only the exact value 'legacy' opts out of the
 * challenge-bound proof. Anything else (unset, 'required', a typo) means
 * 'required' — a misspelt opt-out must fail closed.
 */
export function sessionNonceMode() {
  return process.env.KANBAN_SESSION_NONCE_MODE === 'legacy' ? 'legacy' : 'required';
}

/** Derived signing key; never the raw secret. */
function challengeKey() {
  const secret = authSecret();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update('session-challenge-v1').digest();
}

function macOf(key, body) {
  return crypto.createHmac('sha256', key).update(body).digest();
}

function dropBucket(sec) {
  const set = consumed.get(sec);
  if (!set) return;
  consumedSize -= set.size;
  consumed.delete(sec);
}

// Sweeps buckets whose whole second has passed. Walks the seconds elapsed since
// the last sweep, or the (few) existing buckets when that is fewer, so the cost
// is O(1) amortised and independent of consumption order.
function prune(now = Date.now()) {
  // A bucket (issue second s) is wholly expired once (s + 1) * 1000 + ttl <= now.
  const nowSec = Math.floor((now - sessionChallengeTtlMs()) / 1000);
  if (sweepCursorSec === 0) sweepCursorSec = nowSec;
  if (nowSec - sweepCursorSec > consumed.size) {
    for (const sec of consumed.keys()) if (sec < nowSec) dropBucket(sec);
  } else {
    for (let sec = sweepCursorSec; sec < nowSec; sec += 1) dropBucket(sec);
  }
  if (nowSec > sweepCursorSec) sweepCursorSec = nowSec;
}

/** Test helper: forget every consumed nonce. */
export function resetSessionChallenges() {
  consumed.clear();
  consumedSize = 0;
  sweepCursorSec = 0;
}

/** Number of replay-tracked (consumed, unexpired) nonces. Exists to test the bound. */
export function consumedSessionChallengeCount() {
  prune();
  return consumedSize;
}

/**
 * Issues a fresh stateless challenge. Returns null only when no signing secret
 * is configured. Holds no server state, so it cannot be exhausted.
 */
export function createSessionChallenge() {
  const key = challengeKey();
  if (!key) return null;
  const issuedAt = Date.now();
  const head = Buffer.alloc(24);
  head.writeBigUInt64BE(BigInt(issuedAt), 0);
  crypto.randomBytes(16).copy(head, 8);
  const challenge = Buffer.concat([head, macOf(key, head)]).toString('base64url');
  return { challenge, expiresAt: issuedAt + sessionChallengeTtlMs() };
}

/** Parses and authenticates a challenge. Returns { issuedAt } or null. No state touched. */
function openChallenge(challenge) {
  if (typeof challenge !== 'string' || challenge === '' || challenge.length > 128) return null;
  const key = challengeKey();
  if (!key) return null;
  const raw = Buffer.from(challenge, 'base64url');
  if (raw.length !== 56) return null;
  const head = raw.subarray(0, 24);
  if (!tokensMatch(raw.subarray(24).toString('hex'), macOf(key, head).toString('hex'))) return null;
  const issuedAt = Number(head.readBigUInt64BE(0));
  if (!Number.isSafeInteger(issuedAt)) return null;
  return { issuedAt };
}

/**
 * Consumes a challenge. Call ONLY after the proof over it has verified:
 * returns true when the MAC and TTL are valid and the nonce has not been used
 * before, and records it so the second use fails. Forged, expired, replayed
 * and malformed challenges are rejected; so is any proof when the replay set
 * is full (fail closed for proofs, never for issuance).
 */
export function consumeSessionChallenge(challenge) {
  const opened = openChallenge(challenge);
  if (!opened) return false;
  const now = Date.now();
  const exp = opened.issuedAt + sessionChallengeTtlMs();
  if (opened.issuedAt > now + 5000 || exp <= now) return false;
  prune(now);
  const sec = Math.floor(opened.issuedAt / 1000);
  // Duplicate check: a nonce lives only in the bucket of its own issue second.
  if (consumed.get(sec)?.has(challenge)) return false;
  if (consumedSize >= MAX_CONSUMED_SESSION_CHALLENGES) return false;
  let set = consumed.get(sec);
  if (!set) consumed.set(sec, (set = new Set()));
  set.add(challenge);
  consumedSize += 1;
  return true;
}
