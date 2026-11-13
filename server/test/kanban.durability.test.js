/**
 * Durability follow-ups (batch 3): one persist per holder write, git trash
 * rows keyed by id and deletion time, journal generations, fsynced journal
 * appends, and backups of a separately rooted git card tree.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, utimes, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import * as store from '../store.js';
import { JsonStorage, GitYamlStorage } from '../storage.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESTORE_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'restore-backup.mjs');

const ENV = [
  'KANBAN_DATA_DIR', 'KANBAN_DATA_FILE', 'KANBAN_GIT_DIR', 'KANBAN_STORAGE_BACKEND',
  'KANBAN_GIT_COMMIT', 'KANBAN_STORAGE_JOURNAL', 'KANBAN_JOURNAL_COMPACT_BYTES',
  'KANBAN_BACKUP_ENABLED', 'KANBAN_DEFAULT_PROJECT', 'KANBAN_REAP_ENABLED', 'KANBAN_CLAIM_TTL_MS',
];
const savedEnv = {};
let tmpRoot;
const NOW = 1_735_000_000_000;
const TTL_MS = 60_000;
const ADMIN = { agent_id: 'ops', role: 'admin' };

before(async () => {
  for (const k of ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'kanban-durability-'));
  process.env.KANBAN_DATA_DIR = path.join(tmpRoot, 'default-data');
  process.env.KANBAN_DATA_FILE = path.join(tmpRoot, 'default-data', 'tasks.json');
  process.env.KANBAN_REAP_ENABLED = 'false';
  process.env.KANBAN_CLAIM_TTL_MS = String(TTL_MS);
});

after(async () => {
  store.stopReaper();
  store.setStorage(null);
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

let seq = 0;
async function freshDir(label) {
  const dir = path.join(tmpRoot, `${label}-${++seq}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
describe('one persist per holder write', { concurrency: 1 }, () => {
  class CountingStorage extends JsonStorage {
    constructor(file, opts) {
      super(file, opts);
      this.calls = [];
      this.failBatch = false;
      this.failAll = false;
    }
    async saveTask(task, all) {
      this.calls.push('saveTask');
      if (this.failAll) throw new Error('disk full (simulated)');
      return super.saveTask(task, all);
    }
    async saveTasks(changed, all) {
      this.calls.push(`saveTasks:${changed.length}`);
      if (this.failBatch || this.failAll) throw new Error('disk full (simulated)');
      return super.saveTasks(changed, all);
    }
  }

  let storage;
  let dir;
  let clock = NOW;
  const realNow = () => Date.now();

  before(async () => {
    dir = await freshDir('holder');
    store.setNowFn(() => clock);
    store.setStorage(null);
    storage = new CountingStorage(path.join(dir, 'tasks.json'), { project: 'default', isDefault: true });
    store.setStorage(storage);
  });
  after(() => {
    store.setNowFn(realNow);
    store.setStorage(null);
  });

  function seedHeld(id, agent) {
    store.setTaskInMemory({
      id, project: 'default', title: id, status: 'IN_PROGRESS', round: 1,
      assigned_agent: agent, claim_lease_ms: TTL_MS,
      claim_expires_at: new Date(clock + TTL_MS).toISOString(),
      created_at: new Date(NOW).toISOString(), updated: new Date(NOW).toISOString(),
      version: 1, agent_logs: [], comments: [], issues: [], metadata: {},
    });
  }
  const onDisk = async () => new Map(
    JSON.parse(await readFile(path.join(dir, 'tasks.json'), 'utf-8')).tasks.map((t) => [t.id, t]),
  );

  it('a heartbeat with siblings persists the primary and the siblings in ONE save', async () => {
    for (const id of ['hb1', 'hb2', 'hb3']) seedHeld(id, 'hb-agent');
    clock += 5_000;
    storage.calls = [];
    const r = await store.renewLease('hb1', 'hb-agent', { caller: { agent_id: 'hb-agent' } });
    assert.equal(r.status, 200);
    assert.deepEqual(storage.calls, ['saveTasks:3']);
    const disk = await onDisk();
    for (const id of ['hb1', 'hb2', 'hb3']) {
      assert.equal(disk.get(id).claim_expires_at, new Date(clock + TTL_MS).toISOString(), `${id} renewed on disk`);
      assert.equal(store.getTask(id).claim_expires_at, new Date(clock + TTL_MS).toISOString(), `${id} renewed in memory`);
    }
  });

  it('a holder PATCH with siblings persists once', async () => {
    for (const id of ['pa1', 'pa2']) seedHeld(id, 'pa-agent');
    clock += 5_000;
    storage.calls = [];
    const r = await store.patchTask('pa1', { title: 'patched' }, { caller: { agent_id: 'pa-agent' } });
    assert.equal(r.status, 200);
    assert.deepEqual(storage.calls, ['saveTasks:2']);
    assert.equal((await onDisk()).get('pa1').title, 'patched');
  });

  it('a write without siblings keeps the single-card save', async () => {
    seedHeld('solo1', 'solo-agent');
    storage.calls = [];
    const r = await store.appendLog('solo1', 'solo-agent', 'progress', 'default');
    assert.equal(r.status, 200);
    assert.deepEqual(storage.calls, ['saveTask']);
  });

  it('a failing combined save falls back to the primary alone and never fails the write', async () => {
    for (const id of ['fb1', 'fb2']) seedHeld(id, 'fb-agent');
    const siblingBefore = store.getTask('fb2').claim_expires_at;
    clock += 5_000;
    storage.calls = [];
    storage.failBatch = true;
    try {
      const r = await store.appendLog('fb1', 'fb-agent', 'progress on fb1', 'default');
      assert.equal(r.status, 200);
    } finally {
      storage.failBatch = false;
    }
    assert.deepEqual(storage.calls, ['saveTasks:2', 'saveTask']);
    assert.equal(store.getTask('fb1').agent_logs.length, 1, 'primary write is in memory');
    assert.equal((await onDisk()).get('fb1').agent_logs.length, 1, 'primary write is on disk');
    assert.equal(store.getTask('fb2').claim_expires_at, siblingBefore, 'sibling not renewed in memory');
  });

  it('when the primary itself cannot be saved, memory is left unchanged', async () => {
    for (const id of ['pf1', 'pf2']) seedHeld(id, 'pf-agent');
    clock += 5_000;
    storage.failAll = true;
    try {
      await assert.rejects(store.appendLog('pf1', 'pf-agent', 'lost', 'default'), /disk full/);
    } finally {
      storage.failAll = false;
    }
    assert.equal(store.getTask('pf1').agent_logs.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('git trash rows keyed by id and deletion time', { concurrency: 1 }, () => {
  const card = (id, extra = {}) => ({
    id, title: id, status: 'READY', round: 1, created_at: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z', version: 1, ...extra,
  });

  it('two same-id rows keep separate files, load as two rows, and remove exactly one', async () => {
    const dir = await freshDir('gittrash');
    const s = new GitYamlStorage(dir, { autoCommit: false });
    const a = card('dup', { deleted_at: '2026-02-01T10:00:00.000Z', title: 'first' });
    const b = card('dup', { deleted_at: '2026-02-02T10:00:00.000Z', title: 'second' });
    await s.trashTask(a);
    await s.trashTask(b);
    const files = (await readdir(path.join(dir, 'trash', 'default'))).sort();
    assert.deepEqual(files, ['dup.20260201T100000000Z.yml', 'dup.20260202T100000000Z.yml']);

    const reloaded = new GitYamlStorage(dir, { autoCommit: false });
    const rows = await reloaded.loadTrash();
    assert.deepEqual(rows.map((r) => r.title).sort(), ['first', 'second']);

    await reloaded.trashRemove(rows.find((r) => r.title === 'first'));
    const left = await new GitYamlStorage(dir, { autoCommit: false }).loadTrash();
    assert.deepEqual(left.map((r) => r.title), ['second']);
  });

  it('legacy <id>.yml trash files still load and are removed only for the matching row', async () => {
    const dir = await freshDir('gittrash-legacy');
    const s = new GitYamlStorage(dir, { autoCommit: false });
    await mkdir(path.join(dir, 'trash', 'default'), { recursive: true });
    const legacy = card('old', { deleted_at: '2026-01-05T00:00:00.000Z' });
    await writeFile(path.join(dir, 'trash', 'default', 'old.yml'), yaml.stringify(s.serializeCard(legacy, 'READY')));
    const rows = await s.loadTrash();
    assert.deepEqual(rows.map((r) => r.id), ['old']);
    await s.trashRemove(card('old', { deleted_at: '2026-03-01T00:00:00.000Z' }));
    assert.ok(existsSync(path.join(dir, 'trash', 'default', 'old.yml')), 'other row: legacy file kept');
    await s.trashRemove(rows[0]);
    assert.equal(existsSync(path.join(dir, 'trash', 'default', 'old.yml')), false);
  });

  it('delete, re-create and delete again keeps both trash rows across a restart', async () => {
    const gitDir = await freshDir('gittrash-store');
    const dataDir = await freshDir('gittrash-store-data');
    await execFileAsync('git', ['init', '-q'], { cwd: gitDir });
    await execFileAsync('git', ['config', 'user.name', 'Durability Test'], { cwd: gitDir });
    await execFileAsync('git', ['config', 'user.email', 'durability@test.local'], { cwd: gitDir });
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: gitDir });
    process.env.KANBAN_STORAGE_BACKEND = 'git';
    process.env.KANBAN_GIT_DIR = gitDir;
    process.env.KANBAN_DATA_DIR = dataDir;
    process.env.KANBAN_DATA_FILE = path.join(dataDir, 'tasks.json');
    try {
      store.setStorage(null);
      await store.loadStore();
      for (const title of ['first', 'second']) {
        const c = await store.createTask({ id: 'twice', title, status: 'READY', round: 1 }, undefined, { caller: ADMIN });
        assert.equal(c.status, 201, c.error);
        await new Promise((r) => setTimeout(r, 5)); // distinct deletion times
        const d = await store.deleteTask('twice', { caller: ADMIN });
        assert.equal(d.status, 200, d.error);
      }
      store.setStorage(null);
      await store.loadStore();
      const rows = store.getTrashedTasks('default').filter((t) => t.id === 'twice');
      assert.deepEqual(rows.map((r) => r.title).sort(), ['first', 'second']);
    } finally {
      process.env.KANBAN_DATA_DIR = path.join(tmpRoot, 'default-data');
      process.env.KANBAN_DATA_FILE = path.join(tmpRoot, 'default-data', 'tasks.json');
      delete process.env.KANBAN_STORAGE_BACKEND;
      delete process.env.KANBAN_GIT_DIR;
      store.setStorage(null);
    }
  });
});

// ---------------------------------------------------------------------------
describe('journal generations', { concurrency: 1 }, () => {
  before(() => { process.env.KANBAN_STORAGE_JOURNAL = '1'; });
  after(() => { delete process.env.KANBAN_STORAGE_JOURNAL; });

  const task = (id, version) => ({ id, title: `${id} v${version}`, status: 'READY', round: 1, version });
  const pastBase = async (journal, base) => {
    // Journal mtime one hour BEFORE the base, as after a backwards clock step.
    const t = (Date.now() - 3_600_000) / 1000;
    await utimes(journal, t, t);
    const b = Date.now() / 1000;
    await utimes(base, b, b);
  };

  it('the base records a generation and every full write increments it', async () => {
    const dir = await freshDir('gen');
    const s = new JsonStorage(path.join(dir, 'tasks.json'), { isDefault: true });
    await s.save([task('g', 1)]);
    assert.equal(JSON.parse(await readFile(s.filePath, 'utf-8')).generation, 1);
    await s.save([task('g', 2)]);
    assert.equal(JSON.parse(await readFile(s.filePath, 'utf-8')).generation, 2);
    await s.saveTask(task('g', 3), [task('g', 3)]);
    const line = JSON.parse((await readFile(s.journalFile, 'utf-8')).trim());
    assert.equal(line.generation, 2, 'journal line tagged with the base generation');
  });

  it('a current journal is replayed even when its mtime is older than the base', async () => {
    const dir = await freshDir('gen-clock');
    const s = new JsonStorage(path.join(dir, 'tasks.json'), { isDefault: true });
    await s.save([task('c', 1)]);
    await s.saveTask(task('c', 2), [task('c', 2)]);
    await pastBase(s.journalFile, s.filePath);
    const loaded = await new JsonStorage(s.filePath, { isDefault: true }).load();
    assert.equal(loaded[0].version, 2);
    assert.ok(existsSync(s.journalFile), 'journal not moved aside');
  });

  it('journal lines from an earlier generation are ignored even when newer by mtime', async () => {
    const dir = await freshDir('gen-stale');
    const s = new JsonStorage(path.join(dir, 'tasks.json'), { isDefault: true });
    await s.save([task('s', 1)]);
    await s.saveTask(task('s', 5), [task('s', 5)]);
    const staleJournal = await readFile(s.journalFile, 'utf-8');
    // A full base write whose journal truncation did not happen.
    await s.save([task('s', 2)]);
    await writeFile(s.journalFile, staleJournal);
    const loaded = await new JsonStorage(s.filePath, { isDefault: true }).load();
    assert.equal(loaded[0].version, 2);
  });

  it('a legacy journal without generations still follows the mtime rule', async () => {
    const dir = await freshDir('gen-legacy');
    const base = path.join(dir, 'tasks.json');
    await writeFile(base, JSON.stringify({ tasks: [task('l', 1)] }));
    const journal = `${base}.journal.jsonl`;
    await writeFile(journal, JSON.stringify({ op: 'upsert', id: 'l', task: task('l', 2) }) + '\n');
    const t = (Date.now() + 10_000) / 1000;
    await utimes(journal, t, t);
    assert.equal((await new JsonStorage(base, { isDefault: true }).load())[0].version, 2, 'newer: replayed');

    await pastBase(journal, base);
    assert.equal((await new JsonStorage(base, { isDefault: true }).load())[0].version, 1, 'older: ignored');
    assert.ok((await readdir(dir)).some((f) => f.includes('.stale-')), 'older legacy journal moved aside');
  });

  it('journal appends and truncations are fsynced', async () => {
    const dir = await freshDir('fsync');
    const probe = await open(path.join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe);
    await probe.close();
    const realSync = proto.sync;
    let syncs = 0;
    proto.sync = function sync(...args) { syncs += 1; return realSync.apply(this, args); };
    try {
      const s = new JsonStorage(path.join(dir, 'tasks.json'), { isDefault: true });
      await s.save([task('f', 1)]);
      syncs = 0;
      await s.saveTask(task('f', 2), [task('f', 2)]);
      assert.ok(syncs >= 1, 'append fsynced');
      syncs = 0;
      await s.save([task('f', 3)]);
      assert.ok(syncs >= 2, 'base write and journal truncation fsynced');
      assert.equal(await readFile(s.journalFile, 'utf-8'), '');
    } finally {
      proto.sync = realSync;
    }
  });
});

// ---------------------------------------------------------------------------
describe('backups of a separate git card tree', { concurrency: 1 }, () => {
  async function listFiles(dir, prefix = '') {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...await listFiles(path.join(dir, e.name), rel));
      else out.push(rel);
    }
    return out.sort();
  }
  async function seedGit(gitDir) {
    await execFileAsync('git', ['init', '-q'], { cwd: gitDir });
    await mkdir(path.join(gitDir, 'atlas'), { recursive: true });
    await mkdir(path.join(gitDir, 'archive', 'default'), { recursive: true });
    await mkdir(path.join(gitDir, 'trash', 'default'), { recursive: true });
    await writeFile(path.join(gitDir, 'a.yml'), 'id: a\n');
    await writeFile(path.join(gitDir, 'settings.yml'), 'project: default\n');
    await writeFile(path.join(gitDir, 'atlas', 'b.yml'), 'id: b\n');
    await writeFile(path.join(gitDir, 'archive', 'default', 'c.yml'), 'id: c\n');
    await writeFile(path.join(gitDir, 'trash', 'default', 'd.20260101T000000000Z.yml'), 'id: d\n');
  }
  async function withEnv(env, fn) {
    const prev = {};
    for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
    try { return await fn(); } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }
  const EXPECTED = ['a.yml', 'archive/default/c.yml', 'atlas/b.yml', 'settings.yml', 'trash/default/d.20260101T000000000Z.yml'];

  it('snapshots the card tree without .git and restores it with --git-into', async () => {
    const base = await freshDir('gitbackup');
    const dataDir = path.join(base, 'data');
    const gitDir = path.join(base, 'cards');
    await mkdir(dataDir, { recursive: true });
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(dataDir, 'tasks.json'), JSON.stringify({ tasks: [] }));
    await seedGit(gitDir);
    await withEnv({
      KANBAN_STORAGE_BACKEND: 'git', KANBAN_GIT_DIR: gitDir, KANBAN_DATA_DIR: dataDir,
      KANBAN_DATA_FILE: path.join(dataDir, 'tasks.json'),
    }, () => store.runBackupNow());

    const stamps = (await readdir(path.join(dataDir, 'backups'))).sort();
    const snap = path.join(dataDir, 'backups', stamps[stamps.length - 1]);
    const manifest = JSON.parse(await readFile(path.join(snap, 'backup-manifest.json'), 'utf-8'));
    assert.deepEqual(manifest.git, { dir: path.resolve(gitDir), snapshot_dir: 'git-root' });
    const snapFiles = await listFiles(path.join(snap, 'git-root'));
    assert.deepEqual(snapFiles, EXPECTED);
    assert.ok(!snapFiles.some((f) => f.startsWith('.git/')), 'no .git in the snapshot');

    // Without --git-into the card tree stays out of the data dir.
    const into1 = path.join(base, 'restore1');
    const r1 = await execFileAsync(process.execPath, [RESTORE_SCRIPT, snap, '--into', into1]);
    assert.match(r1.stdout, /--git-into/);
    assert.equal(existsSync(path.join(into1, 'git-root')), false);

    const into2 = path.join(base, 'restore2');
    const gitInto = path.join(base, 'restored-cards');
    await execFileAsync(process.execPath, [RESTORE_SCRIPT, snap, '--into', into2, '--git-into', gitInto]);
    assert.deepEqual(await listFiles(gitInto), EXPECTED);
    assert.equal(existsSync(path.join(into2, 'git-root')), false);
    assert.ok(existsSync(path.join(into2, 'tasks.json')));
  });

  it('a git root inside the data dir is already covered and not duplicated', async () => {
    const base = await freshDir('gitbackup-inside');
    const dataDir = path.join(base, 'data');
    await mkdir(dataDir, { recursive: true });
    await seedGit(dataDir);
    await withEnv({
      KANBAN_STORAGE_BACKEND: 'git', KANBAN_GIT_DIR: dataDir, KANBAN_DATA_DIR: dataDir,
      KANBAN_DATA_FILE: path.join(dataDir, 'tasks.json'),
    }, () => store.runBackupNow());
    const stamps = (await readdir(path.join(dataDir, 'backups'))).sort();
    const snap = path.join(dataDir, 'backups', stamps[stamps.length - 1]);
    const manifest = JSON.parse(await readFile(path.join(snap, 'backup-manifest.json'), 'utf-8'));
    assert.equal(manifest.git, null);
    assert.equal(existsSync(path.join(snap, 'git-root')), false);
    assert.ok(existsSync(path.join(snap, 'atlas', 'b.yml')));
  });
});
