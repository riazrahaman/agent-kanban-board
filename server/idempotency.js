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
 *   - NAMESPACED per project + RESOLVED CREDENTIAL. Two callers using the same
 *     key must never replay each other's response, so the namespace is
 *     `project | sha256(extractToken(req))[0..16]`. `extractToken` is the
 *     middleware's canonical extractor, so `Authorization: Bearer <tok>` and
 *     `x-api-token: <tok>` are the same caller. Caller-declared `x-agent-id` /
 *     `x-agent-role` are deliberately NOT part of the namespace: they are
 *     spoofable and only ever split one caller's own retries into false 409s.
 *     The raw token is never retained; the digest is an isolation key, not a
 *     credential. If no credential is present (impossible on a mutation) each
 *     call gets a unique non-matching bucket - never a shared "anonymous" one.
 *   - BODY-BOUND. Each reservation records a hash of the create payload. The
 *     same key + credential with a DIFFERENT body is a client error
 *     (`idempotency_key_reuse`), never a silent replay of a card the caller
 *     did not ask for.
 *   - ONLY successful creations are recorded. A failed create releases the
 *     in-flight reservation so a corrected retry can proceed.
 *   - A duplicate that arrives while the first is still committing is not a
 *     replay (there is no body yet) and must not double-create: it gets
 *     `in_progress` and the route answers 409 with
 *     `idempotency_key_in_progress`.
 */

import { createHash, randomUUID } from 'node:crypto';
import { extractToken } from './middleware/auth.js';

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
 *   project | sha256(extractToken(req))[0..16]
 * The raw token is never retained and caller-declared agent/role headers are
 * ignored (spoofable, and they would only split one caller's own retries).
 * Mutations always present a credential; if one is somehow absent, a unique
 * per-call bucket is used so no two callers can ever share a replay slot.
 */
export function callerNamespace(req, project) {
  const token = extractToken(req);
  const fingerprint = token
    ? createHash('sha256').update(token).digest('hex').slice(0, 16)
    : `no-credential-${randomUUID()}`;
  return `${project || 'default'}|${fingerprint}`;
}

/** Deterministic JSON (sorted keys) so a retry with the same payload matches. */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Hash of the create payload, stored with the key to catch key reuse. */
export function hashCreateBody(body) {
  return createHash('sha256').update(stableStringify(body ?? {})).digest('hex');
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
 *   { state: 'new' }          - the caller owns the reservation and must
 *                               complete or release it;
 *   { state: 'replay', body } - a previously successful creation with the
 *                               SAME payload hash;
 *   { state: 'reuse' }        - the key was already used with a DIFFERENT
 *                               payload (409 idempotency_key_reuse);
 *   { state: 'in_progress' }  - an identical request is still committing.
 */
export function beginIdempotentCreate(namespace, key, { env = process.env, now = Date.now(), bodyHash } = {}) {
  const ttl = idempotencyTtlMs(env);
  const maxEntries = idempotencyMaxEntries(env);
  const composite = mapKey(namespace, key);

  const existing = entries.get(composite);
  if (existing) {
    if (now - existing.at > ttl) {
      entries.delete(composite);
    } else if (existing.bodyHash !== undefined && bodyHash !== undefined && existing.bodyHash !== bodyHash) {
      return { state: 'reuse' };
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

  entries.set(composite, { state: 'in_flight', at: now, bodyHash });
  return { state: 'new' };
}

/** Record the original 201 body for replay. */
export function completeIdempotentCreate(namespace, key, body, { now = Date.now(), bodyHash } = {}) {
  const composite = mapKey(namespace, key);
  const existing = entries.get(composite);
  entries.set(composite, {
    state: 'done',
    body: snapshot(body),
    at: now,
    bodyHash: bodyHash !== undefined ? bodyHash : existing?.bodyHash,
  });
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
