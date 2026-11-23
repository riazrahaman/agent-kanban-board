/**
 * 3.18.1 — the master-unlock signing secret (`<data dir>/.secrets/`) is never
 * part of a backup: not in a local snapshot, not in the Telegram archive, and
 * never copied back by scripts/restore-backup.mjs (a 3.18.0 snapshot holds one).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../store.js';
import { BACKUP_EXCLUDED_DIRS } from '../store/backups.js';
import { runTelegramBackupNow } from '../telegramBackup.js';
import { UNLOCK_SECRET_DIR, UNLOCK_SECRET_FILE } from '../masterUnlock.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESTORE_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'restore-backup.mjs');

const KEYS = [
  'KANBAN_DATA_DIR', 'KANBAN_DATA_FILE', 'KANBAN_BACKUP_KEEP',
  'KANBAN_TELEGRAM_BACKUP_ENABLED', 'KANBAN_TELEGRAM_BOT_TOKEN', 'KANBAN_TELEGRAM_CHAT_ID',
];
const SECRET_JSON = JSON.stringify({ v: 2, secret: 'a'.repeat(64), salt: 'b'.repeat(32) });

async function listTree(root, rel = '') {
  const out = [];
  for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    out.push(r);
    if (e.isDirectory()) out.push(...await listTree(root, r));
  }
  return out;
}

describe('backups never carry the master-unlock secret (3.18.1)', () => {
  let saved;
  let dir;
  beforeEach(async () => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    dir = await mkdtemp(path.join(tmpdir(), 'kanban-bksec-'));
    process.env.KANBAN_DATA_DIR = dir;
    process.env.KANBAN_DATA_FILE = path.join(dir, 'tasks.json');
    process.env.KANBAN_BACKUP_KEEP = '5';
    await writeFile(path.join(dir, 'tasks.json'), JSON.stringify({ tasks: [] }));
    await mkdir(path.join(dir, 'tasks'), { recursive: true });
    await writeFile(path.join(dir, 'tasks', 'alpha.json'), JSON.stringify({ project: 'alpha', tasks: [] }));
    await mkdir(path.join(dir, UNLOCK_SECRET_DIR), { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, UNLOCK_SECRET_DIR, UNLOCK_SECRET_FILE), SECRET_JSON, { mode: 0o600 });
  });
  afterEach(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('the exclusion list names the secret directory', () => {
    assert.ok(BACKUP_EXCLUDED_DIRS.includes(UNLOCK_SECRET_DIR));
  });

  it('a local snapshot holds the board data but no .secrets/, at any depth', async () => {
    // A stray nested copy is skipped by name too (e.g. a git root that is the data dir).
    await mkdir(path.join(dir, 'tasks', UNLOCK_SECRET_DIR), { recursive: true });
    await writeFile(path.join(dir, 'tasks', UNLOCK_SECRET_DIR, UNLOCK_SECRET_FILE), SECRET_JSON);
    const snap = await store.runBackupNow();
    const files = await listTree(snap);
    assert.ok(files.includes('tasks/alpha.json'), files.join(','));
    assert.ok(files.includes('tasks.json'), files.join(','));
    assert.deepEqual(files.filter((f) => f.split('/').includes(UNLOCK_SECRET_DIR)), []);
  });

  it('the Telegram archive file list has no .secrets/ entry', async () => {
    process.env.KANBAN_TELEGRAM_BACKUP_ENABLED = '1';
    process.env.KANBAN_TELEGRAM_BOT_TOKEN = '123:TEST';
    process.env.KANBAN_TELEGRAM_CHAT_ID = '42';
    let bytes;
    const fetchImpl = async (_u, init) => {
      bytes = Buffer.from(await init.body.get('document').arrayBuffer());
      return { ok: true, status: 200 };
    };
    const res = await runTelegramBackupNow({ fetchImpl });
    assert.equal(res.ok, true, res.error);
    const archive = path.join(dir, 'sent.tar.gz');
    await writeFile(archive, bytes);
    const { stdout } = await execFileAsync('tar', ['-tzf', archive]);
    const entries = stdout.split('\n').filter(Boolean);
    assert.ok(entries.some((e) => e.endsWith('tasks/alpha.json')), stdout);
    assert.deepEqual(entries.filter((e) => e.split('/').includes(UNLOCK_SECRET_DIR)), []);
  });

  it('the Telegram pack also drops .secrets/ from an older snapshot that holds one', async () => {
    process.env.KANBAN_TELEGRAM_BACKUP_ENABLED = '1';
    process.env.KANBAN_TELEGRAM_BOT_TOKEN = '123:TEST';
    process.env.KANBAN_TELEGRAM_CHAT_ID = '42';
    const old = path.join(dir, 'old-snapshot');
    await mkdir(path.join(old, UNLOCK_SECRET_DIR), { recursive: true });
    await writeFile(path.join(old, UNLOCK_SECRET_DIR, UNLOCK_SECRET_FILE), SECRET_JSON);
    await writeFile(path.join(old, 'tasks.json'), '{"tasks":[]}');
    let bytes;
    const fetchImpl = async (_u, init) => {
      bytes = Buffer.from(await init.body.get('document').arrayBuffer());
      return { ok: true, status: 200 };
    };
    const res = await runTelegramBackupNow({ fetchImpl, snapshot: async () => old });
    assert.equal(res.ok, true, res.error);
    const archive = path.join(dir, 'old.tar.gz');
    await writeFile(archive, bytes);
    const { stdout } = await execFileAsync('tar', ['-tzf', archive]);
    assert.match(stdout, /old-snapshot\/tasks\.json/);
    assert.doesNotMatch(stdout, /\.secrets/);
  });

  it('restore-backup never copies a .secrets/ found in a (3.18.0) snapshot', async () => {
    const snap = path.join(dir, 'snap');
    await mkdir(path.join(snap, 'tasks'), { recursive: true });
    await writeFile(path.join(snap, 'tasks.json'), '{"tasks":[]}');
    await writeFile(path.join(snap, 'tasks', 'alpha.json'), '{"project":"alpha","tasks":[]}');
    await mkdir(path.join(snap, UNLOCK_SECRET_DIR), { recursive: true });
    await writeFile(path.join(snap, UNLOCK_SECRET_DIR, UNLOCK_SECRET_FILE), '{"old":"secret"}');

    const dry = await execFileAsync(process.execPath, [RESTORE_SCRIPT, snap, '--into', path.join(dir, 'unused'), '--dry-run']);
    assert.doesNotMatch(dry.stdout, /would copy: \.secrets/);
    assert.match(dry.stdout, /skipping: \.secrets\//);

    // Fresh volume: data restored, no secret (the server makes a new one).
    const fresh = path.join(dir, 'fresh');
    await execFileAsync(process.execPath, [RESTORE_SCRIPT, snap, '--into', fresh]);
    assert.ok(existsSync(path.join(fresh, 'tasks', 'alpha.json')));
    assert.equal(existsSync(path.join(fresh, UNLOCK_SECRET_DIR)), false);

    // In place: the target's live secret is left exactly as it was.
    const live = path.join(dir, 'live');
    await mkdir(path.join(live, UNLOCK_SECRET_DIR), { recursive: true });
    await writeFile(path.join(live, UNLOCK_SECRET_DIR, UNLOCK_SECRET_FILE), SECRET_JSON);
    await execFileAsync(process.execPath, [RESTORE_SCRIPT, snap, '--into', live]);
    assert.equal(await readFile(path.join(live, UNLOCK_SECRET_DIR, UNLOCK_SECRET_FILE), 'utf8'), SECRET_JSON);
    assert.ok(existsSync(path.join(live, 'tasks', 'alpha.json')));
  });
});
