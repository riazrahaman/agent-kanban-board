// BUG-02 (v2.5.4): field-type validation on createTask and patchTask.
// A non-string title used to escapeHtml into an empty title, and a non-string
// priority passed through verbatim — which crashed the client's filterTasks
// (toLowerCase on a non-string) and blanked the whole board above the
// ErrorBoundary. The server must reject wrong shapes at the door.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.KANBAN_AUTH_TOKEN = 'kanban-fieldtypes-token';
process.env.KANBAN_REAP_ENABLED = 'false';
process.env.KANBAN_DEFAULT_PROJECT = 'default';
delete process.env.KANBAN_STORAGE_BACKEND;
delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
delete process.env.KANBAN_PROJECT_TOKENS;
delete process.env.KANBAN_ADMIN_TOKEN;

const TOKEN = 'kanban-fieldtypes-token';
const authHeader = ['B' + 'earer', TOKEN].join(' ');
const headers = (role = 'builder', agentId = 'fieldtypes-agent') => ({
  Authorization: authHeader,
  'Content-Type': 'application/json',
  'X-Agent-Role': role,
  'X-Agent-Id': agentId,
});
const taskBody = (id, title, extra = {}) => ({
  id,
  title,
  status: 'BACKLOG',
  round: 1,
  ...extra,
});

let tmpDir;
let server;
let baseUrl;

const { createApp } = await import('../server.js');
const store = await import('../store.js');

async function jsonRequest(route, { method = 'GET', headers: h = headers(), body } = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { response: res, body: parsed };
}

async function startTestServer(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve({ server: s, baseUrl: `http://127.0.0.1:${s.address().port}` });
    });
  });
}

test.before(async () => {
  tmpDir = await mkdtemp(join('/tmp', 'kanban-fieldtypes-'));
  process.env.KANBAN_DATA_DIR = tmpDir;
  process.env.KANBAN_DATA_FILE = join(tmpDir, 'tasks.json');
  store.setStorage(null);
  await store.loadStore();
  ({ server, baseUrl } = await startTestServer(createApp()));
});

test.after(async () => {
  store.stopReaper();
  await new Promise((resolve) => server.close(resolve));
  store.setStorage(null);
  delete process.env.KANBAN_DATA_DIR;
  delete process.env.KANBAN_DATA_FILE;
  await rm(tmpDir, { recursive: true, force: true });
});

test.beforeEach(async () => {
  store.setStorage(null);
  await rm(join(tmpDir, 'tasks.json'), { force: true });
  await rm(join(tmpDir, 'tasks'), { recursive: true, force: true });
  await store.loadStore();
});

test('1. createTask rejects a non-string title with 400', async () => {
  const { response, body } = await jsonRequest('/api/tasks', {
    method: 'POST',
    body: taskBody('ft-1', 42),
  });
  assert.equal(response.status, 400);
  assert.match(body.error, /title must be a non-empty string/);
});

test('2. createTask rejects an empty/whitespace title with 400', async () => {
  for (const title of ['', '   ']) {
    const { response, body } = await jsonRequest('/api/tasks', {
      method: 'POST',
      body: taskBody('ft-2', title),
    });
    assert.equal(response.status, 400, `title ${JSON.stringify(title)}`);
    // '' trips the pre-existing required guard; '   ' trips the new type check.
    assert.match(body.error, /title/);
  }
});

test('3. createTask rejects a non-string priority with 400 (the client-crash shape)', async () => {
  const { response, body } = await jsonRequest('/api/tasks', {
    method: 'POST',
    body: taskBody('ft-3', 'valid title', { priority: { label: 'urgent' } }),
  });
  assert.equal(response.status, 400);
  assert.match(body.error, /priority must be/);
});

test('4. createTask rejects an unknown priority value with 400', async () => {
  const { response, body } = await jsonRequest('/api/tasks', {
    method: 'POST',
    body: taskBody('ft-4', 'valid title', { priority: 'urgent' }),
  });
  assert.equal(response.status, 400);
  assert.match(body.error, /priority must be one of/);
});

test('5. createTask accepts priority case-insensitively and normalises to lowercase', async () => {
  const { response, body } = await jsonRequest('/api/tasks', {
    method: 'POST',
    body: taskBody('ft-5', 'valid title', { priority: 'HIGH' }),
  });
  assert.equal(response.status, 201);
  assert.equal(body.priority, 'high');
});

test('6. createTask rejects a non-string description with 400', async () => {
  const { response, body } = await jsonRequest('/api/tasks', {
    method: 'POST',
    body: taskBody('ft-6', 'valid title', { description: 7 }),
  });
  assert.equal(response.status, 400);
  assert.match(body.error, /description must be a string/);
});

test('7. PATCH rejects a non-string priority with 400 and keeps the old value', async () => {
  await jsonRequest('/api/tasks', {
    method: 'POST',
    body: taskBody('ft-7', 'patch target', { priority: 'low' }),
  });
  const { response, body } = await jsonRequest('/api/tasks/ft-7', {
    method: 'PATCH',
    body: { priority: 99 },
  });
  assert.equal(response.status, 400);
  assert.match(body.error, /priority must be/);
  const read = await jsonRequest('/api/tasks/ft-7');
  assert.equal(read.body.priority, 'low');
});

test('8. PATCH rejects a non-string/empty title with 400 and keeps the old value', async () => {
  await jsonRequest('/api/tasks', {
    method: 'POST',
    body: taskBody('ft-8', 'patch target'),
  });
  for (const title of [123, '', '   ']) {
    const { response } = await jsonRequest('/api/tasks/ft-8', {
      method: 'PATCH',
      body: { title },
    });
    assert.equal(response.status, 400, `title ${JSON.stringify(title)}`);
  }
  const read = await jsonRequest('/api/tasks/ft-8');
  assert.equal(read.body.title, 'patch target');
});

test('9. valid prose PATCHes still work (regression)', async () => {
  await jsonRequest('/api/tasks', {
    method: 'POST',
    body: taskBody('ft-9', 'before'),
  });
  const { response, body } = await jsonRequest('/api/tasks/ft-9', {
    method: 'PATCH',
    body: { title: 'after', description: 'now with prose', priority: 'Medium' },
  });
  assert.equal(response.status, 200);
  assert.equal(body.title, 'after');
  assert.equal(body.priority, 'medium');
});

test('10. client-crash shape end to end: stored priority is always a safe string', async () => {
  const seeded = ['low', 'medium', 'high', 'HIGH', 'Low', null, undefined];
  let i = 0;
  for (const p of seeded) {
    const id = `ft-10-${i++}`;
    const { response } = await jsonRequest('/api/tasks', {
      method: 'POST',
      body: taskBody(id, 'safe', p === undefined ? {} : { priority: p }),
    });
    assert.equal(response.status, 201, `priority ${String(p)}`);
    const read = await jsonRequest(`/api/tasks/${id}`);
    assert.ok(['low', 'medium', 'high'].includes(read.body.priority), `priority ${String(p)} -> ${read.body.priority}`);
    assert.equal(typeof read.body.priority, 'string');
  }
});