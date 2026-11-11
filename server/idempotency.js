/**
 * D3 (v3.12.6) - retry safety for `POST /api/tasks`.
 *
 * The create route is the one mutating endpoint where the caller supplies the
 * primary key: `id` is a natural idempotency handle, but a client that times
 * out waiting for the 201 cannot tell whether the card was committed, and a
 * blind retry is answered with 409 `already exists` - a false failure for an
 * operation that actually succeeded. An `Idempotency-Key` header makes the
 * retry return the ORIGINAL 201 body instead.
 *
 * Deliberate constraints:
 *   - IN-MEMORY ONLY. This is a single-process board; the map is bounded by
 *     TTL (default 10 min) and entry count (default 1000, oldest evicted).
 *   - NAMESPACED per project + caller identity. Two callers using the same key
 *     must never replay each other's response, so the namespace folds in a
 *     SHA-256 fingerprint of the Authorization header (never the raw token)
 *     plus the caller's agent id and role. The fingerprint is truncated: it is
 *     an isolation key, not a credential.
 *   - ONLY successful creations are recorded. A failed create releases the
 *     in-flight reservation so a corrected retry can proceed.
 *   - A duplicate that arrives while the first is still committing is not a
 *     replay (there is no body yet) and must not double-create: it gets
 *     `in_progress` and the route answers 409 with
 *     `idempotency_key_in_progress`.
 */

import { createHash } from 'node:crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;

/** Longest accepted header value. Longer is a client error, not a lookup. */
export const IDEMPOTENCY_MAX_KEY_LENGTH = 200;

// Map preserves insertion order, which is exactly the "oldest evicted first"
// policy. Values: { state: 'in_flight' | 'done', body?: object, at: number }.
const entries = new Map();

function positiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function idempotencyTtlMs(env = process.env) {
  return positiveInt(env.KANBAN_IDEMPOTENCY_TTL_MS, DEFAULT_TTL_MS);
}

export function idempotencyMaxEntries(env = process.env) {
  return positiveInt(env.KANBAN_IDEMPOTENCY_MAX_ENTRIES, DEFAULT_MAX_ENTRIES);
}

/**
 * Isolation namespace for one caller on one project:
 *   project | sha256(authorization)[0..16] | agent_id | role
 * The token itself is never retained; the digest only distinguishes callers.
 */
export function callerNamespace(req, project) {
  const authorization = req?.headers?.authorization || '';
  const fingerprint = authorization
    ? createHash('sha256').update(String(authorization)).digest('hex').slice(0, 16)
    : 'anonymous';
  const agentId = req?.caller?.agent_id || req?.headers?.['x-agent-id'] || '';
  const role = req?.caller?.role || req?.headers?.['x-agent-role'] || '';
  return `${project || 'default'}|${fingerprint}|${agentId}|${role}`;
}

function mapKey(namespace, key) {
  // NUL cannot appear in either component, so the join is unambiguous.
  return `${namespace}\u0000${key}`;
}

/** A stored replay body must not alias the live in-memory task. */
function snapshot(value) {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function pruneExpired(now, ttl) {
  for (const [mapKeyValue, entry] of entries) {
    if (now - entry.at > ttl) entries.delete(mapKeyValue);
  }
}

/**
 * Reserve a key before the create starts. Returns:
 *   { state: 'new' }         - the caller owns the reservation and must
 *                              complete or release it;
 *   { state: 'replay', body } - a previously successful creation;
 *   { state: 'in_progress' }  - an identical request is still committing.
 */
export function beginIdempotentCreate(namespace, key, { env = process.env, now = Date.now() } = {}) {
  const ttl = idempotencyTtlMs(env);
  const maxEntries = idempotencyMaxEntries(env);
  const composite = mapKey(namespace, key);

  const existing = entries.get(composite);
  if (existing) {
    if (now - existing.at > ttl) {
      entries.delete(composite);
    } else if (existing.state === 'in_flight') {
      return { state: 'in_progress' };
    } else {
      return { state: 'replay', body: snapshot(existing.body) };
    }
  }

  // Expired entries cost nothing to keep around until the cap is touched; drop
  // them first so a busy board does not evict a still-live reservation.
  pruneExpired(now, ttl);
  while (entries.size >= maxEntries) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }

  entries.set(composite, { state: 'in_flight', at: now });
  return { state: 'new' };
}

/** Record the original 201 body for replay. */
export function completeIdempotentCreate(namespace, key, body, { now = Date.now() } = {}) {
  entries.set(mapKey(namespace, key), { state: 'done', body: snapshot(body), at: now });
}

/** Release a reservation after a failed create (nothing is recorded). */
export function failIdempotentCreate(namespace, key) {
  entries.delete(mapKey(namespace, key));
}

/** Test seam: forget every reservation/replay entry. */
export function resetIdempotencyState() {
  entries.clear();
}

/** Test seam: how many entries are currently retained. */
export function idempotencyEntryCount() {
  return entries.size;
}
