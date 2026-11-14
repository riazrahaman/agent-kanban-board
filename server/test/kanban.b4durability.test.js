/**
 * Batch 4 durability hardening: journal torn-tail repair, failed-append
 * rollback, best-effort compaction, git trash/restore bookkeeping and
 * discovery, git soft-delete commit, snapshot integrity, lease-only writes.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, appendFile, mkdir, chmod, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as store from '../store.js';
import { JsonStorage } from '../storage.js';
import { writeAtomic } from '../task-identity.js';

const ex = promisify(execFile);
const ENV = [
  'KANBAN_DATA_DIR', 'KANBAN_DATA_FILE', 'KANBAN_GIT_DIR', 'KANBAN_STORAGE_BACKEND',
  'KANBAN_GIT_COMMIT', 'KANBAN_STORAGE_JOURNAL', 'KANBAN_JOURNAL_COMPACT_BYTES',
  'KANBAN_BACKUP_ENABLED', 'KANBAN_BACKUP_DIR', 'KANBAN_DEFAULT_PROJECT', 'KANBAN_REAP_ENABLED',
];
const saved = {};
let tmpRoot;
let seq = 0;
const ADMIN = { agent_id: 'ops', role: 'admin' };
const T = (id, v, title) => ({ id, title, status: 'BACKLOG', round: 1, version: v, project: 'default' });

before(async () => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'kanban-b4dur-'));
  process.env.KANBAN_REAP_ENABLED = 'false';
});
after(async () => {
  store.stopReaper();
  store.setStorage(null);
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await rm(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
});

async function fresh(label) {
  const d = path.join(tmpRoot, `${label}-${++seq}`);
  await mkdir(d, { recursive: true });
  return d;
}
async function gitEnv(label) {
  const gitDir = await fresh(`${label}-git`);
  const dataDir = await fresh(`${label}-data`);
  await ex('git', ['init', '-q'], { cwd: gitDir });
  await ex('git', ['config', 'user.name', 't'], { cwd: gitDir });
  await ex('git', ['config', 'user.email', 't@x'], { cwd: gitDir });
  Object.assign(process.env, {
    KANBAN_STORAGE_BACKEND: 'git', KANBAN_GIT_DIR: gitDir, KANBAN_DATA_DIR: dataDir,
    KANBAN_DATA_FILE: path.join(dataDir, 'tasks.json'),
  });
  delete process.env.KANBAN_STORAGE_JOURNAL;
  store.setStorage(null);
  await store.loadStore();
  return { gitDir, dataDir };
}

describe('journal (COR-102 / COR-103)', () => {
  it('COR-102: a record appended after a torn tail survives a restart', async () => {
    const dir = await fresh('torn');
    process.env.KANBAN_STORAGE_JOURNAL = '1';
    const file = path.join(dir, 'tasks.json');
    const s1 = new JsonStorage(file, { isDefault: true });
    await s1.load();
    await s1.save([T('A', 1, 'a1')]);
    await s1.saveTask(T('A', 2, 'a2'), [T('A', 2, 'a2')]);
    await appendFile(`${file}.journal.jsonl`, '{"op":"upsert","id":"A","task":{"id":"A","ti');
    const s2 = new JsonStorage(file, { isDefault: true });
    await s2.load();
    await s2.saveTask(T('B', 1, 'b1'), [T('A', 2, 'a2'), T('B', 1, 'b1')]);
    const s3 = new JsonStorage(file, { isDefault: true });
    const ids = (await s3.load()).map((t) => `${t.id}:${t.title}`).sort();
    assert.deepEqual(ids, ['A:a2', 'B:b1']);
  });

  it('COR-103: a failed compaction does not fail an already-durable write, and a failed purge leaves nothing to replay', async () => {
    const dir = await fresh('compact');
    process.env.KANBAN_STORAGE_JOURNAL = '1';
    process.env.KANBAN_JOURNAL_COMPACT_BYTES = '1';
    const file = path.join(dir, 'tasks.json');
    const s = new JsonStorage(file, { isDefault: true });
    await s.load();
    await s.save([T('A', 1, 'a')]);
    const origWrite = s._writeCanonical.bind(s);
    s._writeCanonical = async () => { throw new Error('EACCES simulated'); };
    await s.saveTask(T('B', 1, 'b'), [T('A', 1, 'a'), T('B', 1, 'b')]); // must not throw
    await assert.rejects(() => s.deleteTask(T('A', 1, 'a'), [T('B', 1, 'b')]), /EACCES/);
    s._writeCanonical = origWrite;
    const s2 = new JsonStorage(file, { isDefault: true });
    const ids = (await s2.load()).map((t) => t.id).sort();
    assert.deepEqual(ids, ['A', 'B'], 'B was acknowledged; the failed delete of A must not replay');
    delete process.env.KANBAN_JOURNAL_COMPACT_BYTES;
    delete process.env.KANBAN_STORAGE_JOURNAL;
  });
});

describe('git backend (COR-101 / COR-104 / COR-107)', () => {
  it('COR-101: restore drops the row from in-memory trash, so a later restore is not stale', async () => {
    await gitEnv('restore');
    await store.createTask({ id: 'g1', title: 'v1', round: 1, status: 'BACKLOG' }, 'default', { caller: ADMIN });
    await store.deleteTask('g1', { caller: ADMIN });
    assert.equal((await store.restoreFromTrash('g1', { caller: ADMIN })).status, 200);
    assert.equal(store.getTrashedTasks('default').length, 0);
    await store.patchTask('g1', { title: 'v2' }, { caller: ADMIN });
    await store.deleteTask('g1', { caller: ADMIN });
    const r = await store.restoreFromTrash('g1', { caller: ADMIN });
    assert.equal(r.status, 200);
    assert.equal(r.task.title, 'v2');
  });

  it('COR-104: a named project with no live cards keeps its trash across a restart', async () => {
    await gitEnv('named');
    await store.createTask({ id: 'n1', title: 'named', round: 1, status: 'BACKLOG' }, 'atlas', { caller: ADMIN });
    await store.deleteTask('n1', { caller: ADMIN, project: 'atlas' });
    store.setStorage(null);
    await store.loadStore();
    assert.deepEqual(store.getTrashedTasks('atlas').map((t) => t.id), ['n1']);
    assert.equal((await store.restoreFromTrash('n1', { caller: ADMIN, project: 'atlas' })).status, 200);
  });

  it('COR-107: a soft delete is committed, so HEAD no longer holds the card', async () => {
    const { gitDir } = await gitEnv('softdel');
    await store.createTask({ id: 'd1', title: 'd', round: 1, status: 'BACKLOG' }, 'default', { caller: ADMIN });
    await store.createTask({ id: 'k1', title: 'k', round: 1, status: 'BACKLOG' }, 'default', { caller: ADMIN });
    await store.deleteTask('d1', { caller: ADMIN });
    const { stdout: tree } = await ex('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: gitDir });
    assert.ok(!tree.split('\n').some((f) => f.endsWith('d1.yml')), tree);
    assert.ok(tree.split('\n').some((f) => f.endsWith('k1.yml')), tree);
    const { stdout: st } = await ex('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: gitDir });
    assert.equal(st.trim(), '');
  });
});

describe('backups (COR-105 / COR-106)', () => {
  async function backupEnv(label) {
    const dir = await fresh(label);
    const backups = path.join(dir, 'backups');
    Object.assign(process.env, {
      KANBAN_DATA_DIR: dir, KANBAN_DATA_FILE: path.join(dir, 'tasks.json'),
      KANBAN_BACKUP_ENABLED: '1', KANBAN_BACKUP_DIR: backups,
    });
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_STORAGE_JOURNAL;
    store.setStorage(null);
    await store.loadStore();
    await store.createTask({ id: 'b1', title: 'b', round: 1, status: 'BACKLOG' }, 'default', { caller: ADMIN });
    return { dir, backups };
  }

  it('COR-105: transient temp files are skipped, and snapshots complete under concurrent atomic writes', async () => {
    const { dir, backups } = await backupEnv('bk');
    await writeFile(path.join(dir, '.tmp_123_abc'), 'x');
    let stop = false;
    const churn = (async () => {
      let i = 0;
      while (!stop) await writeAtomic(path.join(dir, 'churn', `f${i++ % 3}.json`), '{}');
    })();
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await store.runBackupNow();
    }
    stop = true;
    await churn;
    const snaps = (await readdir(backups)).filter((n) => /^\d{4}-/.test(n));
    assert.ok(snaps.length > 0);
    for (const sname of snaps) {
      const all = await readdir(path.join(backups, sname), { recursive: true });
      assert.ok(!all.some((n) => path.basename(n).startsWith('.tmp_')), 'no temp files in snapshot');
    }
  });

  it('COR-105: a missing non-temp file fails the snapshot and leaves no partial directory', async () => {
    const { dir, backups } = await backupEnv('bkfail');
    await mkdir(path.join(dir, 'zdir'), { recursive: true });
    await writeFile(path.join(dir, 'zdir', 'real.json'), '{}');
    const fsp = await import('node:fs/promises');
    // A dangling symlink is a listed entry whose copy hits ENOENT.
    await fsp.symlink(path.join(dir, 'nope'), path.join(dir, 'zdir', 'dangling.json'));
    await assert.rejects(() => store.runBackupNow());
    const left = (await readdir(backups).catch(() => [])).filter((n) => /^\d{4}-/.test(n));
    assert.deepEqual(left, []);
  });
});

describe('lease-only writes (PERF-101)', () => {
  it('writeAtomic(durable:false) still replaces the file atomically', async () => {
    const dir = await fresh('atomic');
    const f = path.join(dir, 'x.json');
    await writeAtomic(f, 'one');
    await writeAtomic(f, 'two', { durable: false });
    assert.equal(await readFile(f, 'utf-8'), 'two');
    assert.ok(!(await readdir(dir)).some((n) => n.startsWith('.tmp_')));
  });

  it('a heartbeat skips fsync but a real change keeps it', async () => {
    const dir = await fresh('hb');
    Object.assign(process.env, { KANBAN_DATA_DIR: dir, KANBAN_DATA_FILE: path.join(dir, 'tasks.json') });
    delete process.env.KANBAN_STORAGE_BACKEND;
    store.setStorage(null);
    await store.loadStore();
    await store.createTask({ id: 'h1', title: 'h', round: 1, status: 'READY' }, 'default', { caller: ADMIN });
    await store.claimTask('h1', 'agent-1', { caller: { agent_id: 'agent-1', role: 'builder' } });
    const fsp = await import('node:fs/promises');
    const probe = await fsp.open(path.join(dir, '.probe'), 'w');
    const FH = Object.getPrototypeOf(probe);
    await probe.close();
    const real = FH.sync;
    let syncs = 0;
    FH.sync = async function () { syncs++; return real.call(this); };
    try {
      const hb = await store.renewLease('h1', 'agent-1', { caller: { agent_id: 'agent-1', role: 'builder' } });
      assert.equal(hb.status, 200);
      assert.equal(syncs, 0, 'lease renewal must not fsync');
      await store.patchTask('h1', { title: 'changed' }, { caller: ADMIN });
      assert.ok(syncs >= 2, 'a real change keeps the fsync pair');
    } finally {
      FH.sync = real;
    }
  });
});
