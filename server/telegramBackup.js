/**
 * §2.12 (v3.17.0) — daily off-volume backup to Telegram.
 *
 * Once a day at KANBAN_TELEGRAM_BACKUP_HOUR (default 03:00) in
 * KANBAN_TELEGRAM_BACKUP_TZ (default Asia/Dubai, UTC+4 all year, i.e. Abu Dhabi
 * time) the server takes a consistent snapshot of ALL board data (the same
 * snapshot the periodic backup writes: every project, archive, trash, settings,
 * journal, spill and audit file; nothing is stripped), packs it into a
 * .tar.gz and sends it to the configured Telegram chat with `sendDocument`.
 *
 * Off unless KANBAN_TELEGRAM_BACKUP_ENABLED is truthy AND the bot token + chat
 * id are set. It reuses the reclaim-alert bot (KANBAN_TELEGRAM_BOT_TOKEN /
 * KANBAN_TELEGRAM_CHAT_ID). Fail-open for the board: any failure is logged
 * (bot token scrubbed), a short text alert is attempted, and nothing here can
 * affect a request. The archive contains every task's text: point it at a
 * private chat only (Telegram bot chats are not end-to-end encrypted).
 *
 * A marker file (`<backup root>/.telegram-last-sent`) records the last
 * successful send, so a restart or deploy never re-sends within 24 h, while a
 * missed run (process down at 03:00) is caught up shortly after the next boot.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { notifierConfig } from './notifier.js';
import { runBackupNow, backupRootDir, BACKUP_EXCLUDED_DIRS } from './store/backups.js';
import { APP_VERSION } from './version.js';
import { createLogger } from './logger.js';

const log = createLogger('telegram-backup');
const execFileAsync = promisify(execFile);

export const DEFAULT_HOUR = 3;
export const DEFAULT_TZ = 'Asia/Dubai';
/** Telegram Bot API upload ceiling is 50 MB; stay safely under it. */
export const MAX_UPLOAD_BYTES = 49 * 1024 * 1024;
export const MARKER_FILE = '.telegram-last-sent';
const DAY_MS = 24 * 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 120000;
const CATCH_UP_DELAY_MS = 60000;
const RETRY_DELAYS_MS = [60000, 300000];

function truthy(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  const v = String(raw).trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no' && v !== 'off';
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Config from the environment. `enabled` needs the flag AND bot token + chat id. */
export function telegramBackupConfig() {
  const flag = truthy(process.env.KANBAN_TELEGRAM_BACKUP_ENABLED);
  const notify = notifierConfig();
  const hourRaw = process.env.KANBAN_TELEGRAM_BACKUP_HOUR;
  const hourNum = hourRaw === undefined || String(hourRaw).trim() === '' ? DEFAULT_HOUR : Number(hourRaw);
  const hour = Number.isInteger(hourNum) && hourNum >= 0 && hourNum <= 23 ? hourNum : DEFAULT_HOUR;
  const tzRaw = String(process.env.KANBAN_TELEGRAM_BACKUP_TZ || '').trim() || DEFAULT_TZ;
  const timeZone = validTimeZone(tzRaw) ? tzRaw : DEFAULT_TZ;
  return {
    flag,
    enabled: flag && notify.enabled,
    botToken: notify.botToken,
    chatId: notify.chatId,
    hour,
    timeZone,
  };
}

/** Wall-clock parts of `date` in `timeZone`. */
function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** Offset (ms) such that local-wall-clock-as-UTC = utc + offset. */
function zoneOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(date.getTime() / 60000) * 60000;
}

/**
 * Milliseconds from `now` until the next HH:00 wall-clock time in `timeZone`
 * (strictly in the future). DST-safe: the offset is re-evaluated at the target.
 */
export function msUntilNextRun(now, hour, timeZone) {
  const p = zonedParts(now, timeZone);
  const offNow = zoneOffsetMs(now, timeZone);
  for (let addDays = 0; addDays <= 2; addDays += 1) {
    const localTarget = Date.UTC(p.year, p.month - 1, p.day + addDays, hour, 0);
    const guess = localTarget - offNow;
    const utc = localTarget - zoneOffsetMs(new Date(guess), timeZone);
    if (utc > now.getTime()) return utc - now.getTime();
  }
  return DAY_MS;
}

/** `2026-11-22-0300` in the configured zone, for the file name and caption. */
export function stampInZone(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const z = (n) => String(n).padStart(2, '0');
  return { day: `${p.year}-${z(p.month)}-${z(p.day)}`, time: `${z(p.hour)}${z(p.minute)}`, clock: `${z(p.hour)}:${z(p.minute)}` };
}

function scrub(message, cfg) {
  let s = String(message ?? '');
  if (cfg && cfg.botToken) s = s.split(cfg.botToken).join('[redacted]');
  return s;
}

