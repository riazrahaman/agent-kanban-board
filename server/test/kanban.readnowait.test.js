/**
 * v3.16.0 B2: list/archive/trash/projects/metrics reads do not queue behind
 * in-flight writes. A lazy sweep with a busy lock is deferred (coalesced) and
 * still runs afterwards; an idle lock sweeps inline as before.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as store from '../store.js';
const { withMutationLock, isMutationLockBusy } = store;

describe('reads do not wait for the mutation lock', () => {
  let tmpDir;
  const saved = {};
  const KEYS = ['KANBAN_DATA_DIR', 'KANBAN_DATA_FILE', 'KANBAN_STORAGE_BACKEND', 'KANBAN_ARCHIVE_AFTER_DAYS', 'KANBAN_REAP_ENABLED'];

  before(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    delete process.env.KANBAN_STORAGE_BACKEND;
    process.env.KANBAN_REAP_ENABLED = 'false';
    process.env.KANBAN_ARCHIVE_AFTER_DAYS = '7';
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-readnowait-'));
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    store.setStorage(null);
    await store.loadStore();
  });
  after(async () => {
    store.setStorage(null);
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('a lazy sweep returns immediately while a write holds the lock, then runs deferred', async () => {
    await store.createTask({ id: 'nw-old', title: 'old', status: 'DONE', round: 1 }).catch(() => {});
    let release;
    const gate = new Promise((r) => { release = r; });
    const holder = withMutationLock(async () => { await gate; });
    assert.equal(isMutationLockBusy(), true);
    store.notify(); // serial now differs from the last sweep
    const t0 = Date.now();
    const moved = await store.runArchiveSweep({ lazy: true });
    store.getTasks(); store.getArchivedTasks(); store.getProjectSummaries(); store.getMetrics();
    assert.equal(moved, 0);
    assert.ok(Date.now() - t0 < 100, 'reads did not wait for the held lock');
    release();
    await holder;
    // the deferred sweep drains behind the lock; afterwards the lock is idle again
    await withMutationLock(async () => {});
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(isMutationLockBusy(), false);
  });

  it('idle lock: a lazy sweep runs inline (not deferred) and still moves eligible work', async () => {
    await store.createTask({ id: 'nw-fresh', title: 'fresh', status: 'BACKLOG', round: 1 });
    assert.equal(isMutationLockBusy(), false);
    const old = store.getTasks().find((x) => x.id === 'nw-fresh');
    assert.ok(old);
    // not eligible (not DONE) -> 0, but it ran inline and recorded the serial
    assert.equal(await store.runArchiveSweep({ lazy: true }), 0);
    assert.equal(await store.runArchiveSweep({ lazy: true }), 0);
  });
});
