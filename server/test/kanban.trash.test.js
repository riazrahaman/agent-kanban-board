import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.KANBAN_AUTH_TOKEN = 'kanban-trash-token';
process.env.KANBAN_REAP_ENABLED = 'false';
process.env.KANBAN_DEFAULT_PROJECT = 'default';
delete process.env.KANBAN_STORAGE_BACKEND;
delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
delete process.env.KANBAN_TRASH_DAYS;

const { createApp } = await import('../server.js');
const store = await import('../store.js');

const TOKEN = 'kanban-trash-token';
const authHeader = ['B' + 'earer', TOKEN].join(' ');

function headers(role = 'admin', agentId = 'trash-admin') {
  return {
    Authorization: authHeader,
    'Content-Type': 'application/json',
    'x-agent-role': role,
    'x-agent-id': agentId,
  };
}

function taskBody(id, title, extra = {}) {
  return { id, title, status: 'BACKLOG', round: 1, ...extra };
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
  return { response, body: parsed, text };
}

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('KB-12 soft-delete trash sink (ENH-03, v2.5.6)', { concurrency: 1 }, () => {
  let tmpDir;

  before(async () => {
    process.env.KANBAN_TRASH_DAYS = '30';
    tmpDir = await mkdtemp(join(tmpdir(), 'kanban-trash-'));
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = join(tmpDir, 'tasks.json');
  });

  after(async () => {
    delete process.env.KANBAN_TRASH_DAYS;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
  });

  beforeEach(async () => {
    store.setStorage(null);
    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true });
    await store.loadStore();
  });

  it('1. deleteTask parks the task in the trash (restore endpoint lists it)', async () => {
    const { server, baseUrl } = await startTestServer(createApp());
    try {
      const created = await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('tr-1', 'to trash') });
      assert.equal(created.response.status, 201);

      const del = await store.deleteTask('tr-1', { caller: { agent_id: 'trash-admin', role: 'admin' } });
      assert.equal(del.status, 200);

      const list = store.getTrashedTasks('default');
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'tr-1');
      assert.equal(typeof list[0].deleted_at, 'string');
      assert.equal(list[0].deleted_by, 'trash-admin');

      // live GET is 404 after a soft delete
      const gone = await jsonRequest(baseUrl, '/api/tasks/tr-1?project=default');
      assert.equal(gone.response.status, 404);

      // REST trash list shows it too
      const api = await jsonRequest(baseUrl, '/api/tasks/trash?project=default');
      assert.equal(api.response.status, 200);
      assert.ok(api.body.some((t) => t.id === 'tr-1'));
    } finally { server.close(); }
  });

  it('2. restoreFromTrash returns the card to BACKLOG with a fresh claim state', async () => {
    await store.createTask(taskBody('tr-2', 'restore me'));
    await store.claimTask('tr-2', 'worker-a', 'default');
    const owned = store.getTask('tr-2', 'default');
    assert.equal(owned.status, 'BUILDING');
    assert.equal(owned.assigned_agent, 'worker-a');

    await store.deleteTask('tr-2', { caller: { agent_id: 'trash-admin', role: 'admin' } });
    assert.equal(store.getTask('tr-2', 'default'), null);

    const res = await store.restoreFromTrash('tr-2', { caller: { agent_id: 'trash-admin', role: 'admin' } });
    assert.equal(res.status, 200);
    assert.equal(res.task.status, 'BACKLOG');
    assert.equal(res.task.assigned_agent, null);
    assert.equal(res.task.claim_expires_at, null);
    assert.deepEqual(res.task.stage_owners, {});
    assert.equal(typeof res.task.restored_at, 'string');
    assert.ok(res.task.agent_logs.some((l) => /restored from trash/i.test(l.message)));

    // restored task is claimable again (the restore-then-reclaim loop works)
    const claim = await store.claimTask('tr-2', 'worker-b', 'default', {});
    assert.equal(claim.status, 200);
    assert.equal(store.getTask('tr-2', 'default').assigned_agent, 'worker-b');
  });

  it('2b. restore is scoped: a foreign project scope cannot restore', async () => {
    await store.createTask({ ...taskBody('tr-fx', 'scoped'), project: 'alpha' });
    await store.deleteTask('tr-fx', { caller: { agent_id: 'trash-admin', role: 'admin' }, project: 'alpha' });
    const res = await store.restoreFromTrash('tr-fx', { caller: { agent_id: 'trash-admin', role: 'admin' }, project: 'beta' });
    assert.equal(res.status, 404);
  });

  it('2c. restoring onto a live id conflicts with 409', async () => {
    await store.createTask(taskBody('tr-c', 'v1'));
    await store.deleteTask('tr-c', { caller: { agent_id: 'trash-admin', role: 'admin' } });
    await store.createTask(taskBody('tr-c', 'v2'));
    const res = await store.restoreFromTrash('tr-c', { caller: { agent_id: 'trash-admin', role: 'admin' } });
    assert.equal(res.status, 409);
  });

  it('3. hardDeleteFromTrash permanently removes the row from the sink', async () => {
    await store.createTask(taskBody('tr-3', 'hard'));
    await store.deleteTask('tr-3', { caller: { agent_id: 'trash-admin', role: 'admin' } });
    assert.equal(store.getTrashedTasks('default').length, 1);

    const res = await store.hardDeleteFromTrash('tr-3', { caller: { agent_id: 'trash-admin', role: 'admin' } });
    assert.equal(res.status, 200);
    assert.equal(store.getTrashedTasks('default').length, 0);
  });

  it('4. purgeTasks({hard:true}) bypasses the sink (task gone, trash unchanged)', async () => {
    await store.createTask(taskBody('tr-4', 'soft target'));
    await store.deleteTask('tr-4', { caller: { agent_id: 'trash-admin', role: 'admin' } });
    assert.equal(store.getTrashedTasks('default').length, 1);

    const res = await store.purgeTasks({ caller: { agent_id: 'trash-admin', role: 'admin' }, ids: ['tr-3-ghost'], hard: true });
    assert.equal(res.status, 200);

    // hard purge of a live task
    await store.createTask(taskBody('tr-5', 'hard target'));
    const res2 = await store.purgeTasks({ caller: { agent_id: 'trash-admin', role: 'admin' }, ids: ['tr-5'], hard: true });
    assert.equal(res2.count, 1);
    assert.equal(store.getTask('tr-5', 'default'), null);
    // the earlier soft-deleted row is still parked (hard flag only affected the new purge)
    assert.ok(store.getTrashedTasks('default').some((t) => t.id === 'tr-4'));
  });

  it('5. trash survives a restart (loadStore round-trip)', async () => {
    await store.createTask(taskBody('tr-6', 'durable'));
    await store.deleteTask('tr-6', { caller: { agent_id: 'trash-admin', role: 'admin' } });

    // simulate restart: clear memory, reload from disk
    store.setStorage(null);
    await store.loadStore();
    const list = store.getTrashedTasks('default');
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'tr-6');
  });

  it('6. KANBAN_TRASH_DAYS=0 disables the retention sweep (rows survive)', async () => {
    process.env.KANBAN_TRASH_DAYS = '0';
    try {
      await store.createTask(taskBody('tr-7', 'kept'));
      await store.deleteTask('tr-7', { caller: { agent_id: 'trash-admin', role: 'admin' } });
      await store.runTrashSweep();
      assert.equal(store.getTrashedTasks('default').length, 1);
    } finally { process.env.KANBAN_TRASH_DAYS = '30'; }
  });
});