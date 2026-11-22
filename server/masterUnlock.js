/**
 * Master password: an optional, read-only "unlock" for card details.
 *
 * The board is a public-read viewport: anyone can see the columns, the card
 * titles, badges, assignees and counts. When `KANBAN_MASTER_PASSWORD` is set,
 * the long-form content of a card (description, agent log, comments, metadata,
 * spilled logs) is additionally withheld from a caller that presents neither a
 * board credential (project/shared/admin token, session, stream ticket) nor
 * this unlock. Unset, nothing here changes any response.
 *
 * How a browser proves it knows the password:
 *
 *   POST /api/auth/unlock { password }      -> { unlocked: true, token, expires_at }
 *   X-Kanban-Unlock: <token>                on every read (never in a URL)
 *   POST /api/auth/stream-ticket            (with the header) -> single-use SSE ticket
 *
 * The raw password crosses the wire once, in a POST body, and is exchanged for
 * a short-lived, HMAC-signed unlock token; the browser keeps only that token.
 *
 * Token format: `<payload-base64url>.<mac-hex>`,
 *   payload = base64url(JSON.stringify({ typ: 'unlock', jti, exp }))
 *   mac     = HMAC_SHA256(key, payload) hex
 * The key is DERIVED from the password (domain-separated, mixed with
 * `KANBAN_AUTH_SECRET` when one is set), so tokens survive a restart and every
 * outstanding unlock dies the moment the password is rotated. No session table.
 *
 * What the unlock grants: READ of card details, plus exactly one write - saving
 * column colours through `PUT /api/settings` (see middleware/auth.js). It is
 * never a board credential: it carries no role, no project scope and no agent
 * identity, so it cannot claim, patch, log, delete, purge or administer.
 *
 * Never logged, never echoed: the password, the unlock token and the derived
 * key appear in no log line, audit entry, URL or error body.
 */
import crypto from 'node:crypto';
import { authSecret } from './sessionAuth.js';
import { tokensMatch } from './utils/constantTime.js';
import { addressOwnerKey } from './utils/addressKey.js';

/** Shortest master password the server will start with. */
export const MASTER_PASSWORD_MIN_LENGTH = 12;
/** Longest value the unlock endpoint will even compare. */
export const MASTER_PASSWORD_MAX_LENGTH = 1024;
/** Lifetime of one unlock (the browser must re-enter the password after it). */
export const UNLOCK_TTL_MS = 12 * 60 * 60 * 1000;
/** Request header that carries the unlock token. Lower-case, as Node reports it. */
export const UNLOCK_HEADER = 'x-kanban-unlock';
/** Failed unlock attempts allowed per address per window before a lockout. */
export const DEFAULT_UNLOCK_FAILURES_PER_WINDOW = 10;
export const UNLOCK_FAILURE_WINDOW_MS = 60 * 1000;
export const MAX_UNLOCK_FAILURE_ENTRIES = 10000;
const OVERFLOW_KEY = '\u0000overflow';

/** The configured master password (trimmed), or '' when the feature is off. */
export function masterPassword() {
  const raw = process.env.KANBAN_MASTER_PASSWORD;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** True when a master password is set: card details are then gated. */
export function masterPasswordConfigured() {
  return masterPassword() !== '';
}

/**
 * A password shorter than the minimum is a configuration error: the server
 * refuses to start with one (`startupAuthErrors`). An app built without that
 * check (tests, an embedder) fails CLOSED: details stay gated and no value can
 * ever unlock them.
 */
function masterPasswordUsable() {
  return masterPassword().length >= MASTER_PASSWORD_MIN_LENGTH;
}

let cachedKeyInput = null;
let cachedKey = null;

/** HMAC key for unlock tokens, derived from the password; null when unusable. */
export function masterUnlockKey() {
  if (!masterPasswordUsable()) return null;
  const input = `${masterPassword()}\u0000${authSecret() ?? ''}`;
  if (input !== cachedKeyInput) {
    cachedKey = crypto
      .createHmac('sha256', masterPassword())
      .update(`kanban-master-unlock-v1\u0000${authSecret() ?? ''}`)
      .digest();
    cachedKeyInput = input;
  }
  return cachedKey;
}

function macHex(key, payload) {
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

/** Constant-time check of a presented value against the master password. */
export function masterPasswordMatches(provided) {
  if (!masterPasswordUsable()) return false;
  if (typeof provided !== 'string' || provided === '') return false;
  if (provided.length > MASTER_PASSWORD_MAX_LENGTH) return false;
  return tokensMatch(provided, masterPassword());
}

/** Mints an unlock token. Returns null when no usable password is configured. */
export function createUnlockToken(now = Date.now()) {
  const key = masterUnlockKey();
  if (!key) return null;
  const jti = crypto.randomBytes(16).toString('hex');
  const exp = now + UNLOCK_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ typ: 'unlock', jti, exp }), 'utf8').toString('base64url');
  return { token: `${payload}.${macHex(key, payload)}`, expiresAt: exp, jti };
}

