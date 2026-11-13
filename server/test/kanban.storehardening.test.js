/**
 * v3.12.11 store hardening (batch 2): trash row identity, restore/complete
 * timestamps, project-scoped dependencies, PATCH field bounds, spill sidecar
 * lifecycle, unblock lease re-arm, reaper isolation, explicit assign release,
 * and credential-derived privilege for the role matrix and claim cap.
 *
 * Store-level tests run in legacy single-token mode (KANBAN_AUTH_TOKEN), with
 * a real server only where the HTTP route is the unit under test.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

process.env.NODE_ENV = 'test';
process.env.KANBAN_AUTH_TOKEN = 'kanban-hardening-token';
process.env.KANBAN_REAP_ENABLED = 'false';
process.env.KANBAN_DEFAULT_PROJECT = 'default';
delete process.env.KANBAN_STORAGE_BACKEND;
delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
delete process.env.KANBAN_PROJECT_TOKENS;
delete process.env.KANBAN_ADMIN_TOKEN;

const { createApp } = await import('../server.js');
const store = await import('../store.js');
const fields = await import('../task-fields.js');

const ADMIN = { agent_id: 'ops', role: 'admin' };
const authHeader = ['B' + 'earer', 'kanban-hardening-token'].join(' ');

function headers(role = 'admin', agentId = 'ops') {
  return {
    Authorization: authHeader,
    'Content-Type': 'application/json',
    'x-agent-role': role,
    'x-agent-id': agentId,
  };
}

async function jsonRequest(baseUrl, route, { method = 'GET', headers: hdrs = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: hdrs,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { response, body: parsed };
}

function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function create(id, extra = {}, project) {
  const r = await store.createTask({ id, title: id, status: 'READY', round: 1, ...extra }, project, { caller: ADMIN });
  assert.equal(r.status, 201, `create ${id}: ${r.error || ''}`);
  return r.task;
}

async function walkToDone(id, project) {
  for (const s of ['IN_PROGRESS', 'IN_REVIEW', 'VALIDATION', 'READY_TO_SHIP', 'DONE']) {
    const r = await store.patchTask(id, { status: s }, { caller: ADMIN, project });
    assert.equal(r.status, 200, `${id} -> ${s}: ${r.error || ''}`);
  }
  return store.getTask(id, project);
}

describe('v3.12.11 store hardening', { concurrency: 1 }, () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kanban-hardening-'));
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = join(tmpDir, 'tasks.json');
    process.env.KANBAN_TRASH_DAYS = '30';
  });

  after(async () => {
    store.setNowFn(null);
    delete process.env.KANBAN_TRASH_DAYS;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_INLINE_LOG_CAP;
    delete process.env.KANBAN_CLAIM_TTL_MS;
    delete process.env.KANBAN_MAX_CLAIMS_PER_AGENT;
    await rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    store.setNowFn(null);
    store.setStorage(null);
    await rm(tmpDir, { recursive: true, force: true });
    await store.loadStore();
  });

  afterEach(() => {
    store.setNowFn(null);
  });

  // --- COR-05 -------------------------------------------------------------
  it('COR-05: restoring one of two same-id trash rows keeps the other (memory and disk)', async () => {
    await create('twin', { title: 'first' });
    assert.equal((await store.deleteTask('twin', { caller: ADMIN })).status, 200);
    await create('twin', { title: 'second' });
    assert.equal((await store.deleteTask('twin', { caller: ADMIN })).status, 200);
    assert.deepEqual(store.getTrashedTasks('default').map((t) => t.title), ['first', 'second']);

    const restored = await store.restoreFromTrash('twin', { caller: ADMIN, project: 'default' });
    assert.equal(restored.status, 200);
    assert.equal(restored.task.title, 'first');
    assert.deepEqual(store.getTrashedTasks('default').map((t) => t.title), ['second']);

    // Disk agrees after a restart.
    store.setStorage(null);
    await store.loadStore();
    assert.deepEqual(store.getTrashedTasks('default').map((t) => t.title), ['second']);
  });

  it('COR-05: hard-deleting one of two same-id trash rows keeps the other', async () => {
    await create('twin2', { title: 'first' });
    await store.deleteTask('twin2', { caller: ADMIN });
    await create('twin2', { title: 'second' });
    await store.deleteTask('twin2', { caller: ADMIN });
    const r = await store.hardDeleteFromTrash('twin2', { caller: ADMIN, project: 'default' });
    assert.equal(r.status, 200);
    assert.deepEqual(store.getTrashedTasks('default').map((t) => t.title), ['second']);
  });

  // --- COR-06 -------------------------------------------------------------
  it('COR-06: hard-deleting a trash row emits no deleted event for a live same-id task', async () => {
    await create('live-twin');
    await store.deleteTask('live-twin', { caller: ADMIN });
    await create('live-twin');
    const events = [];
    const off = store.onDiff((e) => events.push(e));
    try {
      const r = await store.hardDeleteFromTrash('live-twin', { caller: ADMIN, project: 'default' });
      assert.equal(r.status, 200);
    } finally {
      off();
    }
    assert.deepEqual(events.filter((e) => e.kind === 'deleted'), []);
    assert.ok(store.getTask('live-twin'), 'live task still exists');
  });

  // --- COR-07 -------------------------------------------------------------
  it('COR-07: restore clears completed_at / archived_at / last_progress_at', async () => {
    await create('rdone', { status: 'DONE' });
    assert.ok(store.getTask('rdone').completed_at);
    await store.deleteTask('rdone', { caller: ADMIN });
    const r = await store.restoreFromTrash('rdone', { caller: ADMIN, project: 'default' });
    assert.equal(r.status, 200);
    assert.equal(r.task.status, 'READY');
    assert.equal(r.task.completed_at, undefined);
    assert.equal(r.task.archived_at, undefined);
    assert.equal(r.task.last_progress_at, null);
  });

  it('COR-07: a real transition into DONE restamps a stale completed_at', async () => {
    await create('restamp', { status: 'READY_TO_SHIP' });
    // Simulate a stale stamp left on a non-DONE card by an earlier life.
    store.getTask('restamp').completed_at = '2020-01-01T00:00:00.000Z';
    const before = Date.now();
    const r = await store.patchTask('restamp', { status: 'DONE' }, { caller: ADMIN });
    assert.equal(r.status, 200);
    assert.ok(Date.parse(r.task.completed_at) >= before, 'completed_at is the new completion time');
    // A DONE -> DONE edit keeps the stamp.
    const stamp = r.task.completed_at;
    const again = await store.patchTask('restamp', { title: 'edited' }, { caller: ADMIN });
    assert.equal(again.task.completed_at, stamp);
  });

  // --- COR-08 -------------------------------------------------------------
  it('COR-08: completing a card unblocks only dependents in its own project', async () => {
    await create('x', { status: 'DONE' }, 'beta');
    await create('dep', { status: 'BLOCKED', depends_on: ['x'] }, 'beta');
    await create('x', { status: 'READY_TO_SHIP' }, 'alpha');
    const r = await store.patchTask('x', { status: 'DONE' }, { caller: ADMIN, project: 'alpha' });
    assert.equal(r.status, 200);
    assert.equal(store.getTask('dep', 'beta').status, 'BLOCKED', 'other project dependent untouched');

    // Same-project completion (with an own-project `project:id` entry) still unblocks.
    await create('y', { status: 'READY_TO_SHIP' }, 'beta');
    await create('dep2', { status: 'BLOCKED', depends_on: ['beta:y'] }, 'beta');
    await store.patchTask('y', { status: 'DONE' }, { caller: ADMIN, project: 'beta' });
    assert.equal(store.getTask('dep2', 'beta').status, 'READY');
  });

  // --- SEC-08 -------------------------------------------------------------
  it('SEC-08: depends_on must stay inside the task project (create and PATCH)', async () => {
    await create('secret', { status: 'DONE' }, 'beta');
    const bad = await store.createTask(
      { id: 'probe', title: 'p', status: 'READY', round: 1, depends_on: ['beta:secret'] }, 'alpha', { caller: ADMIN },
    );
    assert.equal(bad.status, 400);
    assert.match(bad.error, /must reference a task in project 'alpha'/);

    await create('own', {}, 'alpha');
    const ok = await store.createTask(
      { id: 'probe', title: 'p', status: 'READY', round: 1, depends_on: ['alpha:own'] }, 'alpha', { caller: ADMIN },
    );
    assert.equal(ok.status, 201, 'own-project prefix is accepted');

    const patched = await store.patchTask('probe', { depends_on: ['beta:secret'] }, { caller: ADMIN, project: 'alpha' });
    assert.equal(patched.status, 400);
  });

  it('SEC-08: a stored cross-project dependency fails closed in the gate', async () => {
    await create('secret2', { status: 'DONE' }, 'beta');
    const t = await create('probe2', {}, 'alpha');
    // Legacy data written before the write-time check.
    store.getTask('probe2', 'alpha').depends_on = ['beta:secret2'];
    const gate = store.dependencyGate(store.getTask('probe2', 'alpha'));
    assert.equal(gate.ok, false);
    const claim = await store.claimTask('probe2', 'w1', 'alpha', { caller: { role: 'builder' } });
    assert.equal(claim.status, 409);
    assert.equal(claim.reason, 'dependency_unsatisfied');
    assert.ok(t);
  });

  // --- COR-09 -------------------------------------------------------------
  it('COR-09: PATCH validates round and issues', async () => {
    await create('fields');
    for (const round of ['banana', -5, 0, 1.5]) {
      const r = await store.patchTask('fields', { round }, { caller: ADMIN });
      assert.equal(r.status, 400, `round ${JSON.stringify(round)}`);
    }
    assert.equal((await store.patchTask('fields', { round: 3 }, { caller: ADMIN })).task.round, 3);

    for (const issues of [7, { not: 'an array' }, 'x', [1], [''], ['x'.repeat(fields.MAX_ISSUE_LEN + 1)],
      Array.from({ length: fields.MAX_ISSUES + 1 }, (_, i) => `i${i}`)]) {
      const r = await store.patchTask('fields', { issues }, { caller: ADMIN });
      assert.equal(r.status, 400, `issues ${JSON.stringify(issues).slice(0, 40)}`);
    }
    const ok = await store.patchTask('fields', { issues: ['BUG-1', '<b>x</b>'] }, { caller: ADMIN });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.task.issues, ['BUG-1', '&lt;b&gt;x&lt;/b&gt;']);
    const cleared = await store.patchTask('fields', { issues: null }, { caller: ADMIN });
    assert.deepEqual(cleared.task.issues, []);
  });

  it('COR-09: message, branch, milestone, depends_on entry and issue lengths are capped', async () => {
    await create('caps');
    const long = (n) => 'a'.repeat(n);
    assert.equal((await store.appendLog('caps', 'w', long(fields.MAX_MESSAGE_LEN + 1))).status, 400);
    assert.equal((await store.appendLog('caps', 'w', long(fields.MAX_MESSAGE_LEN))).status, 200);
    assert.equal((await store.addComment('caps', 'w', long(fields.MAX_MESSAGE_LEN + 1))).status, 400);
    assert.equal((await store.patchTask('caps', { branch: long(fields.MAX_BRANCH_LEN + 1) }, { caller: ADMIN })).status, 400);
    assert.equal((await store.patchTask('caps', { branch: 'feat/x' }, { caller: ADMIN })).status, 200);
    assert.equal((await store.patchTask('caps', { milestone: long(fields.MAX_MILESTONE_LEN + 1) }, { caller: ADMIN })).status, 400);
    assert.equal((await store.patchTask('caps', { depends_on: [long(fields.MAX_DEPENDS_ON_ENTRY_LEN + 1)] }, { caller: ADMIN })).status, 400);
    assert.equal((await store.addIssue('caps', long(fields.MAX_ISSUE_LEN + 1))).status, 400);
    const createLong = await store.createTask(
      { id: 'caps2', title: 't', status: 'READY', round: 1, branch: long(fields.MAX_BRANCH_LEN + 1) }, undefined, { caller: ADMIN },
    );
    assert.equal(createLong.status, 400);
  });

  // --- COR-12 -------------------------------------------------------------
  it('COR-12: logs reader accepts project:id; hard purge retires the sidecar', async () => {
    process.env.KANBAN_INLINE_LOG_CAP = '2';
    try {
      await create('sp');
      for (let i = 0; i < 5; i++) await store.appendLog('sp', 'w', `old-log-${i}`);
      const plain = await store.getTaskLogs('sp');
      assert.ok(plain.spilled_count > 0);
      const composite = await store.getTaskLogs('default:sp');
      assert.equal(composite.spilled_count, plain.spilled_count, 'composite id finds the sidecar');

      const purge = await store.purgeTasks({ caller: ADMIN, ids: ['sp'], hard: true });
      assert.equal(purge.count, 1);
      await create('sp');
      const fresh = await store.getTaskLogs('sp');
      assert.equal(fresh.spilled_count, 0, 'a re-created id inherits no spilled history');
    } finally {
      delete process.env.KANBAN_INLINE_LOG_CAP;
    }
  });

  it('COR-12: soft delete parks the sidecar with the trash row; restore brings it back; expiry removes it', async () => {
    process.env.KANBAN_INLINE_LOG_CAP = '1';
    try {
      await create('sd');
      for (let i = 0; i < 4; i++) await store.appendLog('sd', 'w', `log-${i}`);
      const count = (await store.getTaskLogs('sd')).spilled_count;
      assert.ok(count > 0);
      await store.deleteTask('sd', { caller: ADMIN });
      await create('sd');
      assert.equal((await store.getTaskLogs('sd')).spilled_count, 0, 'live re-creation starts clean');
      await store.purgeTasks({ caller: ADMIN, ids: ['sd'], hard: true });
      const back = await store.restoreFromTrash('sd', { caller: ADMIN, project: 'default' });
      assert.equal(back.status, 200);
      assert.equal((await store.getTaskLogs('sd')).spilled_count, count, 'restore brings the history back');

      // Expiry: delete at a time far in the past, then sweep.
      await store.appendLog('sd', 'w', 'more');
      store.setNowFn(() => Date.now() - 40 * 86400000);
      await store.deleteTask('sd', { caller: ADMIN });
      store.setNowFn(null);
      const trashDir = join(tmpDir, 'spill', 'default', 'trash');
      assert.ok((await readdir(trashDir)).length > 0, 'parked sidecar exists');
      const swept = await store.runTrashSweep();
      assert.deepEqual(swept.purged, ['default/sd']);
      assert.deepEqual(await readdir(trashDir), [], 'expired row sidecar removed');
    } finally {
      delete process.env.KANBAN_INLINE_LOG_CAP;
    }
  });

  it('COR-12: archiving moves the sidecar out of the live namespace', async () => {
    process.env.KANBAN_INLINE_LOG_CAP = '1';
    process.env.KANBAN_ARCHIVE_AFTER_DAYS = '1';
    try {
      await create('ar', { status: 'READY_TO_SHIP' });
      for (let i = 0; i < 3; i++) await store.appendLog('ar', 'w', `log-${i}`);
      await store.patchTask('ar', { status: 'DONE' }, { caller: ADMIN });
      store.getTask('ar').completed_at = '2020-01-01T00:00:00.000Z';
      const moved = await store.runArchiveSweep();
      assert.equal(moved, 1);
      assert.equal(existsSync(join(tmpDir, 'spill', 'default', 'ar.jsonl')), false);
      const parked = await readdir(join(tmpDir, 'spill', 'default', 'archive'));
      assert.equal(parked.length, 1);
      assert.match(parked[0], /^ar\..+\.jsonl$/);
      await create('ar');
      assert.equal((await store.getTaskLogs('ar')).spilled_count, 0);
    } finally {
      delete process.env.KANBAN_INLINE_LOG_CAP;
      delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    }
  });

  // --- COR-13 -------------------------------------------------------------
  it('COR-13: moving a card out of BLOCKED re-arms the existing owner lease', async () => {
    process.env.KANBAN_CLAIM_TTL_MS = '60000';
    try {
      await create('blk');
      assert.equal((await store.claimTask('blk', 'b9', undefined, { caller: { role: 'builder' } })).status, 200);
      assert.equal((await store.patchTask('blk', { status: 'BLOCKED' }, { caller: ADMIN })).status, 200);
      const later = Date.now() + 5 * 60000; // pre-block lease long lapsed
      store.setNowFn(() => later);
      const r = await store.patchTask('blk', { status: 'IN_PROGRESS' }, { caller: ADMIN });
      assert.equal(r.status, 200);
      assert.equal(r.task.assigned_agent, 'b9');
      assert.ok(Date.parse(r.task.claim_expires_at) > later, 'lease re-armed');
      const swept = await store.reapExpiredClaims({ now: later + 1000 });
      assert.deepEqual(swept.reclaimed, []);
      assert.equal(store.getTask('blk').status, 'IN_PROGRESS');
    } finally {
      delete process.env.KANBAN_CLAIM_TTL_MS;
    }
  });

  // --- COR-17 -------------------------------------------------------------
  it('COR-17: one failing reclaim does not abort the rest of the sweep', async () => {
    await create('bad');
    await create('good');
    await store.claimTask('bad', 'w1', undefined, { caller: { role: 'builder' } });
    await store.claimTask('good', 'w2', undefined, { caller: { role: 'builder' } });
    class OneBadStorage extends store.JsonStorage {
      async saveTask(task, all) {
        if (task.id === 'bad') throw new Error('simulated write failure');
        return super.saveTask(task, all);
      }
    }
    store.setStorage(new OneBadStorage(join(tmpDir, 'tasks.json')));
    const res = await store.reapExpiredClaims({ now: Date.now() + 365 * 86400000 });
    assert.deepEqual(res.reclaimed, ['default/good']);
    assert.equal(store.getTask('bad').status, 'IN_PROGRESS', 'failed card untouched');
    assert.equal(store.getTask('good').status, 'READY');
  });

  // --- SEC-04 (store level) ----------------------------------------------
  it('SEC-04: a declared privileged role without a privileged credential is not privileged', async () => {
    await create('sec4');
    const unbound = { agent_id: 'w', role: 'admin', privileged: false };
    const r = await store.patchTask('sec4', { status: 'BLOCKED' }, { caller: unbound });
    assert.equal(r.status, 403);
    // Credential-privileged and direct (no flag) callers keep working.
    assert.equal((await store.patchTask('sec4', { status: 'BLOCKED' }, { caller: { role: 'admin', privileged: true } })).status, 200);
    assert.equal((await store.patchTask('sec4', { status: 'READY' }, { caller: { role: 'runner' } })).status, 200);

    process.env.KANBAN_MAX_CLAIMS_PER_AGENT = '1';
    try {
      await create('cap1');
      await create('cap2');
      assert.equal((await store.claimTask('cap1', 'hoard', undefined, { caller: unbound })).status, 200);
      const second = await store.claimTask('cap2', 'hoard', undefined, { caller: unbound });
      assert.equal(second.status, 409);
      assert.equal(second.reason, 'claim_limit');
      const viaNext = await store.nextClaim({ agentId: 'hoard', role: 'admin', caller: unbound });
      assert.equal(viaNext.status, 409);
      assert.equal(viaNext.reason, 'claim_limit');
      const priv = await store.claimTask('cap2', 'hoard', undefined, { caller: { role: 'admin', privileged: true } });
      assert.equal(priv.status, 200, 'a privileged credential stays exempt');
    } finally {
      delete process.env.KANBAN_MAX_CLAIMS_PER_AGENT;
    }
  });

  // --- COR-19 + legacy single-token privilege (HTTP) ----------------------
  it('COR-19: POST /:id/assign without agent_id is a 400; explicit null releases', async () => {
    const { server, baseUrl } = await startTestServer(createApp());
    try {
      await create('asg');
      const assigned = await jsonRequest(baseUrl, '/api/tasks/asg/assign', {
        method: 'POST', headers: headers(), body: { agent_id: 'w7' },
      });
      assert.equal(assigned.response.status, 200);
      assert.equal(assigned.body.assigned_agent, 'w7');

      for (const body of [{}, { agentid: null }]) {
        const r = await jsonRequest(baseUrl, '/api/tasks/asg/assign', { method: 'POST', headers: headers(), body });
        assert.equal(r.response.status, 400, JSON.stringify(body));
      }
      assert.equal(store.getTask('asg').assigned_agent, 'w7', 'holder kept');

      const released = await jsonRequest(baseUrl, '/api/tasks/asg/assign', {
        method: 'POST', headers: headers(), body: { agent_id: null },
      });
      assert.equal(released.response.status, 200);
      assert.equal(released.body.assigned_agent, null);

      // SEC-04 regression guard: legacy single-token mode keeps header privilege.
      const blocked = await jsonRequest(baseUrl, '/api/tasks/asg', {
        method: 'PATCH', headers: headers('admin'), body: { status: 'BLOCKED' },
      });
      assert.equal(blocked.response.status, 200);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// --- COR-15 (git backend) -------------------------------------------------
describe('v3.12.11 git soft-delete persists the stamped row', { concurrency: 1 }, () => {
  let gitDir;
  let dataDir;

  before(async () => {
    gitDir = await mkdtemp(join(tmpdir(), 'kanban-hardening-git-'));
    dataDir = await mkdtemp(join(tmpdir(), 'kanban-hardening-gitdata-'));
    await execFileAsync('git', ['init'], { cwd: gitDir });
    await execFileAsync('git', ['config', 'user.name', 'Hardening Test'], { cwd: gitDir });
    await execFileAsync('git', ['config', 'user.email', 'hardening@test.local'], { cwd: gitDir });
    process.env.KANBAN_STORAGE_BACKEND = 'git';
    process.env.KANBAN_GIT_DIR = gitDir;
    process.env.KANBAN_DATA_DIR = dataDir;
    process.env.KANBAN_DATA_FILE = join(dataDir, 'tasks.json');
    store.setStorage(null);
    await store.loadStore();
  });

  after(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_GIT_DIR;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
    await rm(gitDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('COR-15: deleteTask and purgeTasks write deleted_by and the bumped version to disk', async () => {
    await create('g1');
    await create('g2');
    const del = await store.deleteTask('g1', { caller: ADMIN });
    assert.equal(del.status, 200);
    const purge = await store.purgeTasks({ caller: ADMIN, ids: ['g2'] });
    assert.equal(purge.count, 1);
    for (const id of ['g1', 'g2']) {
      const raw = await readFile(join(gitDir, 'trash', 'default', `${id}.yml`), 'utf-8');
      assert.match(raw, /deleted_by: ops/, `${id} deleted_by on disk`);
      assert.match(raw, /version: 2/, `${id} bumped version on disk`);
    }
    store.setStorage(null);
    await store.loadStore();
    const row = store.getTrashedTasks('default').find((t) => t.id === 'g1');
    assert.equal(row.version, 2);
    assert.equal(row.deleted_by, 'ops');
  });
});
