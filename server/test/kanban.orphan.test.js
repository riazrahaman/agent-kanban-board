import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'kanban-orphan-token';

describe('KB-orphan: ownerless active-task normalization (§2.4 reaper)', () => {
  let tmpDir;
  let server;
  let realNow;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    // Reaper timer must NEVER start in these tests.
    process.env.KANBAN_REAP_ENABLED = 'false';
    realNow = () => Date.now();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-orphan-'));
    store.setStorage(null);
    store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
    await store.loadStore();
    assert.equal(store.isReaperRunning(), false, 'createApp must not start the reaper timer');
    await new Promise((resolve) => {
      server = createApp().listen(0, '127.0.0.1', resolve);
      });
     });

  after(async () => {
    store.stopReaper();
    store.setNowFn(realNow);
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_REAP_ENABLED;
    store.setStorage(null);
     });

  it('1. createTask with an active status and no owner stays ownerless-active', async () => {
    await store.createTask({ id: 'orph-1', title: 'Orphan build', status: 'BUILDING', round: 1 });
    const t = store.getTask('orph-1');
    assert.equal(t.status, 'BUILDING', 'active status preserved');
    assert.equal(t.assigned_agent, null, 'no owner');
    assert.ok(t.claim_expires_at === null || t.claim_expires_at === undefined, 'no lease');
     });

  it('2. reapExpiredClaims moves an ownerless BUILDING task to BACKLOG', async () => {
    const res = await store.reapExpiredClaims({ now: Date.now() });
    assert.ok(res.reclaimed.includes('default/orph-1'), 'ownerless BUILDING task reclaimed');
    const t = store.getTask('orph-1');
    assert.equal(t.status, 'BACKLOG', 'status normalized to BACKLOG');
    assert.equal(t.assigned_agent, null, 'owner stays null');
    assert.equal(t.claim_expires_at, null, 'lease cleared');
    assert.ok(t.version > 1, 'version bumped');
    assert.equal(t.reclaim_count, 1, 'reclaim_count incremented');
     });

  it('3. IN_REVIEW and IN_TEST ownerless tasks are normalized too', async () => {
    await store.createTask({ id: 'orph-ir', title: 'Orphan review', status: 'IN_REVIEW', round: 1 });
    await store.createTask({ id: 'orph-it', title: 'Orphan test', status: 'IN_TEST', round: 1 });
    const res = await store.reapExpiredClaims({ now: Date.now() });
    assert.ok(res.reclaimed.includes('default/orph-ir'), 'IN_REVIEW orphan reclaimed');
    assert.ok(res.reclaimed.includes('default/orph-it'), 'IN_TEST orphan reclaimed');
    assert.equal(store.getTask('orph-ir').status, 'BACKLOG');
    assert.equal(store.getTask('orph-it').status, 'BACKLOG');
     });

  it('4. an ownerless BACKLOG task is untouched by the sweep', async () => {
    await store.createTask({ id: 'orph-bl', title: 'Backlog no-op', status: 'BACKLOG', round: 1 });
    const res = await store.reapExpiredClaims({ now: Date.now() });
    assert.ok(!res.reclaimed.includes('default/orph-bl'), 'BACKLOG orphan not reclaimed');
    const t = store.getTask('orph-bl');
    assert.equal(t.status, 'BACKLOG', 'still BACKLOG');
    assert.equal(t.assigned_agent, null);
    assert.equal(t.reclaim_count, undefined, 'no reclaim bump');
     });

  it('5. an ownerless DONE task is untouched by the sweep', async () => {
    await store.createTask({ id: 'orph-done', title: 'Done no-op', status: 'DONE', round: 1 });
    const res = await store.reapExpiredClaims({ now: Date.now() });
    assert.ok(!res.reclaimed.includes('default/orph-done'), 'DONE orphan not reclaimed');
    assert.equal(store.getTask('orph-done').status, 'DONE', 'still DONE');
     });

  it('6. a claimed, unexpired BUILDING task is not swept', async () => {
    await store.createTask({ id: 'orph-held', title: 'Held build', status: 'BACKLOG', round: 1 });
    await store.claimTask('orph-held', 'holder', undefined, {});
    const res = await store.reapExpiredClaims({ now: Date.now() });
    assert.ok(!res.reclaimed.includes('default/orph-held'), 'unexpired claim not reclaimed');
    assert.equal(store.getTask('orph-held').status, 'BUILDING', 'stays BUILDING');
    assert.equal(store.getTask('orph-held').assigned_agent, 'holder', 'ownership retained');
     });

  it('7. the reclaim log records reason orphan_normalized + reclaimed_from null', async () => {
    await store.createTask({ id: 'orph-log', title: 'Log orphan', status: 'BUILDING', round: 1 });
    await store.reapExpiredClaims({ now: Date.now() });
    const log = store.getTask('orph-log').agent_logs.at(-1);
    assert.ok(log, 'a log entry was appended');
    assert.equal(log.reason, 'orphan_normalized', 'reason is orphan_normalized');
    assert.equal(log.reclaimed_from, null, 'reclaimed_from is null');
    assert.match(log.message, /had no owner/, 'normalizer wording used');
     });
});