/**
 * Verifies an unlock token. Returns `{ exp, jti }`, or null when the feature is
 * off, the format is wrong, the MAC fails or the token has expired.
 */
export function verifyUnlockToken(token, now = Date.now()) {
  const key = masterUnlockKey();
  if (!key || typeof token !== 'string' || token === '' || token.length > 512) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!tokensMatch(token.slice(dot + 1), macHex(key, payload))) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.typ !== 'unlock') return null;
  if (!Number.isInteger(parsed.exp) || parsed.exp <= now) return null;
  return { exp: parsed.exp, jti: typeof parsed.jti === 'string' ? parsed.jti : null };
}

/**
 * The unlock a request carries, memoised per request: `{ exp }` or null.
 * Sources: the `X-Kanban-Unlock` header, or a master stream ticket that the
 * auth layer already consumed for `/api/events` (stashed as `_masterTicket`).
 */
export function requestUnlock(req) {
  if (req._masterUnlock !== undefined) return req._masterUnlock;
  let unlock = null;
  const raw = req.headers?.[UNLOCK_HEADER];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header === 'string' && header.trim() !== '') {
    unlock = verifyUnlockToken(header.trim());
  }
  if (!unlock && req._masterTicket && Number.isInteger(req._masterTicket.exp)) {
    if (req._masterTicket.exp > Date.now()) unlock = { exp: req._masterTicket.exp, jti: null };
  }
  req._masterUnlock = unlock;
  return unlock;
}

// ---------------------------------------------------------------------------
// Failed-attempt lockout for POST /api/auth/unlock. Modelled on the Ask
// password's: a fixed 60s window per client address (IPv6 by /64), refused
// BEFORE any comparison once the limit is passed, bounded memory with a shared
// overflow counter. Deliberately its OWN table: a wrong guess here never adds
// to the board's failed-auth bucket, so it can never lock out an agent that
// shares the address, and an agent's 401s never lock the owner out of here.
// ---------------------------------------------------------------------------
const unlockFailures = new Map(); // address key -> { count, windowStartMs }

export function resetUnlockFailures() {
  unlockFailures.clear();
}

export function unlockFailureLimit() {
  const raw = process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN;
  if (raw === undefined || raw === '') return DEFAULT_UNLOCK_FAILURES_PER_WINDOW;
  const n = Number(raw);
  // 0 switches the board's failed-auth limiter off; a password gate keeps one.
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_UNLOCK_FAILURES_PER_WINDOW;
}

export function unlockClientKey(req) {
  const raw = req.ip || req.socket?.remoteAddress || 'unknown';
  return addressOwnerKey(raw) ?? raw;
}

function failureKey(ip, now, sweep) {
  if (unlockFailures.has(ip)) return ip;
  const tracked = () => unlockFailures.size - (unlockFailures.has(OVERFLOW_KEY) ? 1 : 0);
  if (sweep && tracked() >= MAX_UNLOCK_FAILURE_ENTRIES) {
    for (const [k, r] of unlockFailures) {
      if (now - r.windowStartMs < UNLOCK_FAILURE_WINDOW_MS) break;
      unlockFailures.delete(k);
    }
  }
  return tracked() < MAX_UNLOCK_FAILURE_ENTRIES ? ip : OVERFLOW_KEY;
}

