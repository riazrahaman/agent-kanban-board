/**
 * C1 (v3.12.5) — §2.7 periodic backup: opt-in snapshot of the live JSON data
 * file(s) into a sibling backups/ directory, rotated to a bounded count. OFF
 * unless KANBAN_BACKUP_ENABLED is set. Read-only: never takes the mutation lock.
 *
 * Extracted verbatim from store.js; __dirname moved from server/ to server/store/
 * so the default data-file fallback is re-anchored to server/tasks.json.
 */
import { readdir, mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonDataDir } from '../task-identity.js';
import { createLogger } from '../logger.js';

const log = createLogger('backup');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// §2.7 periodic backup — opt-in snapshot of the live JSON data file(s) into a
// sibling `backups/` directory, rotated to a bounded count. OFF unless
// KANBAN_BACKUP_ENABLED is set. Read-only: never takes the mutation lock.
// ---------------------------------------------------------------------------
function getBackupIntervalMs() {
  const raw = process.env.KANBAN_BACKUP_INTERVAL_MS;
  if (raw === undefined || raw === '') return 600000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 600000;
}

function getBackupKeep() {
  const raw = process.env.KANBAN_BACKUP_KEEP;
  if (raw === undefined || raw === '') return 10;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10;
}

function isBackupEnabled() {
  const raw = process.env.KANBAN_BACKUP_ENABLED;
  if (raw === undefined || raw === '') return false;
  return raw !== 'false' && raw !== '0';
}

function sanitizeTimestamp(iso) {
  return iso.replace(/[:.]/g, '-');
}

function backupSourceDir() {
  if (process.env.KANBAN_DATA_DIR) return process.env.KANBAN_DATA_DIR;
  const defaultLive = process.env.KANBAN_DATA_FILE || path.join(__dirname, '..', 'tasks.json');
  return path.dirname(defaultLive);
}

function defaultBackupRoot() {
  return path.join(backupSourceDir(), 'backups');
}

async function runBackup() {
  const root = defaultBackupRoot();
  const stamp = sanitizeTimestamp(new Date().toISOString());
  const destDir = path.join(root, stamp);
  await mkdir(destDir, { recursive: true });

  const dataDir = process.env.KANBAN_DATA_DIR;
  if (dataDir && existsSync(dataDir)) {
    await copyDirTree(dataDir, destDir);
  } else {
    const defaultLive = process.env.KANBAN_DATA_FILE || path.join(__dirname, '..', 'tasks.json');
    if (existsSync(defaultLive)) {
      await copyFile(defaultLive, path.join(destDir, path.basename(defaultLive)));
    }
    const jsonDir = jsonDataDir();
    const tasksDir = path.join(jsonDir, 'tasks');
    const archiveDir = path.join(jsonDir, 'archive');
    if (existsSync(tasksDir)) await copyDirTree(tasksDir, path.join(destDir, 'tasks'));
    if (existsSync(archiveDir)) await copyDirTree(archiveDir, path.join(destDir, 'archive'));
  }

  await rotateBackups(root);
}

async function copyDirTree(src, dest) {
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'backups') continue;
      await copyDirTree(s, d);
    } else {
      await copyFile(s, d);
    }
  }
}

async function rotateBackups(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const stamps = entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  const keep = getBackupKeep();
  for (const stale of stamps.slice(keep)) {
    await rm(path.join(root, stale), { recursive: true, force: true });
  }
}

let backupTimer = null;

export function startBackup() {
  if (backupTimer) return backupTimer;
  if (!isBackupEnabled()) return null;
  backupTimer = setInterval(() => {
    runBackup().catch((err) => {
      log.error('run failed', { error: err && err.message });
    });
  }, getBackupIntervalMs());
  backupTimer.unref();
  log.info('started', { interval_ms: getBackupIntervalMs(), keep: getBackupKeep() });
  return backupTimer;
}

export function stopBackup() {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
    return true;
  }
  return false;
}

export function isBackupRunning() {
  return backupTimer !== null;
}

export async function runBackupNow() {
  await runBackup();
}

/**
 * Backup observability for /api/health (ENH-02, v2.5.5). Reports the current
 * config, whether the timer is running, and the freshest snapshot on disk so
 * operators can verify snapshots are actually happening without shelling into
 * the container. Read-only; never touches the mutation lock.
 */
export function backupStatus() {
  const enabled = isBackupEnabled();
  const root = defaultBackupRoot();
  let lastBackupAt = null;
  let backupCount = 0;
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(e.name))
      .map((e) => e.name)
      .sort();
    backupCount = entries.length;
    if (entries.length > 0) {
      // Stamp format is an ISO timestamp with : and . replaced by -, so the
      // freshest snapshot sorts last lexicographically.
      const stamp = entries[entries.length - 1];
      const iso = stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z');
      const parsed = Date.parse(iso);
      lastBackupAt = Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
    }
  } catch {
    // No backups directory yet: count stays 0, last stays null.
  }
  return {
    enabled,
    running: isBackupRunning(),
    interval_ms: getBackupIntervalMs(),
    keep: getBackupKeep(),
    backup_root: root,
    backup_count: backupCount,
    last_backup_at: lastBackupAt,
  };
}

