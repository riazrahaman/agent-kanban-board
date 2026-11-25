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
    // Hermetic on both roots (see kanban.nextclaim.test.js): loadStore()
    // enumerates jsonDataDir()/tasks (named projects) into the live array, so
    // without the dir pin real checkout data can leak in — and writes can leak
    // out — of this suite.
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_DATA_DIR = tmpDir;
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
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DATA_DIR;
    store.setStorage(null);
  });

  it('Test 1: An active task with live heartbeats IS reaped back to READY when now - last_progress_at >= KANBAN_PROGRESS_STALL_MS', async () => {
    const baseNow = Date.now();
    await store.createTask({ id: 'stall-1', title: 'Stalled task', status: 'READY', round: 1 });
    await store.claimTask('stall-1', 'zombie-agent', undefined, { now: baseNow });

    // Verify initial task state
    let t = store.getTask('stall-1');
    assert.equal(t.status, 'IN_PROGRESS');
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
    assert.equal(t.status, 'READY', 'task returned to READY');
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
    assert.equal(lastLog.message, 'PROGRESS STALLED — task reclaimed to READY by system reaper.');
    // Lease state at reclaim time is recorded so a live-lease reclaim is
    // visible after the fact (docs/BOARD-LEASE-STALL-DEFECT.md section 7).
    // The card's lease was cleared by the reclaim, so the log must carry the
    // PRE-reclaim expiry — the whole point of the field.
    assert.equal(typeof lastLog.claim_expires_at, 'string', 'log carries the pre-reclaim claim_expires_at');
    assert.ok(Date.parse(lastLog.claim_expires_at) > 0, 'claim_expires_at is a valid ISO timestamp');
    assert.ok(lastLog.last_progress_at, 'log carries last_progress_at');

    const audit = auditEntries.find((e) => e.task?.id === 'stall-1' && e.kind === 'reclaimed');
    assert.ok(audit, 'audit event found');
    assert.equal(audit.reason, 'progress_stalled', 'audit event reason is progress_stalled');
  });

  it('Test 3: An active task with recent progress (e.g. POST /logs or PATCH updated last_progress_at) is NOT reaped', async () => {
    const baseNow = Date.now();
    await store.createTask({ id: 'active-1', title: 'Active progress task', status: 'READY', round: 1 });
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
    assert.equal(t.status, 'IN_PROGRESS');
    assert.equal(t.assigned_agent, 'active-agent');
  });

  it('Test 4: When KANBAN_PROGRESS_STALL_MS=0, progress stall check is disabled and heartbeats keep the task alive', async () => {
    process.env.KANBAN_PROGRESS_STALL_MS = '0';
    try {
      const baseNow = Date.now();
      await store.createTask({ id: 'disabled-1', title: 'Disabled stall check', status: 'READY', round: 1 });
      await store.claimTask('disabled-1', 'idle-agent', undefined, { now: baseNow });

      // Stalled progress in the past
      await backdateProgress('disabled-1', baseNow - 7200000);
      // But lease kept alive in the future
      await setExpiry('disabled-1', baseNow + 600000);

      const res = await store.reapExpiredClaims({ now: baseNow });
      assert.ok(!res.reclaimed.includes('default/disabled-1'), 'task should NOT be reaped when stall check is disabled');

      const t = store.getTask('disabled-1');
      assert.equal(t.status, 'IN_PROGRESS');
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

  it('Test 6: IN_REVIEW and VALIDATION survive past KANBAN_PROGRESS_STALL_MS while their lease is live (stage window)', async () => {
    const baseNow = Date.now();
    // IN_REVIEW: claim -> IN_PROGRESS, then builder PATCHes to IN_REVIEW.
    await store.createTask({ id: 'stage-review-1', title: 'In review', status: 'READY', round: 1 });
    await store.claimTask('stage-review-1', 'builder-1', undefined, { now: baseNow });
    let t = store.getTask('stage-review-1');
    const toReview = await store.patchTask('stage-review-1',
      { status: 'IN_REVIEW', expected_version: t.version },
      { caller: { agent_id: 'builder-1', role: 'builder' } });
    assert.equal(toReview.task.status, 'IN_REVIEW', JSON.stringify(toReview));

    // Quiet longer than the 60s progress window but far inside the 24h stage
    // window; lease still live.
    await backdateProgress('stage-review-1', baseNow - STALL_TIMEOUT_MS - 5000);
    await setExpiry('stage-review-1', baseNow + 600000);

    const res = await store.reapExpiredClaims({ now: baseNow });
    assert.ok(!res.reclaimed.includes('default/stage-review-1'), 'IN_REVIEW must not stall-reclaim under the activity window');
    t = store.getTask('stage-review-1');
    assert.equal(t.status, 'IN_REVIEW');
    assert.equal(t.assigned_agent, 'builder-1');

    // VALIDATION: reviewer advances it, then it goes quiet the same way.
    t = store.getTask('stage-review-1');
    const toValidation = await store.patchTask('stage-review-1',
      { status: 'VALIDATION', expected_version: t.version },
      { caller: { agent_id: 'reviewer-1', role: 'reviewer' } });
    assert.equal(toValidation.task.status, 'VALIDATION', JSON.stringify(toValidation));
    await backdateProgress('stage-review-1', baseNow - STALL_TIMEOUT_MS - 5000);
    await setExpiry('stage-review-1', baseNow + 600000);

    const res2 = await store.reapExpiredClaims({ now: baseNow });
    assert.ok(!res2.reclaimed.includes('default/stage-review-1'), 'VALIDATION must not stall-reclaim under the activity window');
    assert.equal(store.getTask('stage-review-1').status, 'VALIDATION');
  });

  it('Test 7: IN_REVIEW IS reclaimed once last_progress_at exceeds KANBAN_STAGE_STALL_MS', async () => {
    const orig = process.env.KANBAN_STAGE_STALL_MS;
    process.env.KANBAN_STAGE_STALL_MS = '30000'; // shorter than the 60s progress window
    try {
      const baseNow = Date.now();
      await store.createTask({ id: 'stage-review-2', title: 'Stale review', status: 'READY', round: 1 });
      await store.claimTask('stage-review-2', 'builder-2', undefined, { now: baseNow });
      let t = store.getTask('stage-review-2');
      const toReview = await store.patchTask('stage-review-2',
        { status: 'IN_REVIEW', expected_version: t.version },
        { caller: { agent_id: 'builder-2', role: 'builder' } });
      assert.equal(toReview.task.status, 'IN_REVIEW', JSON.stringify(toReview));

      // 40s ago: inside the 60s progress window but past the 30s stage window —
      // proves the stage window, not the activity window, governs this status.
      await backdateProgress('stage-review-2', baseNow - 40000);
      await setExpiry('stage-review-2', baseNow + 600000);

      const res = await store.reapExpiredClaims({ now: baseNow });
      assert.ok(res.reclaimed.includes('default/stage-review-2'), 'IN_REVIEW past the stage window is reclaimed');
      t = store.getTask('stage-review-2');
      assert.equal(t.status, 'READY');
      assert.equal(t.assigned_agent, null);
      assert.equal(t.reclaim_count, 1);
      assert.equal(t.agent_logs.at(-1).reason, 'progress_stalled');
    } finally {
      if (orig !== undefined) process.env.KANBAN_STAGE_STALL_MS = orig;
      else delete process.env.KANBAN_STAGE_STALL_MS;
    }
  });

  it('Test 8: IN_PROGRESS keeps the short window — a live lease does not exempt it (6.1 must not disarm the guard)', async () => {
    const baseNow = Date.now();
    await store.createTask({ id: 'stage-progress-1', title: 'Wedged build', status: 'READY', round: 1 });
    await store.claimTask('stage-progress-1', 'builder-3', undefined, { now: baseNow });
    await backdateProgress('stage-progress-1', baseNow - STALL_TIMEOUT_MS - 5000);
    await setExpiry('stage-progress-1', baseNow + 600000);

    const res = await store.reapExpiredClaims({ now: baseNow });
    assert.ok(res.reclaimed.includes('default/stage-progress-1'), 'IN_PROGRESS stall reclaim still fires');
    assert.equal(store.getTask('stage-progress-1').status, 'READY');
  });

  it('Test 9: getStageStallMs parses valid numbers, allows 0 to disable, and safely falls back on negative or non-numeric values', () => {
    const orig = process.env.KANBAN_STAGE_STALL_MS;
    try {
      delete process.env.KANBAN_STAGE_STALL_MS;
      assert.equal(store.getStageStallMs(), 86400000, 'unset defaults to 86400000 (24h)');

      process.env.KANBAN_STAGE_STALL_MS = '';
      assert.equal(store.getStageStallMs(), 86400000, 'empty string defaults to 86400000');

      process.env.KANBAN_STAGE_STALL_MS = '0';
      assert.equal(store.getStageStallMs(), 0, '0 explicitly disables the stage stall check');

      process.env.KANBAN_STAGE_STALL_MS = '3600000';
      assert.equal(store.getStageStallMs(), 3600000, 'positive integer parses correctly');

      process.env.KANBAN_STAGE_STALL_MS = '-1000';
      assert.equal(store.getStageStallMs(), 86400000, 'negative integer falls back to default');

      process.env.KANBAN_STAGE_STALL_MS = 'not-a-number';
      assert.equal(store.getStageStallMs(), 86400000, 'non-numeric string falls back to default');
    } finally {
      if (orig !== undefined) process.env.KANBAN_STAGE_STALL_MS = orig;
      else delete process.env.KANBAN_STAGE_STALL_MS;
    }
  });
});
