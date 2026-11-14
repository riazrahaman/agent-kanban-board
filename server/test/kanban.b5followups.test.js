/**
 * Batch 5 follow-ups: an applied-unknown persist keeps its semantic event kind
 * and actor in the fallback broadcast, and a card whose restore was interrupted
 * keeps its spilled history reachable.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStorage } from '../storage.js';
import * as store from '../store.js';
import { spillFile } from '../store/core.js';

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

describe('applied-unknown follow-ups', () => {
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

  it('restore failure broadcasts the restored (created) kind with the admin actor', async () => {
    await boot('f1');
    await create('A');
    assert.equal((await store.deleteTask('A', { caller })).status, 200);
    const events = [];
    const off = store.onDiff((e) => events.push(e));
    const restore = await injectTotalFailure();
    let res;
    try { res = await store.restoreFromTrash('A', { caller }); } finally { restore(); off(); }
    assert.equal(res.status, 503);
    assert.equal(events.filter((e) => e.task && e.task.id === 'A').length, 1, 'exactly one event');
    const ev = events.find((e) => e.task && e.task.id === 'A');
    assert.ok(ev, 'a diff event was broadcast');
    assert.equal(ev.kind, 'created');
    assert.equal(ev.actor, 'ops');
    assert.equal(ev.reason, 'restored');
  });

  it('a claim whose persist outcome is unknown broadcasts claimed with the claimant as actor', async () => {
    await boot('f2');
    await create('c1', 'READY');
    const events = [];
    const off = store.onDiff((e) => events.push(e));
    const restore = await injectTotalFailure();
    let res;
    try { res = await store.claimTask('c1', 'agent-1', 'default', { caller: holder }); } finally { restore(); off(); }
    assert.equal(res.status, 503);
    assert.equal(events.filter((e) => e.task && e.task.id === 'c1').length, 1, 'exactly one event');
    const ev = events.find((e) => e.task && e.task.id === 'c1');
    assert.ok(ev, 'a diff event was broadcast');
    assert.equal(ev.kind, 'claimed');
    assert.equal(ev.actor, 'agent-1');
  });

  it('history of a restored card stays readable (and after a later write)', async () => {
    await boot('f3');
    await create('H');
    const live = spillFile('default', 'H');
    await mkdir(path.dirname(live), { recursive: true });
    await writeFile(live, JSON.stringify({ type: 'log', message: 'old-1' }) + '\n' + JSON.stringify({ type: 'log', message: 'old-2' }) + '\n');
    assert.equal((await store.deleteTask('H', { caller })).status, 200);
    assert.ok(!existsSync(live), 'sidecar parked under trash');
    const restore = await injectTotalFailure();
    let res;
    try { res = await store.restoreFromTrash('H', { caller }); } finally { restore(); }
    assert.equal(res.status, 503);
    assert.ok(store.getTask('H', 'default'), 'card is live');
    assert.ok(!existsSync(live), 'live sidecar still missing (move never ran)');
    const logs = await store.getTaskLogs('H', 'default', { include_spilled: true });
    assert.equal(logs.spilled_count, 2, 'history reachable through the parked copy');
    assert.deepEqual(logs.entries.map((e) => e.message), ['old-1', 'old-2']);
    store.setStorage(null); // fresh storage instance, as after the disk problem is freed
    // A later successful write keeps the history reachable.
    assert.equal((await store.appendLog('H', 'agent-1', 'hello', 'default')).status ?? 200, 200);
    const again = await store.getTaskLogs('H', 'default', { include_spilled: true });
    assert.equal(again.spilled_count, 2);
  });

  it('a different card reusing the id does not inherit parked history', async () => {
    await boot('f4');
    await create('R');
    const live = spillFile('default', 'R');
    await mkdir(path.dirname(live), { recursive: true });
    await writeFile(live, JSON.stringify({ type: 'log', message: 'x' }) + '\n');
    assert.equal((await store.deleteTask('R', { caller })).status, 200);
    await create('R');
    const logs = await store.getTaskLogs('R', 'default', { include_spilled: true });
    assert.equal(logs.spilled_count, 0);
  });

  /** Make the storage report an unknown outcome in which only `appliedIds` reached the disk. */
  function injectPartialUnknown(appliedIds) {
    const real = store.getStorage('default');
    const fake = Object.create(real);
    fake.saveTasks = async (changed) => {
      const err = new Error('unknown outcome (test)');
      err.outcomeUnknown = true;
      err.changedTasks = changed.filter((t) => appliedIds.includes(t.id));
      throw err;
    };
    store.setStorage(fake, 'default');
    return () => store.setStorage(real, 'default');
  }

  it('a sibling-only applied renewal is broadcast exactly once', async () => {
    await boot('f5');
    await create('h1', 'READY');
    await create('h2', 'READY');
    await store.claimTask('h1', 'agent-1', 'default', { caller: holder });
    await store.claimTask('h2', 'agent-1', 'default', { caller: holder });
    const events = [];
    const off = store.onDiff((e) => events.push(e));
    const restore = injectPartialUnknown(['h2']);
    let res;
    try { res = await store.renewLease('h1', 'agent-1', { caller: holder, project: 'default' }); } finally { restore(); off(); }
    assert.equal(res.status, 503);
    const renewed = events.filter((e) => e.task && e.task.id === 'h2');
    assert.equal(renewed.length, 1, 'one event for the applied sibling');
    assert.equal(renewed[0].kind, 'renewed');
    assert.equal(renewed[0].actor, 'agent-1');
    assert.equal(events.filter((e) => e.task && e.task.id === 'h1').length, 0);
  });

  async function interruptedRestore(id) {
    await create(id);
    const live = spillFile('default', id);
    await mkdir(path.dirname(live), { recursive: true });
    await writeFile(live, JSON.stringify({ type: 'log', message: 'old-1' }) + '\n' + JSON.stringify({ type: 'log', message: 'old-2' }) + '\n');
    assert.equal((await store.deleteTask(id, { caller })).status, 200);
    const restore = await injectTotalFailure();
    try { assert.equal((await store.restoreFromTrash(id, { caller })).status, 503); } finally { restore(); }
    store.setStorage(null); // the disk problem is gone: fresh storage instance
    assert.ok(!existsSync(live));
    assert.equal((await store.getTaskLogs(id, 'default', { include_spilled: true })).spilled_count, 2);
    return live;
  }

  it('purging the stale trash row keeps the live restored card history', async () => {
    await boot('f6');
    const live = await interruptedRestore('P');
    assert.equal((await store.hardDeleteFromTrash('P', { caller })).status, 200);
    assert.ok(existsSync(live), 'history moved back to the live location');
    assert.equal((await store.getTaskLogs('P', 'default', { include_spilled: true })).spilled_count, 2);
  });

  it('the retention sweep keeps the live restored card history', async () => {
    await boot('f7');
    const live = await interruptedRestore('S');
    const realNow = Date.now;
    Date.now = () => realNow() + 60 * 86400000;
    let out;
    try { out = await store.runTrashSweep(); } finally { Date.now = realNow; }
    assert.deepEqual(out.purged, ['default/S']);
    assert.ok(existsSync(live));
    assert.equal((await store.getTaskLogs('S', 'default', { include_spilled: true })).spilled_count, 2);
  });

  it('a spill write past the cap repairs the parked history', async () => {
    const savedCap = process.env.KANBAN_INLINE_LOG_CAP;
    process.env.KANBAN_INLINE_LOG_CAP = '1';
    try {
      await boot('f8');
      const live = await interruptedRestore('W');
      assert.equal((await store.appendLog('W', 'agent-1', 'one', 'default')).status ?? 200, 200);
      assert.equal((await store.appendLog('W', 'agent-1', 'two', 'default')).status ?? 200, 200);
      assert.ok(existsSync(live), 'parked history moved back before the new spill entry');
      const logs = await store.getTaskLogs('W', 'default', { include_spilled: true });
      assert.ok(logs.spilled_count >= 3);
      assert.deepEqual(logs.entries.slice(0, 2).map((e) => e.message), ['old-1', 'old-2']);
    } finally {
      if (savedCap === undefined) delete process.env.KANBAN_INLINE_LOG_CAP; else process.env.KANBAN_INLINE_LOG_CAP = savedCap;
    }
  });

  it('an already-broadcast card is not replayed by the fallback broadcast', async () => {
    await boot('f9');
    await create('D', 'DONE');
    for (const id of ['B1', 'B2']) {
      assert.equal((await store.createTask({ id, title: id, round: 1, status: 'BLOCKED', depends_on: ['D'] }, 'default', { caller })).status, 201);
    }
    const real = store.getStorage('default');
    const fake = Object.create(real);
    fake.saveTask = async (task) => {
      const err = new Error('unknown outcome (test)');
      err.outcomeUnknown = true;
      err.changedTasks = task.id === 'B1' ? [task] : [];
      throw err;
    };
    store.setStorage(fake, 'default');
    const events = [];
    const off = store.onDiff((e) => events.push(e));
    let res;
    try { res = await store.maybeUnlockDependents('D', { project: 'default' }); } finally { store.setStorage(real, 'default'); off(); }
    assert.equal(res.status, 503);
    assert.equal(events.filter((e) => e.task.id === 'B1' && e.kind === 'unblocked').length, 1, 'B1 unblocked exactly once');
    assert.equal(events.filter((e) => e.task.id === 'B2').length, 0, 'B2 never applied');
  });

  /** Leaves an interrupted restore plus a separate live sidecar (both files exist). */
  async function bothFiles(id) {
    const live = await interruptedRestore(id);
    await writeFile(live, JSON.stringify({ type: 'log', message: 'live-1' }) + '\n');
    const logs = await store.getTaskLogs(id, 'default', { include_spilled: true });
    assert.deepEqual(logs.entries.map((e) => e.message), ['old-1', 'old-2', 'live-1'], 'reads span both files');
    return live;
  }
  const messages = async (live) => (await readFile(live, 'utf-8')).split('\n').filter(Boolean).map((l) => JSON.parse(l).message);

  it('both-files case merges on hard-delete with no loss', async () => {
    await boot('f10');
    const live = await bothFiles('M1');
    assert.equal((await store.hardDeleteFromTrash('M1', { caller })).status, 200);
    assert.deepEqual(await messages(live), ['old-1', 'old-2', 'live-1']);
  });

  it('both-files case merges on the retention sweep with no loss', async () => {
    await boot('f11');
    const live = await bothFiles('M2');
    const realNow = Date.now;
    Date.now = () => realNow() + 60 * 86400000;
    try { await store.runTrashSweep(); } finally { Date.now = realNow; }
    assert.deepEqual(await messages(live), ['old-1', 'old-2', 'live-1']);
  });

  it('a failed merge keeps the trash row and the parked history', async () => {
    await boot('f12');
    const live = await bothFiles('M3');
    const fsp = await import('node:fs/promises');
    const parkedBefore = store.getTrashedTasks('default').length;
    // Block the temp merge target with a directory so the swap cannot happen.
    await mkdir(`${live}.merge.tmp`);
    const res = await store.hardDeleteFromTrash('M3', { caller });
    assert.equal(res.status, 500);
    assert.equal(store.getTrashedTasks('default').length, parkedBefore, 'row kept');
    assert.equal((await store.getTaskLogs('M3', 'default', { include_spilled: true })).spilled_count, 3);
    await fsp.rm(`${live}.merge.tmp`, { recursive: true });
    assert.equal((await store.hardDeleteFromTrash('M3', { caller })).status, 200, 'retry works');
    assert.deepEqual(await messages(live), ['old-1', 'old-2', 'live-1']);
  });

  it('a failed repair move fails the spill append instead of splitting history', async () => {
    const savedCap = process.env.KANBAN_INLINE_LOG_CAP;
    process.env.KANBAN_INLINE_LOG_CAP = '1';
    try {
      await boot('f13');
      const live = await interruptedRestore('X');
      // A directory where the live file is needed makes the rename fail.
      await mkdir(live);
      await assert.rejects(async () => {
        await store.appendLog('X', 'agent-1', 'one', 'default');
        await store.appendLog('X', 'agent-1', 'two', 'default');
      });
      await rm(live, { recursive: true });
      const logs = await store.getTaskLogs('X', 'default', { include_spilled: true });
      assert.deepEqual(logs.entries.map((e) => e.message), ['old-1', 'old-2'], 'history intact');
    } finally {
      if (savedCap === undefined) delete process.env.KANBAN_INLINE_LOG_CAP; else process.env.KANBAN_INLINE_LOG_CAP = savedCap;
    }
  });
});
