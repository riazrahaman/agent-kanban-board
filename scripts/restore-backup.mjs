#!/usr/bin/env node
/**
 * scripts/restore-backup.mjs — restore kanban board data from a periodic
 * backup snapshot (ENH-02, v2.5.5 restore-runbook tooling).
 *
 * Usage:
 *   node scripts/restore-backup.mjs <backup-dir> --into <data-dir> [--default-into <dir>] [--git-into <dir>] [--dry-run]
 *
 * <backup-dir> is a timestamped snapshot directory produced by the periodic
 * backup engine (under <data-dir>/backups/, e.g.
 * /data/backups/2026-09-24T10-00-00-000Z). An off-volume copy of that folder
 * (or a tar of it) is what the runbook tells you to keep outside the volume.
 *
 * The script verifies the snapshot looks like a real backup (tasks.json or a
 * non-empty tasks/ directory present) before copying. Stop the service first —
 * restoring under a running board risks torn writes.
 *
 * Snapshots carry a `backup-manifest.json` describing where the default
 * project's files (live file, journal, archive, trash, settings) came from.
 * When that directory differs from the data dir (KANBAN_DATA_FILE outside
 * KANBAN_DATA_DIR, or the no-env layout), pass `--default-into <dir>` (the
 * directory of KANBAN_DATA_FILE) to put those files back there; without it
 * everything is copied into --into as before and a notice is printed.
 *
 * When the git backend's root lies outside the data dir, the snapshot keeps
 * its card folders, archive, trash and settings (not `.git` — history lives
 * in git) under `git-root/`, recorded as `git` in the manifest. Pass
 * `--git-into <dir>` (the KANBAN_GIT_DIR) to restore them there; without it
 * they are not copied and a notice is printed.
 *
 * Examples:
 *   node scripts/restore-backup.mjs /mnt/restore/2026-09-24T10-00-00-000Z --into /data
 *   node scripts/restore-backup.mjs /mnt/restore/2026-09-24T10-00-00-000Z --dry-run
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const MANIFEST = 'backup-manifest.json';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const intoIdx = args.indexOf('--into');
const intoArg = intoIdx !== -1 ? args[intoIdx + 1] : undefined;
const defaultIntoIdx = args.indexOf('--default-into');
const defaultIntoArg = defaultIntoIdx !== -1 ? args[defaultIntoIdx + 1] : undefined;
const gitIntoIdx = args.indexOf('--git-into');
const gitIntoArg = gitIntoIdx !== -1 ? args[gitIntoIdx + 1] : undefined;
const srcArg = args[0];

function fail(msg) {
  console.error(`restore-backup: ${msg}`);
  process.exit(2);
}

if (!srcArg) fail('usage: node scripts/restore-backup.mjs <backup-dir> --into <data-dir> [--default-into <dir>] [--git-into <dir>] [--dry-run]');
if (defaultIntoIdx !== -1 && !defaultIntoArg) fail('--default-into needs a directory');
if (gitIntoIdx !== -1 && !gitIntoArg) fail('--git-into needs a directory');

const src = resolve(srcArg);
const dest = intoArg
  ? resolve(intoArg)
  : process.env.KANBAN_DATA_DIR
    ? resolve(process.env.KANBAN_DATA_DIR)
    : null;
if (!dest) fail('--into <data-dir> is required (or set KANBAN_DATA_DIR)');

if (!existsSync(src) || !statSync(src).isDirectory()) fail(`snapshot directory not found: ${src}`);

// Snapshots written before the manifest existed have none; they restore
// exactly as before.
let manifest = null;
if (existsSync(join(src, MANIFEST))) {
  try {
    manifest = JSON.parse(readFileSync(join(src, MANIFEST), 'utf-8'));
  } catch (err) {
    fail(`unreadable ${MANIFEST}: ${err.message}`);
  }
}
/**
 * A manifest path is used only if it is a plain relative path: no absolute
 * path, no `..` segment, and it resolves strictly inside every directory it
 * will be joined to. Anything else refuses the restore.
 */