async function telegramCall(cfg, method, init, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${cfg.botToken}/${method}`, {
      method: 'POST',
      signal: controller.signal,
      ...init,
    });
    if (!res.ok) throw new Error(`telegram ${method} responded HTTP ${res.status}`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

async function sendText(cfg, text, fetchImpl) {
  return telegramCall(
    cfg,
    'sendMessage',
    {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true }),
    },
    fetchImpl,
  );
}

async function sendDocument(cfg, { buffer, filename, caption }, fetchImpl) {
  const form = new FormData();
  form.append('chat_id', cfg.chatId);
  form.append('caption', caption);
  form.append('document', new Blob([buffer], { type: 'application/gzip' }), filename);
  return telegramCall(cfg, 'sendDocument', { body: form }, fetchImpl);
}

async function packSnapshot(snapshotDir, outFile) {
  // The snapshot never contains `.secrets/` (store/backups.js skips it); the
  // exclude is a second fence so a signing secret can never ride along to a
  // third-party chat even if a snapshot was made by an older version.
  const excludes = BACKUP_EXCLUDED_DIRS.map((name) => `--exclude=${name}`);
  await execFileAsync('tar', ['-czf', outFile, ...excludes, '-C', path.dirname(snapshotDir), path.basename(snapshotDir)]);
}

async function readMarker() {
  try {
    const raw = (await readFile(path.join(backupRootDir(), MARKER_FILE), 'utf-8')).trim();
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

async function writeMarker(date) {
  const root = backupRootDir();
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, MARKER_FILE), date.toISOString() + '\n', 'utf-8');
}

/**
 * Snapshot, pack, send. Resolves `{ ok, bytes?, filename?, error? }`; never
 * throws. `deps` is for tests: `fetchImpl`, `now`, `sleep`, `snapshot`, `pack`.
 */
export async function runTelegramBackupNow(deps = {}) {
  const cfg = telegramBackupConfig();
  if (!cfg.enabled) return { ok: false, error: 'disabled' };
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const now = deps.now ? deps.now() : new Date();
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const snapshot = deps.snapshot || runBackupNow;
  const pack = deps.pack || packSnapshot;
  const stamp = stampInZone(now, cfg.timeZone);
  const filename = `kanban-backup-${stamp.day}-${stamp.time}.tar.gz`;
  let workDir = null;
  try {
    const snapshotDir = await snapshot();
    workDir = await mkdtemp(path.join(tmpdir(), 'kanban-tg-backup-'));
    const archive = path.join(workDir, filename);
    await pack(snapshotDir, archive);
    const { size } = await stat(archive);
    if (size > MAX_UPLOAD_BYTES) {
      const mb = (size / 1048576).toFixed(1);
      throw new Error(`archive is ${mb} MB, over the Telegram upload limit (${MAX_UPLOAD_BYTES / 1048576} MB)`);
    }
    const buffer = await readFile(archive);
    const kb = Math.max(1, Math.round(size / 1024));
    const caption = `Kanban backup ${stamp.day} ${stamp.clock} (${cfg.timeZone}) - ${kb} KB - v${APP_VERSION}`;
    let attempt = 0;
    for (;;) {
      try {
        await sendDocument(cfg, { buffer, filename, caption }, fetchImpl);
        break;
      } catch (err) {
        if (attempt >= RETRY_DELAYS_MS.length) throw err;
        log.warn('send failed, retrying', { attempt: attempt + 1, error: scrub(err && err.message, cfg) });
        await sleep(RETRY_DELAYS_MS[attempt]);
        attempt += 1;
      }
    }
    await writeMarker(now).catch((err) => log.warn('marker write failed', { error: scrub(err && err.message, cfg) }));
    log.info('sent', { filename, bytes: size });
    return { ok: true, bytes: size, filename };
  } catch (err) {
    const error = scrub(err && err.message, cfg);
    log.error('run failed', { error });
    await sendText(cfg, `Kanban daily backup FAILED (${stamp.day} ${stamp.clock} ${cfg.timeZone}): ${error}`.slice(0, 1000), fetchImpl).catch(() => {});
    return { ok: false, error };
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

let timer = null;
let catchUpTimer = null;
let running = false;

async function guardedRun() {
  if (running) return;
  running = true;
  try {
    await runTelegramBackupNow();
  } finally {
    running = false;
  }
}

function scheduleNext() {
  const cfg = telegramBackupConfig();
  const wait = msUntilNextRun(new Date(), cfg.hour, cfg.timeZone);
  timer = setTimeout(() => {
    guardedRun().finally(() => {
      if (timer) scheduleNext();
    });
  }, wait);
  timer.unref();
  return wait;
}

/** Starts the daily schedule. Returns null (inert) unless fully configured. */
export function startTelegramBackup() {
  if (timer) return timer;
  const cfg = telegramBackupConfig();
  if (!cfg.enabled) return null;
  const wait = scheduleNext();
  log.info('started', { hour: cfg.hour, time_zone: cfg.timeZone, next_run_in_ms: wait });
  // Catch-up: if nothing was sent in the last 24 h (first boot, or the process
  // was down at the scheduled time), send one shortly after boot.
  readMarker().then((last) => {
    if (!timer) return;
    if (last === null || Date.now() - last > DAY_MS) {
      catchUpTimer = setTimeout(() => { guardedRun(); }, CATCH_UP_DELAY_MS);
      catchUpTimer.unref();
    }
  });
  return timer;
}

export function stopTelegramBackup() {
  const was = timer !== null || catchUpTimer !== null;
  if (timer) clearTimeout(timer);
  if (catchUpTimer) clearTimeout(catchUpTimer);
  timer = null;
  catchUpTimer = null;
  return was;
}
