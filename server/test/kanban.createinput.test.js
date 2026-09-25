// v2.5.8 (BUG-03 / BUG-04 / BUG-05 / SEC-04): createTask is the one write path
// that took no caller and trusted its body almost entirely.
//   BUG-03 — any token holder could mint a card directly in BUILDING /
//            IN_REVIEW / IN_TEST / DONE, skipping claim + role + deps.
//   BUG-04 — a caller-supplied assigned_agent stuck to a BACKLOG card with no
//            lease, making it unclaimable forever while looking assigned.
//   SEC-04 — caller-supplied stage_owners / agent_logs / comments forged audit
//            provenance for work nobody did.
//   BUG-05 — round/depends_on/metadata shapes and title/description length
//            were unbounded or silently coerced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.KANBAN_AUTH_TOKEN = 'kanban-createinput-token';
process.env.KANBAN_REAP_ENABLED = 'false';
process.env.KANBAN_DEFAULT_PROJECT = 'default';
delete process.env.KANBAN_STORAGE_BACKEND;
delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
delete process.env.KANBAN_PROJECT_TOKENS;
delete process.env.KANBAN_ADMIN_TOKEN;

const TOKEN = 'kanban-createinput-token';
const authHeader = ['B' + 'earer', TOKEN].join(' ');
const headers = (role = 'builder', agentId = 'createinput-agent') => ({
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
  tmpDir = await mkdtemp(join('/tmp', 'kanban-createinput-'));
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

// --- BUG-03: direct creation in a work state requires privilege -------------

test('1. creating a task in BUILDING as a builder is 403', async () => {
  const { response, body } = await jsonRequest('/api/tasks', {
    method: 'POST',
    headers: headers('builder'),
    body: taskBody('ci-1', 'Skip the claim', { status: 'BUILDING' }),
  });
  assert.equal(response.status, 403);
  assert.match(body.error, /requires a privileged role/);
  assert.equal(store.getTask('ci-1'), null);
});

test('2. direct DONE / IN_TEST / IN_REVIEW creation is 403 for a builder', async () => {
  for (const status of ['DONE', 'IN_TEST', 'IN_REVIEW']) {
    const { response } = await jsonRequest('/api/tasks', {
      method: 'POST',
      headers: headers('reviewer'),
      body: taskBody(`ci-2-${status}`, 'Fabricated', { status }),
    });
    assert.equal(response.status, 403, `status ${status}`);
  }
});

test('3. an admin may create a task directly in an active status', async () => {
  const { response, body } = await jsonRequest('/api/tasks', {
    method: 'POST',
    headers: headers('admin'),
    body: taskBody('ci-3', 'Imported work', { status: 'BUILDING' }),
  });
  assert.equal(response.status, 201);
  assert.equal(body.status, 'BUILDING');
});

test('4. BACKLOG and BLOCKED stay open to unprivileged creation', async () => {
  const backlog = await jsonRequest('/api/tasks', {
    method: 'POST',
    headers: headers('builder'),
    body: taskBody('ci-4a', 'Normal card'),
  });
  assert.equal(backlog.response.status, 201);
  const blocked = await jsonRequest('/api/tasks', {
    method: 'POST',
    headers: headers('builder'),
    body: taskBody('ci-4b', 'Parked card', { status: 'BLOCKED' }),
  });
  assert.equal(blocked.response.status, 201);
});

// --- BUG-04: ownership is written only by a claim ---------------------------

test('5. a caller-supplied assigned_agent is ignored at create', async () => {
  const { response, body } = await jsonRequest('/api/tasks', {
    method: 'POST',
    body: taskBody('ci-5', 'Nobody owns this', { assigned_agent: 'phantom-owner' }),
  });
  assert.equal(response.status, 201);
  assert.equal(body.assigned_agent, null);
  assert.equal(store.getTask('ci-5').assigned_agent, null);
});

test('6. a created BACKLOG card is still claimable (no phantom contention)', async () => {
  await jsonRequest('/api/tasks', {
    method: 'POST',
    body: taskBody('ci-6', 'Claim me', { assigned_agent: 'phantom-owner' }),
  });
  const { response, body } = await jsonRequest('/api/tasks/ci-6/claim', {
    method: 'POST',
    headers: headers('builder', 'real-claimer'),
    body: { agent_id: 'real-claimer' },
  });
  assert.equal(response.status, 200);
  assert.equal(body.assigned_agent, 'real-claimer');
});

// --- SEC-04: audit provenance cannot be forged at create --------------------

test('7. caller-supplied agent_logs/comments/stage_owners are dropped at create', async () => {
  const { response, body } = await jsonRequest('/api/tasks', {
    method: 'POST',
    body: taskBody('ci-7', 'Forged history', {
      agent_logs: [{ timestamp: '2020-01-01T00:00:00.000Z', message: 'fake', agent_id: 'x' }],
      comments: [{ timestamp: '2020-01-01T00:00:00.000Z', message: 'fake comment', agent_id: 'x' }],
      stage_owners: { BUILDING: 'ghost', DONE: 'ghost' },
    }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(body.agent_logs, []);
  assert.deepEqual(body.comments, []);
  assert.deepEqual(body.stage_owners, {});
});

// --- BUG-05: shape + bound validation --------------------------------------

test('8. a non-array depends_on is rejected (not silently dropped)', async () => {
  const { response, body } = await jsonRequest('/api/tasks', {
    method: 'POST',
    body: taskBody('ci-8', 'Bad deps', { depends_on: 'ci-3' }),
  });
  assert.equal(response.status, 400);
  assert.match(body.error, /depends_on must be an array/);
});

test('9. a depends_on array with a non-string entry is rejected', async () => {
  const { response } = await jsonRequest('/api/tasks', {
    method: 'POST',
    body: taskBody('ci-9', 'Bad dep entry', { depends_on: ['ok-dep', 7] }),
  });
  assert.equal(response.status, 400);
});

test('10. a non-object metadata is rejected', async () => {
  for (const metadata of ['just a string', [1, 2, 3], 42]) {
    const { response } = await jsonRequest('/api/tasks', {
      method: 'POST',
      body: taskBody(`ci-10-${Math.random().toString(36).slice(2)}`, 'Bad meta', { metadata }),
    });
    assert.equal(response.status, 400, `metadata ${JSON.stringify(metadata)}`);
  }
});

test('11. an oversized metadata blob is rejected', async () => {
  const { response } = await jsonRequest('/api/tasks', {
    method: 'POST',
    body: taskBody('ci-11', 'Big meta', { metadata: { blob: 'x'.repeat(9000) } }),
  });
  assert.equal(response.status, 400);
});

test('12. an oversized title is rejected', async () => {
  const { response } = await jsonRequest('/api/tasks', {
    method: 'POST',
    body: taskBody('ci-12', 'y'.repeat(201)),
  });
  assert.equal(response.status, 400);
});

test('13. PATCH applies the same depends_on / metadata shape rules', async () => {
  await jsonRequest('/api/tasks', { method: 'POST', body: taskBody('ci-13', 'Patch target') });
  const deps = await jsonRequest('/api/tasks/ci-13', {
    method: 'PATCH',
    headers: headers('builder'),
    body: { depends_on: 'oops' },
  });
  assert.equal(deps.response.status, 400);
  const meta = await jsonRequest('/api/tasks/ci-13', {
    method: 'PATCH',
    headers: headers('builder'),
    body: { metadata: 'oops' },
  });
  assert.equal(meta.response.status, 400);
});

test('14. a well-formed create still succeeds with all fields intact', async () => {
  const { response, body } = await jsonRequest('/api/tasks', {
    method: 'POST',
    body: taskBody('ci-14', 'Healthy card', {
      description: 'A perfectly ordinary description.',
      priority: 'high',
      depends_on: ['ci-4a'],
      metadata: { estimate: 5, area: 'board' },
      branch: 'fix/ci-14',
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(body.priority, 'high');
  assert.deepEqual(body.depends_on, ['ci-4a']);
  assert.deepEqual(body.metadata, { estimate: 5, area: 'board' });
  assert.equal(body.branch, 'fix/ci-14');
  assert.equal(body.assigned_agent, null);
});