/** Records one failed attempt; returns the count in the live window. */
export function recordUnlockFailure(ip, now = Date.now()) {
  const key = failureKey(ip, now, true);
  const rec = unlockFailures.get(key);
  if (!rec || now - rec.windowStartMs >= UNLOCK_FAILURE_WINDOW_MS) {
    unlockFailures.delete(key); // re-insert: the map stays ordered by window start
    unlockFailures.set(key, { count: 1, windowStartMs: now });
    return 1;
  }
  rec.count += 1;
  return rec.count;
}

/** True while this address has used up its failed attempts for the window. */
export function unlockLockedOut(ip, now = Date.now()) {
  const rec = unlockFailures.get(ip);
  if (!rec) return false;
  if (now - rec.windowStartMs >= UNLOCK_FAILURE_WINDOW_MS) return false;
  return rec.count >= unlockFailureLimit();
}

export function unlockRetryAfterMs(ip, now = Date.now()) {
  const rec = unlockFailures.get(failureKey(ip, now, false));
  if (!rec) return UNLOCK_FAILURE_WINDOW_MS;
  return Math.max(0, rec.windowStartMs + UNLOCK_FAILURE_WINDOW_MS - now);
}

// ---------------------------------------------------------------------------
// Redaction. An ALLOW-list, so a long-form field added to the task shape later
// is withheld by default instead of leaking until someone remembers this file.
// ---------------------------------------------------------------------------

/** Card/rail summary fields an anonymous caller may always read. */
export const SUMMARY_TASK_FIELDS = Object.freeze([
  'id', 'project', 'title', 'status', 'priority', 'assigned_agent', 'stage_owners',
  'milestone', 'depends_on', 'issues', 'round', 'version',
  'created_at', 'completed_at', 'archived_at', 'deleted_at', 'updated',
  'claim_expires_at', 'claim_lease_ms', 'last_progress_at', 'reclaim_count',
]);

/** Metadata keys the card face renders (the estimate chip). */
export const SUMMARY_METADATA_KEYS = Object.freeze(['estimate', 'points', 'size']);
const SUMMARY_METADATA_MAX_LEN = 32;
/** Who/when entries kept for the signal rail's activity feed (no text). */
export const SUMMARY_ACTIVITY_LIMIT = 20;

function summaryMetadata(metadata) {
  const out = {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return out;
  for (const key of SUMMARY_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string' && value.length <= SUMMARY_METADATA_MAX_LEN) out[key] = value;
  }
  return out;
}

function summaryActivity(logs) {
  if (!Array.isArray(logs)) return [];
  const out = [];
  for (const entry of logs) {
    if (!entry || typeof entry !== 'object') continue;
    out.push({ timestamp: entry.timestamp ?? null, agent_id: entry.agent_id ?? null });
  }
  // Keep the newest entries whichever order the log is stored in.
  out.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return out.slice(0, SUMMARY_ACTIVITY_LIMIT);
}

/**
 * The summary view of a task: what the board card and the signal rail render,
 * and nothing else. `description`, `agent_logs`, `comments` and `metadata`
 * keep their types (empty) so existing readers do not crash; `activity` is the
 * who/when of the latest log entries WITHOUT their text; `details_locked` tells
 * the reader that this is the reduced shape.
 */
export function redactTaskDetails(task) {
  if (!task || typeof task !== 'object') return task;
  const out = {};
  for (const field of SUMMARY_TASK_FIELDS) {
    if (task[field] !== undefined) out[field] = task[field];
  }
  out.description = '';
  out.agent_logs = [];
  out.comments = [];
  out.metadata = summaryMetadata(task.metadata);
  out.activity = summaryActivity(task.agent_logs);
  out.details_locked = true;
  return out;
}

/**
 * Shapes a task (or list) for the caller of a READ. `req.caller.detailAccess`
 * is set by the auth middleware on every read; anything other than an explicit
 * `false` (mutations, embedders without the middleware) keeps the full shape.
 */
export function detailsLockedFor(req) {
  return req?.caller?.detailAccess === false;
}

export function shapeTaskFor(req, task) {
  return detailsLockedFor(req) ? redactTaskDetails(task) : task;
}

export function shapeTasksFor(req, tasks) {
  return detailsLockedFor(req) ? tasks.map(redactTaskDetails) : tasks;
}

/** Body of the 403 a detail-only endpoint answers a locked caller with. */
export const DETAILS_LOCKED_BODY = Object.freeze({
  error: 'details_locked',
  message: 'Card details need a board token or the master unlock',
});
