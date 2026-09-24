#!/usr/bin/env node
/**
 * scripts/restore-backup.mjs — restore kanban board data from a periodic
 * backup snapshot (ENH-02, v2.5.5 restore-runbook tooling).
 *
 * Usage:
 *   node scripts/restore-backup.mjs <backup-dir> --into <data-dir> [--dry-run]
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
 * Examples:
 *   node scripts/restore-backup.mjs /mnt/restore/2026-09-24T10-00-00-000Z --into /data
 *   node scripts/restore-backup.mjs /mnt/restore/2026-09-24T10-00-00-000Z --dry-run
 */
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const intoIdx = args.indexOf('--into');
const intoArg = intoIdx !== -1 ? args[intoIdx + 1] : undefined;
const srcArg = args[0];

function fail(msg) {
  console.error(`restore-backup: ${msg}`);
  process.exit(2);
}

if (!srcArg) fail('usage: node scripts/restore-backup.mjs <backup-dir> --into <data-dir> [--dry-run]');

const src = resolve(srcArg);
const dest = intoArg
  ? resolve(intoArg)
  : process.env.KANBAN_DATA_DIR
    ? resolve(process.env.KANBAN_DATA_DIR)
    : null;
if (!dest) fail('--into <data-dir> is required (or set KANBAN_DATA_DIR)');

if (!existsSync(src) || !statSync(src).isDirectory()) fail(`snapshot directory not found: ${src}`);

// Sanity: a snapshot must contain real data, not an empty rotation shell.
const hasDefaultFile = existsSync(join(src, 'tasks.json'));
const tasksDir = join(src, 'tasks');
const hasTasksDir = existsSync(tasksDir) && readdirSync(tasksDir).length > 0;
if (!hasDefaultFile && !hasTasksDir) {
  fail(`snapshot ${src} contains neither tasks.json nor a non-empty tasks/ directory — refusing`);
}

console.log(`restore-backup: snapshot ${src}`);
console.log(`restore-backup: target  ${dest}${dryRun ? ' (dry run)' : ''}`);
if (dryRun) {
  for (const name of readdirSync(src)) console.log(`  would copy: ${name}`);
  console.log('restore-backup: dry run complete, nothing written');
  process.exit(0);
}

cpSync(src, dest, { recursive: true });
console.log('restore-backup: copy complete');
console.log('restore-backup: restart the service so the store reloads from the restored files');