function checkRelative(rel, what, ...bases) {
  const ok = typeof rel === 'string' && rel !== '' && !isAbsolute(rel)
    && !rel.split(/[\\/]/).includes('..')
    && bases.every((b) => resolve(b, rel).startsWith(resolve(b) + sep));
  if (!ok) fail(`${MANIFEST} lists an unsafe ${what} path: ${JSON.stringify(rel)} — refusing`);
  return rel;
}
const defaultIntoBase = defaultIntoArg ? resolve(defaultIntoArg) : null;
const defaultFiles = (manifest && manifest.default_project && Array.isArray(manifest.default_project.files))
  ? manifest.default_project.files.map((f) => checkRelative(
    f, 'default project file', src, ...(defaultIntoBase ? [defaultIntoBase] : []),
  ))
  : [];
const liveName = (manifest && manifest.default_project && manifest.default_project.live_file) || 'tasks.json';

// Sanity: a snapshot must contain real data, not an empty rotation shell.
const hasDefaultFile = existsSync(join(src, 'tasks.json')) || existsSync(join(src, liveName));
const tasksDir = join(src, 'tasks');
const hasTasksDir = existsSync(tasksDir) && readdirSync(tasksDir).length > 0;
if (!hasDefaultFile && !hasTasksDir) {
  fail(`snapshot ${src} contains neither tasks.json nor a non-empty tasks/ directory — refusing`);
}

// Separately rooted git card tree (batch 3).
const gitSnap = (manifest && manifest.git && manifest.git.snapshot_dir !== undefined
  && existsSync(join(src, checkRelative(manifest.git.snapshot_dir, 'git snapshot', src))))
  ? join(src, manifest.git.snapshot_dir)
  : null;
const gitDest = gitIntoArg ? resolve(gitIntoArg) : null;
if (gitDest && !gitSnap) fail('--git-into given but the snapshot holds no separate git card tree');

const defaultDest = defaultIntoArg ? resolve(defaultIntoArg) : null;
// Paths (inside the snapshot) that are not copied into the data dir.
const excluded = new Set([resolve(src, MANIFEST)]);
if (defaultDest) for (const rel of defaultFiles) excluded.add(resolve(src, rel));
// The git card tree never belongs in the data dir.
if (gitSnap) excluded.add(resolve(gitSnap));

console.log(`restore-backup: snapshot ${src}`);
console.log(`restore-backup: target  ${dest}${dryRun ? ' (dry run)' : ''}`);
if (defaultDest) {
  console.log(`restore-backup: default project files -> ${defaultDest}`);
} else if (manifest && manifest.split && defaultFiles.length > 0) {
  console.log(
    `restore-backup: note: the default project's files (${defaultFiles.join(', ')}) were backed up from ` +
    `${manifest.default_project.dir}, outside the data dir; they are copied into the target as well. ` +
    'Pass --default-into <dir of KANBAN_DATA_FILE> to restore them where the server reads them.'
  );
}
if (gitDest) {
  console.log(`restore-backup: git card tree -> ${gitDest}`);
} else if (gitSnap) {
  console.log(
    `restore-backup: note: the snapshot holds the git card tree from ${manifest.git.dir} ` +
    `(${manifest.git.snapshot_dir}/); it is NOT copied into the data dir. ` +
    'Pass --git-into <KANBAN_GIT_DIR> to restore it.'
  );
}
if (dryRun) {
  for (const name of readdirSync(src)) {
    if (!excluded.has(resolve(src, name))) console.log(`  would copy: ${name}`);
  }
  if (defaultDest) for (const rel of defaultFiles) console.log(`  would copy: ${rel} -> ${join(defaultDest, rel)}`);
  if (gitDest) console.log(`  would copy: ${manifest.git.snapshot_dir}/ -> ${gitDest}`);
  console.log('restore-backup: dry run complete, nothing written');
  process.exit(0);
}

cpSync(src, dest, { recursive: true, filter: (p) => !excluded.has(resolve(p)) });
if (defaultDest) {
  for (const rel of defaultFiles) {
    const from = join(src, rel);
    if (!existsSync(from)) continue;
    const to = join(defaultDest, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
}
if (gitDest) {
  // The card tree only; an existing .git in the target is left untouched.
  cpSync(gitSnap, gitDest, { recursive: true });
}
console.log('restore-backup: copy complete');
console.log('restore-backup: restart the service so the store reloads from the restored files');
