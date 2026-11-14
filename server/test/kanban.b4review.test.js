/**
 * Batch 4 review follow-ups: a rejected journal mutation is never replayed
 * even when the rollback itself fails, and retiring a journal always gets the
 * full fsync pair.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, chmod, open, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStorage } from '../storage.js';
import * as store from '../store.js';

let tmpRoot;
let seq = 0;
const T = (id, v, title) => ({ id, title, status: 'BACKLOG', round: 1, version: v, project: 'default' });
const saved = {};

before(async () => {
  for (const k of ['KANBAN_STORAGE_JOURNAL', 'KANBAN_JOURNAL_COMPACT_BYTES']) { saved[k] = process.env[k]; delete process.env[k]; }
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'kanban-b4review-'));
});
after(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
});

async function fresh(label) {
  const d = path.join(tmpRoot, `${label}-${++seq}`);
  await mkdir(d, { recursive: true });
  return d;
}
async function fileHandleProto(dir) {
  const probe = await open(path.join(dir, '.probe'), 'w');
  const FH = Object.getPrototypeOf(probe);
  await probe.close();
  return FH;
}
const ids = async (file) => (await new JsonStorage(file, { isDefault: true }).load()).map((t) => t.id).sort();

describe('COR-103 rollback failure', () => {
  it('append fails and truncate fails: the journal is restored by atomic replacement', async () => {
    process.env.KANBAN_STORAGE_JOURNAL = '1';
    const dir = await fresh('rb1');
    const file = path.join(dir, 'tasks.json');
    const s = new JsonStorage(file, { isDefault: true });
    await s.load();
    await s.save([T('A', 1, 'a')]);
    await s.saveTask(T('A', 2, 'a2'), [T('A', 2, 'a2')]);
    const FH = await fileHandleProto(dir);
    const realSync = FH.sync; const realTrunc = FH.truncate;
    let first = true;
    FH.sync = async function () { if (first) { first = false; throw new Error('EIO simulated'); } return realSync.call(this); };
    FH.truncate = async function () { throw new Error('truncate failed'); };
    try {
      await assert.rejects(() => s.saveTask(T('B', 1, 'b'), [T('A', 2, 'a2'), T('B', 1, 'b')]), /EIO/);
    } finally { FH.sync = realSync; FH.truncate = realTrunc; }
    assert.deepEqual(await ids(file), ['A'], 'rejected create must not appear after restart');
  });

  it('append fails and every rollback fails: the storage refuses journal appends loudly', async (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return t.skip('root ignores directory permissions');
    process.env.KANBAN_STORAGE_JOURNAL = '1';
    const dir = await fresh('rb2');
    const file = path.join(dir, 'tasks.json');
    const s = new JsonStorage(file, { isDefault: true });
    await s.load();
    await s.save([T('A', 1, 'a')]);
    await s.saveTask(T('A', 2, 'a2'), [T('A', 2, 'a2')]);
    const FH = await fileHandleProto(dir);
    const realSync = FH.sync; const realTrunc = FH.truncate;
    let first = true;
    FH.sync = async function () { if (first) { first = false; throw new Error('EIO simulated'); } return realSync.call(this); };
    FH.truncate = async function () { throw new Error('truncate failed'); };
    await chmod(dir, 0o555); // no temp file can be created, so the fallback fails too
    try {
      await assert.rejects(() => s.saveTask(T('B', 1, 'b'), [T('A', 2, 'a2'), T('B', 1, 'b')]), /EIO/);
      await assert.rejects(() => s.saveTask(T('C', 1, 'c'), [T('C', 1, 'c')]), /journal unusable/);
    } finally { await chmod(dir, 0o755); FH.sync = realSync; FH.truncate = realTrunc; }
    // Restart before recovery: the rejected record may replay, and the 503 told the caller so.
    assert.deepEqual(await ids(file), ['A', 'B']);
    // A full rewrite supersedes the journal and clears the refusal.
    await s.save([T('A', 2, 'a2')]);
    await s.saveTask(T('D', 1, 'd'), [T('A', 2, 'a2'), T('D', 1, 'd')]);
    assert.deepEqual(await ids(file), ['A', 'D']);
  });

  it('append, truncate and prefix replacement all fail: a canonical rewrite without the record supersedes it', async () => {
    process.env.KANBAN_STORAGE_JOURNAL = '1';
    const dir = await fresh('rb4');
    const file = path.join(dir, 'tasks.json');
    const s = new JsonStorage(file, { isDefault: true });
    await s.load();
    await s.save([T('A', 1, 'a')]);
    await s.saveTask(T('A', 2, 'a2'), [T('A', 2, 'a2')]);
    const FH = await fileHandleProto(dir);
    const realSync = FH.sync; const realTrunc = FH.truncate;
    let failures = 2; // the append fsync, then the prefix replacement's file fsync
    FH.sync = async function () { if (failures > 0) { failures--; throw new Error('EIO simulated'); } return realSync.call(this); };
    FH.truncate = async function () { throw new Error('truncate failed'); };
    try {
      await assert.rejects(() => s.saveTask(T('C', 1, 'c'), [T('A', 2, 'a2'), T('C', 1, 'c')]), /EIO/);
    } finally { FH.sync = realSync; FH.truncate = realTrunc; }
    const s2 = new JsonStorage(file, { isDefault: true });
    assert.deepEqual((await s2.load()).map((t) => `${t.id}:${t.version}`), ['A:2'], 'rejected record C must be gone after restart');
    // The refusal was cleared by the rewrite: appends work again.
    await s2.saveTask(T('D', 1, 'd'), [T('A', 2, 'a2'), T('D', 1, 'd')]);
    assert.deepEqual(await ids(file), ['A', 'D']);
  });

  it('delete rewrite fails and truncate fails: the rejected delete is not replayed', async () => {
    process.env.KANBAN_STORAGE_JOURNAL = '1';
    const dir = await fresh('rb3');
    const file = path.join(dir, 'tasks.json');
    const s = new JsonStorage(file, { isDefault: true });
    await s.load();
    await s.save([T('A', 1, 'a'), T('B', 1, 'b')]);
    await s.saveTask(T('B', 2, 'b2'), [T('A', 1, 'a'), T('B', 2, 'b2')]);
    const FH = await fileHandleProto(dir);
    const realTrunc = FH.truncate;
    FH.truncate = async function () { throw new Error('truncate failed'); };
    const realCanon = s._writeCanonical.bind(s);
    s._writeCanonical = async () => { throw new Error('EACCES simulated'); };
    try {
      await assert.rejects(() => s.deleteTask(T('A', 1, 'a'), [T('B', 2, 'b2')]), /EACCES/);
    } finally { FH.truncate = realTrunc; s._writeCanonical = realCanon; }
    assert.deepEqual(await ids(file), ['A', 'B']);
  });
});

describe('PERF-101 journal retirement', () => {
  it('a lease-only write that retires an existing journal keeps the file and directory fsync', async () => {
    const dir = await fresh('retire');
    const file = path.join(dir, 'tasks.json');
    process.env.KANBAN_STORAGE_JOURNAL = '1';
    const s1 = new JsonStorage(file, { isDefault: true });
    await s1.load();
    await s1.save([T('A', 1, 'a')]);
    await s1.saveTask(T('B', 1, 'b'), [T('A', 1, 'a'), T('B', 1, 'b')]);
    delete process.env.KANBAN_STORAGE_JOURNAL;
    const s2 = new JsonStorage(file, { isDefault: true });
    const loaded = await s2.load();
    assert.deepEqual(loaded.map((t) => t.id).sort(), ['A', 'B']);
    const FH = await fileHandleProto(dir);
    const realSync = FH.sync; let syncs = 0;
    FH.sync = async function () { syncs++; return realSync.call(this); };
    try {
      await s2.saveTasks([loaded[0]], loaded, { syncDir: false });
    } finally { FH.sync = realSync; }
    assert.equal(syncs, 2, 'journal retirement forces the full fsync pair');
    assert.ok(!existsSync(`${file}.journal.jsonl`));
    assert.deepEqual(await ids(file), ['A', 'B']);
    // Without a journal the lease-only mode still skips the directory fsync.
    FH.sync = async function () { syncs++; return realSync.call(this); };
    syncs = 0;
    try { await s2.saveTasks([loaded[0]], loaded, { syncDir: false }); } finally { FH.sync = realSync; }
    assert.equal(syncs, 1);
  });
});

describe('COR-103 unknown outcome reconciles memory to what a restart loads', () => {
  const caller = { agent_id: 'ops', role: 'admin' };
  const holder = { agent_id: 'agent-1', role: 'builder' };
  const envKeys = ['KANBAN_DATA_FILE', 'KANBAN_DATA_DIR', 'KANBAN_REAP_ENABLED', 'KANBAN_CLAIM_TTL_MS'];
  const envSaved = {};
  let file; let dir;

  before(() => { for (const k of envKeys) envSaved[k] = process.env[k]; });
  after(() => {
    store.stopReaper();
    store.setStorage(null);
    for (const k of envKeys) { if (envSaved[k] === undefined) delete process.env[k]; else process.env[k] = envSaved[k]; }
  });

  async function boot(label) {
    process.env.KANBAN_STORAGE_JOURNAL = '1';
    dir = await fresh(label);
    file = path.join(dir, 'tasks.json');
    Object.assign(process.env, { KANBAN_DATA_FILE: file, KANBAN_DATA_DIR: dir, KANBAN_REAP_ENABLED: 'false', KANBAN_CLAIM_TTL_MS: '60000' });
    store.setStorage(null);
    await store.loadStore();
  }
  const create = (id, status = 'BACKLOG') => store.createTask({ id, title: id, round: 1, status }, 'default', { caller });
  const restartView = async () => {
    const list = await new JsonStorage(file, { isDefault: true }).load();
    return new Map(list.map((t) => [t.id, t]));
  };
  /** Every sync and truncate fails, and so does every non-journal write. */
  async function injectTotalFailure({ journalWrite } = {}) {
    const FH = await fileHandleProto(dir);
    const orig = { sync: FH.sync, truncate: FH.truncate, writeFile: FH.writeFile };
    let journalWrites = 0;
    FH.sync = async function () { throw new Error('EIO simulated'); };
    FH.truncate = async function () { throw new Error('truncate failed'); };
    FH.writeFile = async function (data, enc) {
      journalWrites += 1;
      if (journalWrites === 1 && journalWrite) {
        const payload = Buffer.from(data, enc);
        await orig.writeFile.call(this, payload.subarray(0, journalWrite(payload)));
        throw new Error('ENOSPC simulated (partial write)');
      }
      if (journalWrites === 1) return orig.writeFile.call(this, data, enc); // the journal append reaches the disk
      throw new Error('ENOSPC simulated');
    };
    return () => { FH.sync = orig.sync; FH.truncate = orig.truncate; FH.writeFile = orig.writeFile; };
  }

  it('a fully written record is applied: 503, memory, broadcast and restart agree', async () => {
    await boot('u1');
    await create('A');
    let changes = 0;
    const events = [];
    const off1 = store.onChange(() => { changes++; });
    const off2 = store.onDiff((e) => events.push(e));
    const restore = await injectTotalFailure();
    let res;
    try { res = await create('C'); } finally { restore(); off1(); off2(); }
    assert.equal(res.status, 503);
    assert.match(res.error, /may have been applied/);
    assert.match(res.error, /Re-read the task/);
    assert.ok(store.getTask('C', 'default'));
    assert.ok(changes > 0, 'subscribers were notified');
    assert.ok(events.some((e) => e.kind === 'created' && e.task.id === 'C'), 'diff event for the applied task');
    assert.deepEqual([...(await restartView()).keys()].sort(), store.getTasks().map((t) => t.id).sort());
  });

  it('a partially written record is NOT applied: memory still equals restart', async () => {
    await boot('u2');
    await create('A');
    const restore = await injectTotalFailure({ journalWrite: () => 40 });
    let res;
    try { res = await create('C'); } finally { restore(); }
    assert.equal(res.status, 503);
    assert.equal(store.getTask('C', 'default') ?? null, null, 'C never reached the disk in replayable form');
    assert.deepEqual([...(await restartView()).keys()].sort(), store.getTasks().map((t) => t.id).sort());
  });

  it('a partial batch applies only the records that reached the disk', async () => {
    await boot('u3');
    await create('h1', 'READY');
    await create('h2', 'READY');
    assert.equal((await store.claimTask('h1', 'agent-1', 'default', { caller: holder })).status, 200);
    assert.equal((await store.claimTask('h2', 'agent-1', 'default', { caller: holder })).status, 200);
    const before1 = store.getTask('h1', 'default').claim_expires_at;
    const before2 = store.getTask('h2', 'default').claim_expires_at;
    // First journal line (the primary) reaches the disk, the sibling's does not.
    const restore = await injectTotalFailure({ journalWrite: (buf) => buf.indexOf(10) + 1 });
    let res;
    try { res = await store.renewLease('h1', 'agent-1', { caller: holder, project: 'default' }); } finally { restore(); }
    assert.equal(res.status, 503);
    const disk = await restartView();
    for (const id of ['h1', 'h2']) {
      assert.equal(store.getTask(id, 'default').claim_expires_at, disk.get(id).claim_expires_at, `${id}: memory equals restart`);
    }
    assert.notEqual(store.getTask('h1', 'default').claim_expires_at, before1, 'primary renewal applied');
    assert.equal(store.getTask('h2', 'default').claim_expires_at, before2, 'sibling that never reached disk is not applied');
  });

  it('the reaper does not swallow an unknown outcome', async () => {
    await boot('u4');
    await create('r1', 'READY');
    assert.equal((await store.claimTask('r1', 'agent-1', 'default', { caller: holder })).status, 200);
    let changes = 0;
    const off = store.onChange(() => { changes++; });
    const restore = await injectTotalFailure();
    let res;
    try { res = await store.reapExpiredClaims({ now: Date.now() + 10 * 60_000 }); } finally { restore(); }
    off();
    assert.equal(res.status, 503, 'the sweep reports the unknown outcome');
    const mem = store.getTask('r1', 'default');
    const disk = (await restartView()).get('r1');
    assert.equal(mem.status, disk.status, 'memory equals restart');
    assert.equal(mem.status, 'READY');
    assert.ok(changes > 0, 'the applied reclaim was broadcast');
  });
});
