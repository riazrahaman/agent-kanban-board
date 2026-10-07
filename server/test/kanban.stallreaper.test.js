import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'kanban-stall-reaper-token';
const STALL_TIMEOUT_MS = 60000; // 1 minute for deterministic test runs

async function backdateProgress(id, ms) {
  const t = store.getTask(id);
  assert.ok(t, `${id} exists in store`);
  t.last_progress_at = new Date(ms).toISOString();
  t.updated = t.last_progress_at;
  const storage = store.getStorage(t.project);
  await storage.saveTask(t, store.getProjectBucket(t.project));
  return t;
}

async function setExpiry(id, ms) {
  const t = store.getTask(id);
  assert.ok(t, `${id} exists in store`);
  t.claim_expires_at = new Date(ms).toISOString();
  const storage = store.getStorage(t.project);
  await storage.saveTask(t, store.getProjectBucket(t.project));
  return t;
}

describe('reaper progress stall timeout (KANBAN_PROGRESS_STALL_MS)', () => {
  let tmpDir;
  let server;
  let realNow;
  let auditEntries = [];
  let unsubAudit;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    process.env.KANBAN_PROGRESS_STALL_MS = String(STALL_TIMEOUT_MS);
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    process.env.KANBAN_REAP_ENABLED = 'false';
    realNow = () => Date.now();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-stall-'));
    store.setStorage(null);
    store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
    await store.loadStore();
    unsubAudit = store.onAudit((entry) => auditEntries.push(entry));
    await new Promise((resolve) => {
      server = createApp().listen(0, '127.0.0.1', resolve);
    });
  });

  after(async () => {
    if (unsubAudit) unsubAudit();
    store.stopReaper();
    store.setNowFn(realNow);
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_PROGRESS_STALL_MS;
    delete process.env.KANBAN_REAP_ENABLED;
    store.setStorage(null);
  });

  it('Test 1: An active task with live heartbeats IS reaped back to BACKLOG when now - last_progress_at >= KANBAN_PROGRESS_STALL_MS', async () => {
    const baseNow = Date.now();
    await store.createTask({ id: 'stall-1', title: 'Stalled task', status: 'BACKLOG', round: 1 });
    await store.claimTask('stall-1', 'zombie-agent', undefined, { now: baseNow });

    // Verify initial task state
    let t = store.getTask('stall-1');
    assert.equal(t.status, 'BUILDING');
    assert.equal(t.assigned_agent, 'zombie-agent');
    assert.ok(t.last_progress_at, 'has last_progress_at recorded');

    // Backdate last_progress_at so progress stalled
    await backdateProgress('stall-1', baseNow - STALL_TIMEOUT_MS - 5000);
    // Keep claim_expires_at in the future (heartbeats active)
    await setExpiry('stall-1', baseNow + 600000);

    t = store.getTask('stall-1');
    assert.ok(Date.parse(t.claim_expires_at) > baseNow, 'lease is currently active/unexpired in the future');

    // Sweep reaper at baseNow
    const res = await store.reapExpiredClaims({ now: baseNow });
    assert.ok(res.reclaimed.includes('default/stall-1'), 'stalled task was reaped by the sweep');

    t = store.getTask('stall-1');
    assert.equal(t.status, 'BACKLOG', 'task returned to BACKLOG');
    assert.equal(t.assigned_agent, null, 'owner cleared');
    assert.equal(t.claim_expires_at, null, 'lease cleared');
    assert.equal(t.reclaim_count, 1, 'reclaim_count incremented');
  });

  it('Test 2: Reclaim reason in agent_logs and audit/semantic event is progress_stalled', async () => {
    const t = store.getTask('stall-1');
    const lastLog = t.agent_logs.at(-1);
    assert.ok(lastLog, 'log appended');
    assert.equal(lastLog.reason, 'progress_stalled', 'agent_logs reason is progress_stalled');
    assert.equal(lastLog.reclaimed_from, 'zombie-agent', 'reclaimed_from is zombie-agent');
    assert.equal(lastLog.message, 'PROGRESS STALLED — task reclaimed to BACKLOG by system reaper.');

    const audit = auditEntries.find((e) => e.task?.id === 'stall-1' && e.kind === 'reclaimed');
    assert.ok(audit, 'audit event found');
    assert.equal(audit.reason, 'progress_stalled', 'audit event reason is progress_stalled');
  });

  it('Test 3: An active task with recent progress (e.g. POST /logs or PATCH updated last_progress_at) is NOT reaped', async () => {
    const baseNow = Date.now();
    await store.createTask({ id: 'active-1', title: 'Active progress task', status: 'BACKLOG', round: 1 });
    await store.claimTask('active-1', 'active-agent', undefined, { now: baseNow });

    // Progress occurs via appendLog
    await store.appendLog('active-1', 'active-agent', 'Still compiling...', undefined, {});

    let t = store.getTask('active-1');
    assert.ok(t.last_progress_at, 'has last_progress_at');
    // Ensure claim_expires_at is well in the future
    await setExpiry('active-1', baseNow + 600000);

    // Reap at baseNow + 30000 (< STALL_TIMEOUT_MS)
    const checkTime = Date.parse(t.last_progress_at) + 30000;
    const res = await store.reapExpiredClaims({ now: checkTime });
    assert.ok(!res.reclaimed.includes('default/active-1'), 'task with recent progress must not be reaped');

    t = store.getTask('active-1');
    assert.equal(t.status, 'BUILDING');
    assert.equal(t.assigned_agent, 'active-agent');
  });

  it('Test 4: When KANBAN_PROGRESS_STALL_MS=0, progress stall check is disabled and heartbeats keep the task alive', async () => {
    process.env.KANBAN_PROGRESS_STALL_MS = '0';
    try {
      const baseNow = Date.now();
      await store.createTask({ id: 'disabled-1', title: 'Disabled stall check', status: 'BACKLOG', round: 1 });
      await store.claimTask('disabled-1', 'idle-agent', undefined, { now: baseNow });

      // Stalled progress in the past
      await backdateProgress('disabled-1', baseNow - 7200000);
      // But lease kept alive in the future
      await setExpiry('disabled-1', baseNow + 600000);

      const res = await store.reapExpiredClaims({ now: baseNow });
      assert.ok(!res.reclaimed.includes('default/disabled-1'), 'task should NOT be reaped when stall check is disabled');

      const t = store.getTask('disabled-1');
      assert.equal(t.status, 'BUILDING');
      assert.equal(t.assigned_agent, 'idle-agent');
    } finally {
      process.env.KANBAN_PROGRESS_STALL_MS = String(STALL_TIMEOUT_MS);
    }
  });

  it('Test 5: getProgressStallMs parses valid numbers, allows 0 to disable, and safely falls back on negative or non-numeric values', () => {
    const orig = process.env.KANBAN_PROGRESS_STALL_MS;
    try {
      delete process.env.KANBAN_PROGRESS_STALL_MS;
      assert.equal(store.getProgressStallMs(), 1800000, 'unset defaults to 1800000 (30m)');

      process.env.KANBAN_PROGRESS_STALL_MS = '';
      assert.equal(store.getProgressStallMs(), 1800000, 'empty string defaults to 1800000');

      process.env.KANBAN_PROGRESS_STALL_MS = '0';
      assert.equal(store.getProgressStallMs(), 0, '0 explicitly disables stall check');

      process.env.KANBAN_PROGRESS_STALL_MS = '60000';
      assert.equal(store.getProgressStallMs(), 60000, 'positive integer parses correctly');

      process.env.KANBAN_PROGRESS_STALL_MS = '-1000';
      assert.equal(store.getProgressStallMs(), 1800000, 'negative integer falls back to default');

      process.env.KANBAN_PROGRESS_STALL_MS = 'not-a-number';
      assert.equal(store.getProgressStallMs(), 1800000, 'non-numeric string falls back to default');
    } finally {
      if (orig !== undefined) process.env.KANBAN_PROGRESS_STALL_MS = orig;
      else delete process.env.KANBAN_PROGRESS_STALL_MS;
    }
  });
});
