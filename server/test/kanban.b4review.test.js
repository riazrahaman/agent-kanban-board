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
    // A full rewrite supersedes the journal and clears the refusal.
    await s.save([T('A', 2, 'a2')]);
    await s.saveTask(T('D', 1, 'd'), [T('A', 2, 'a2'), T('D', 1, 'd')]);
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
