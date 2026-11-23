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
 *   key     = HMAC_SHA256(serverSecret, "kanban-unlock-v2" || scrypt(password, salt))
 *
 * `serverSecret` and `salt` are RANDOM (32 and 16 bytes), generated once and
 * kept in `<data dir>/.secrets/master-unlock.json` (directory 0700, file 0600)
 * so unlocks survive a restart; if that file cannot be written they live for
 * the process only (a warning says so, and a restart then asks every browser
 * for the password again). A file that exists but cannot be READ is never
 * overwritten: that run uses a per-process secret and leaves the file alone.
 * `.secrets/` is never included in a backup (store/backups.js). Nothing a client ever holds can therefore
 * be checked offline against a password guess: verifying a MAC needs the
 * server's random secret. The scrypt fingerprint only BINDS the key to the
 * current password, so rotating the password still revokes every outstanding
 * unlock; it is computed once per password value. No session table.
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
import fs from 'node:fs';
import path from 'node:path';
import { jsonDataDir } from './task-identity.js';
import { tokensMatch } from './utils/constantTime.js';
import { addressOwnerKey } from './utils/addressKey.js';
import { createLogger } from './logger.js';

const log = createLogger('auth');

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

// --- signing material -------------------------------------------------------

export const UNLOCK_SECRET_DIR = '.secrets';
export const UNLOCK_SECRET_FILE = 'master-unlock.json';
/** scrypt cost for the password fingerprint (about 50-100 ms, once per password). */
const SCRYPT_PARAMS = Object.freeze({ N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

let material = null; // { dir, secret: Buffer, salt: Buffer, persisted: boolean }
let cachedPassword = null;
let cachedKey = null;
let warnedEphemeral = false;

function validMaterial(parsed) {
  return parsed && typeof parsed === 'object'
    && typeof parsed.secret === 'string' && /^[0-9a-f]{64}$/.test(parsed.secret)
    && typeof parsed.salt === 'string' && /^[0-9a-f]{32}$/.test(parsed.salt);
}

/**
 * Inspects `.secrets/` WITHOUT following a symlink. Returns 'symlink' when the
 * directory (or anything else at that name) is a symlink, so the caller never
 * reads, chmods or writes through it; otherwise tightens a group- or
 * world-writable directory (restored from an archive, created by hand) back to
 * 0700, says so, and returns null. Best effort.
 */
function inspectSecretDir(dir) {
  let info;
  try {
    info = fs.lstatSync(dir);
  } catch {
    return null; // absent (created 0700 below) or unreadable (the read reports it)
  }
  if (info.isSymbolicLink()) return 'symlink';
  if (!info.isDirectory() || (info.mode & 0o022) === 0) return null;
  const was = (info.mode & 0o777).toString(8).padStart(3, '0');
  try {
    // lstat said a real directory; chmod of a directory path is not a symlink
    // hop here.
    fs.chmodSync(dir, 0o700);
    log.warn('tightened a group/world-writable unlock secret directory to 0700', { path: dir, was });
  } catch (err) {
    log.warn('unlock secret directory is group/world-writable and could not be tightened', { path: dir, was, code: err?.code });
  }
  return null;
}

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * Reads the secret file without following a symlink at the file name, and
 * tightens it to 0600 through the open descriptor (so the chmod can never land
 * on a symlink's target). Returns the text, or throws the fs error; an
 * attempted symlink read throws with code 'ESYMLINK'.
 */
function readSecretFile(file) {
  const info = fs.lstatSync(file); // ENOENT propagates: first start
  if (info.isSymbolicLink()) {
    const err = new Error('symlink');
    err.code = 'ESYMLINK';
    throw err;
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    const raw = fs.readFileSync(fd, 'utf8');
    try { if (fs.fstatSync(fd).isFile()) fs.fchmodSync(fd, 0o600); } catch { /* best effort */ }
    return raw;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Loads the random signing secret + salt for the current data dir. These cases
 * are told apart, and none of them ever logs a secret value:
 *
 *   - file MISSING (ENOENT): first start; create it and log that (info).
 *   - file present but CORRUPT or EMPTY: replace it with fresh material, with a
 *     warning naming the path (never the content: a JSON parse error message
 *     quotes the input, so it is not logged either). Outstanding unlocks die.
 *     When the replacement cannot be written (read-only volume) the warning
 *     says the file was left as it is and this run is per-process.
 *   - READ ERROR (EACCES, EIO, ...): the stored secret may be perfectly good,
 *     so it is NOT rotated. This run uses a per-process key instead (a warning
 *     says so, and the startup line reports "per-process"); the next start
 *     that can read the file gets the stored secret back.
 *   - SYMLINK: `.secrets/` or the secret file is a symbolic link. Nothing is
 *     read, chmodded or written through it (it could point anywhere, e.g. a
 *     world-writable directory outside the data dir); this run is per-process
 *     and a warning names the path.
 *
 * A file that cannot be written (read-only volume) also leaves a per-process
 * secret: unlocks then do not survive a restart.
 */
function loadMaterial() {
  const dir = path.join(jsonDataDir(), UNLOCK_SECRET_DIR);
  if (material && material.dir === dir) return material;
  const file = path.join(dir, UNLOCK_SECRET_FILE);
  let loaded = null;
  let persisted = false;
  let state = 'missing'; // missing | corrupt | read_error | symlink | stored
  let readErrorCode = null;
  let raw = null;
  if (inspectSecretDir(dir) === 'symlink') {
    state = 'symlink';
  } else {
    try {
      raw = readSecretFile(file);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        state = 'missing';
      } else if (err && (err.code === 'ESYMLINK' || err.code === 'ELOOP')) {
        state = 'symlink';
      } else {
        state = 'read_error';
        readErrorCode = (err && err.code) || 'unknown';
      }
    }
  }
  if (raw !== null) {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (validMaterial(parsed)) {
      loaded = { secret: Buffer.from(parsed.secret, 'hex'), salt: Buffer.from(parsed.salt, 'hex') };
      persisted = true;
      state = 'stored';
    } else {
      state = 'corrupt';
    }
  }
  if (state === 'symlink') {
    loaded = { secret: crypto.randomBytes(32), salt: crypto.randomBytes(16) };
    warnedEphemeral = true;
    log.warn(
      'the master-unlock secret directory or file is a symbolic link; it is not followed, read or written, and ' +
      'this run uses a per-process secret (unlocks made now end at the next restart; replace the link with a real ' +
      'directory owned by the server)',
      { path: file },
    );
  } else if (state === 'read_error') {
    loaded = { secret: crypto.randomBytes(32), salt: crypto.randomBytes(16) };
    warnedEphemeral = true;
    log.warn(
      'the master-unlock signing secret file could not be read; it is left untouched and this run uses a ' +
      'per-process secret (unlocks made now end at the next restart; fix the file permissions or volume)',
      { path: file, code: readErrorCode },
    );
  } else if (!loaded) {
    loaded = { secret: crypto.randomBytes(32), salt: crypto.randomBytes(16) };
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // The data dir can be a git repository (KANBAN_GIT_DIR, git-yaml
      // storage). The store only ever stages its own files by name, but keep
      // a manual `git add -A` there from picking up a signing secret too.
      try { fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', { mode: 0o600, flag: 'wx' }); } catch { /* exists or best effort */ }
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({ v: 2, secret: loaded.secret.toString('hex'), salt: loaded.salt.toString('hex') }),
        { mode: 0o600, flag: 'wx' },
      );
      fs.renameSync(tmp, file);
      persisted = true;
      if (state === 'missing') log.info('created the master-unlock signing secret', { path: file });
    } catch {
      persisted = false;
    }
    if (state === 'corrupt') {
      if (persisted) {
        log.warn('the master-unlock signing secret file was empty or corrupt; replaced it (every browser must re-enter the master password)', { path: file });
      } else {
        warnedEphemeral = true;
        log.warn(
          'the master-unlock signing secret file is empty or corrupt and could not be replaced (read-only volume?); ' +
          'it is left as it is and this run uses a per-process secret (every browser must re-enter the master ' +
          'password after a restart)',
          { path: file },
        );
      }
    }
  }
  if (!persisted && !warnedEphemeral) {
    warnedEphemeral = true;
    console.warn(
      '[kanban auth] the master-unlock signing secret could not be stored under the data directory; ' +
      'using a per-process secret, so every browser must re-enter the master password after a restart.'
    );
  }
  material = { dir, ...loaded, persisted, state };
  cachedPassword = null;
  cachedKey = null;
  return material;
}

/**
 * Why the signing secret is per-process, for the startup line: null when it is
 * stored on disk (or no usable password is configured), 'read_error' when the
 * stored file exists but could not be read, 'symlink' when `.secrets/` or the
 * file is a symbolic link (refused), 'unwritable' otherwise.
 */
export function unlockSecretFallbackReason() {
  if (!masterPasswordUsable()) return null;
  const m = loadMaterial();
  if (m.persisted) return null;
  if (m.state === 'read_error' || m.state === 'symlink') return m.state;
  return 'unwritable';
}

/** Whether the signing secret is stored on disk (false = per-process only). */
export function unlockSecretPersisted() {
  return masterPasswordUsable() ? loadMaterial().persisted : false;
}

/** Test helper: forget the loaded secret, the derived key and the warning latch. */
export function resetUnlockKeyMaterial() {
  material = null;
  cachedPassword = null;
  cachedKey = null;
  warnedEphemeral = false;
}

/**
 * HMAC key for unlock tokens; null when no usable password is configured.
 * Keyed by the server's RANDOM secret, so it cannot be recomputed from the
 * password and public values; bound to the password through a salted scrypt
 * fingerprint, so a new password yields a new key (every old unlock dies).
 */
export function masterUnlockKey() {
  if (!masterPasswordUsable()) return null;
  const m = loadMaterial();
  const password = masterPassword();
  if (cachedKey === null || cachedPassword !== password) {
    const fingerprint = crypto.scryptSync(password, m.salt, 32, SCRYPT_PARAMS);
    cachedKey = crypto.createHmac('sha256', m.secret).update('kanban-unlock-v2\u0000').update(fingerprint).digest();
    cachedPassword = password;
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
let maxFailureEntries = MAX_UNLOCK_FAILURE_ENTRIES;

/** Test helper: shrink the per-address table so the overflow path is reachable. */
export function setUnlockFailureCapacity(n = MAX_UNLOCK_FAILURE_ENTRIES) {
  maxFailureEntries = n;
}

/** True when `ip` is being counted on the shared overflow counter. */
export function unlockUsesOverflow(ip, now = Date.now()) {
  return failureKey(ip, now, false) === OVERFLOW_KEY;
}

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
  if (sweep && tracked() >= maxFailureEntries) {
    for (const [k, r] of unlockFailures) {
      if (now - r.windowStartMs < UNLOCK_FAILURE_WINDOW_MS) break;
      unlockFailures.delete(k);
    }
  }
  return tracked() < maxFailureEntries ? ip : OVERFLOW_KEY;
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

/**
 * True while this address has used up its failed attempts for the window. An
 * address that could not get its own counter (table full) is judged on the
 * shared overflow counter, so a flood of fresh addresses is locked out as a
 * group instead of each one starting with a clean slate.
 */
export function unlockLockedOut(ip, now = Date.now()) {
  const rec = unlockFailures.get(failureKey(ip, now, false));
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
