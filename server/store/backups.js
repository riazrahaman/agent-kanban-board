/**
 * C1 (v3.12.5) — §2.7 periodic backup: opt-in snapshot of the live JSON data
 * file(s) into a sibling backups/ directory, rotated to a bounded count. OFF
 * unless KANBAN_BACKUP_ENABLED is set. Read-only: never takes the mutation lock.
 *
 * Extracted verbatim from store.js; __dirname moved from server/ to server/store/
 * so the default data-file fallback is re-anchored to server/tasks.json.
 */
import { readdir, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonDataDir, gitRoot } from '../task-identity.js';
import { JsonStorage } from '../storage.js';
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

function defaultLiveFile() {
  return process.env.KANBAN_DATA_FILE || path.join(__dirname, '..', 'tasks.json');
}

function backupSourceDir() {
  if (process.env.KANBAN_DATA_DIR) return process.env.KANBAN_DATA_DIR;
  return path.dirname(defaultLiveFile());
}

function defaultBackupRoot() {
  return path.join(backupSourceDir(), 'backups');
}

/** Name of the layout manifest written at the root of every snapshot. */
export const BACKUP_MANIFEST = 'backup-manifest.json';

/**
 * COR-11: the default project's files, taken from the same JsonStorage the
 * store uses (live partition, journal, archive, trash, settings), as paths
 * relative to the directory that holds the live file. Mirroring that layout
 * at the snapshot root means a snapshot of a deployment whose default file
 * sits inside the data dir is still a plain copy of the data dir.
 */
function defaultProjectFiles() {
  const live = defaultLiveFile();
  const storage = new JsonStorage(live, { isDefault: true });
  const dir = path.dirname(live);
  const files = [live, storage.journalFile, storage.archiveFile, storage.trashFile, storage.settingsFile];
  return { dir, rel: files.map((f) => path.relative(dir, f)) };
}

// Named-project storage under the JSON data dir: `tasks/` holds every named
// partition with its journal, `tasks/archive/` and `tasks/trash/`; per-project
// settings live in `settings/` and log spill sidecars in `spill/`. `archive/`
// is kept from the original backup set.
const NAMED_PROJECT_TREES = ['tasks', 'archive', 'settings', 'spill'];

/** Snapshot subdirectory holding a separately rooted git card tree. */
export const GIT_SNAPSHOT_DIR = 'git-root';

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Batch 3: the git backend's root when the data-dir copy does not already
 * include it — i.e. KANBAN_GIT_DIR (or the in-repo fallback) outside
 * KANBAN_DATA_DIR, or any git root when KANBAN_DATA_DIR is unset (then only
 * the JSON storage subtrees are copied). Null for the JSON backend.
 */
function separateGitRoot() {
  if ((process.env.KANBAN_STORAGE_BACKEND || 'json') !== 'git') return null;
  const root = gitRoot();
  const dataDir = process.env.KANBAN_DATA_DIR;
  if (dataDir && isInside(root, dataDir)) return null;
  return root;
}

async function runBackup() {
  const root = defaultBackupRoot();
  const stamp = sanitizeTimestamp(new Date().toISOString());
  const destDir = path.join(root, stamp);
  await mkdir(destDir, { recursive: true });
  const skip = new Set([path.resolve(root)]);

  // 1. Named projects. With KANBAN_DATA_DIR set the whole tree is copied (as
  //    before); otherwise every storage subtree of the JSON data dir.
  const dataDir = process.env.KANBAN_DATA_DIR || jsonDataDir();
  if (process.env.KANBAN_DATA_DIR) {
    if (existsSync(dataDir)) await copyDirTree(dataDir, destDir, skip);
  } else {
    for (const sub of NAMED_PROJECT_TREES) {
      const src = path.join(dataDir, sub);
      if (existsSync(src)) await copyDirTree(src, path.join(destDir, sub), skip);
    }
  }

  // 2. The default project, wherever KANBAN_DATA_FILE puts it (it may lie
  //    outside the data dir, and its archive/trash/settings are siblings of
  //    the live file, not of the data dir).
  const def = defaultProjectFiles();
  const copied = [];
  for (const rel of def.rel) {
    const src = path.join(def.dir, rel);
    if (!existsSync(src)) continue;
    const dest = path.join(destDir, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(src, dest);
    copied.push(rel);
  }

  // 3. Git backend whose root is not covered by step 1: the card folders,
  //    archive, trash and settings, copied under GIT_SNAPSHOT_DIR. The `.git`
  //    directory itself is left out — history lives in git (push it, or back
  //    it up separately).
  let git = null;
  const gitDir = separateGitRoot();
  if (gitDir && existsSync(gitDir)) {
    const gitSkip = new Set([...skip, path.resolve(gitDir, '.git')]);
    await copyDirTree(gitDir, path.join(destDir, GIT_SNAPSHOT_DIR), gitSkip);
    git = { dir: path.resolve(gitDir), snapshot_dir: GIT_SNAPSHOT_DIR };
  }

  // 4. Layout manifest, so the restore side knows where the default project's
  //    files came from when they do not live inside the data dir, and where
  //    the git card tree belongs.
  const manifest = {
    format: 1,
    created_at: new Date().toISOString(),
    data_dir: path.resolve(dataDir),
    default_project: { dir: path.resolve(def.dir), files: copied, live_file: def.rel[0] },
    split: path.resolve(def.dir) !== path.resolve(dataDir),
    git,
  };
  await writeFile(path.join(destDir, BACKUP_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  await rotateBackups(root);
}

async function copyDirTree(src, dest, skip = new Set()) {
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (skip.has(path.resolve(s))) continue;
      await copyDirTree(s, d, skip);
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

