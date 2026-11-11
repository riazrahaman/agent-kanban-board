/**
 * D3 (v3.12.6) - idempotent `POST /api/tasks`.
 *
 * The caller-supplied `id` is a natural idempotency handle (a retry collides on
 * the composite key). An `Idempotency-Key` header makes the retry return the
 * ORIGINAL 201 body instead. These cases pin:
 *   - replay: identical body, no duplicate card, no version bump;
 *   - a different key creates a second card;
 *   - a different caller with the same key does NOT replay (namespace isolation);
 *   - TTL expiry releases the key (a retry then hits the natural 409);
 *   - a concurrent duplicate is rejected with 409 in_progress;
 *   - an oversized key is a 400;
 *   - no header preserves the historical 409-on-retry behaviour.
 *
 * Each case uses its own project so the assertions are independent of the order
 * the test runner executes them in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.KANBAN_AUTH_TOKEN = 'kanban-idempotency-token';
process.env.KANBAN_REAP_ENABLED = 'false';
process.env.KANBAN_DEFAULT_PROJECT = 'default';
delete process.env.KANBAN_STORAGE_BACKEND;
delete process.env.KANBAN_PROJECT_TOKENS;
delete process.env.KANBAN_ADMIN_TOKEN;
delete process.env.KANBAN_IDEMPOTENCY_TTL_MS;
delete process.env.KANBAN_IDEMPOTENCY_MAX_ENTRIES;

const TOKEN = 'kanban-idempotency-token';
const authHeader = ['B' + 'earer', TOKEN].join(' ');

function headers(agentId = 'idem-agent', extra = {}) {
  return {
    Authorization: authHeader,
    'Content-Type': 'application/json',
    'X-Agent-Role': 'admin',
    'X-Agent-Id': agentId,
    ...extra,
  };
}

// Project-token callers use the documented `x-api-token` channel (not
// Authorization), so a namespace keyed only on Authorization collapses them.
function apiTokenHeaders(token, agentId = 'idem-agent', extra = {}) {
  return {
    'x-api-token': token,
    'Content-Type': 'application/json',
    'X-Agent-Role': 'builder',
    'X-Agent-Id': agentId,
    ...extra,
  };
}

function taskBody(project, id, extra = {}) {
  return { id, project, title: `Task ${id}`, status: 'BACKLOG', round: 1, ...extra };
}

let tmpDir;
let server;
let baseUrl;

const { createApp } = await import('../server.js');
const store = await import('../store.js');
const { resetIdempotencyState } = await import('../idempotency.js');

async function jsonRequest(route, { method = 'GET', headers: h = headers(), body } = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { response: res, body: parsed };
}

function startTestServer(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve({ server: s, baseUrl: `http://127.0.0.1:${s.address().port}` });
    });
  });
}

test.before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kanban-idempotency-'));
  process.env.KANBAN_DATA_DIR = tmpDir;
  process.env.KANBAN_DATA_FILE = join(tmpDir, 'tasks.json');
  store.setStorage(null);
  await store.loadStore();
  ({ server, baseUrl } = await startTestServer(createApp()));
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(tmpDir, { recursive: true, force: true });
  delete process.env.KANBAN_DATA_DIR;
  delete process.env.KANBAN_DATA_FILE;
  delete process.env.KANBAN_AUTH_TOKEN;
  delete process.env.KANBAN_REAP_ENABLED;
  delete process.env.KANBAN_DEFAULT_PROJECT;
  delete process.env.KANBAN_IDEMPOTENCY_TTL_MS;
  store.setStorage(null);
});

test.beforeEach(() => {
  resetIdempotencyState();
  delete process.env.KANBAN_IDEMPOTENCY_TTL_MS;
});

test('1. replay returns the identical 201 body with no duplicate card or version bump', async () => {
  const project = 'idem-replay';
  const body = taskBody(project, 'idem-replay');
  const first = await jsonRequest('/api/tasks', {
    method: 'POST',
    headers: headers('idem-agent', { 'Idempotency-Key': 'replay-key-1' }),
    body,
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.response.headers.get('idempotency-replayed'), null);
  assert.equal(first.body.id, 'idem-replay');
  const originalVersion = first.body.version;
  assert.equal(typeof originalVersion, 'number');

  const second = await jsonRequest('/api/tasks', {
    method: 'POST',
    headers: headers('idem-agent', { 'idempotency-key': 'replay-key-1' }),
    body,
  });
  assert.equal(second.response.status, 201, 'a replay is a success, not a 409 collision');
  assert.equal(second.response.headers.get('idempotency-replayed'), 'true');
  assert.deepEqual(second.body, first.body, 'the original body is replayed byte-for-byte');

  const stored = store.getTask('idem-replay', project);
  assert.equal(stored.version, originalVersion, 'replaying does not mutate the card');
  const listed = await jsonRequest(`/api/tasks?project=${project}`);
  assert.equal(listed.body.filter((t) => t.id === 'idem-replay').length, 1, 'no duplicate card');
});

test('2. a different key creates a second card', async () => {
  const project = 'idem-keys';
  const first = await jsonRequest('/api/tasks', {
    method: 'POST',
    headers: headers('idem-agent', { 'Idempotency-Key': 'key-a' }),
    body: taskBody(project, 'idem-key-a'),
  });
  assert.equal(first.response.status, 201);

  const second = await jsonRequest('/api/tasks', {
    method: 'POST',
    headers: headers('idem-agent', { 'Idempotency-Key': 'key-b' }),
    body: taskBody(project, 'idem-key-b'),
  });
  assert.equal(second.response.status, 201);
  assert.equal(second.response.headers.get('idempotency-replayed'), null);
  assert.equal(store.getTasks(project).length, 2);
});

test('3. two x-api-token credentials with the same key do NOT replay', async () => {
  const project = 'idem-isolation';
  process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({
    [project]: {
      credentials: [
        { token: 'iso-token-a', role: 'builder' },
        { token: 'iso-token-b', role: 'builder' },
      ],
    },
  });
  try {
    // Same project, same key, same X-Agent-Id: only the credential differs.
    // It must isolate the namespace, or caller B replays A's card and B's card
    // is never created (the 5f787d1 bug).
    const first = await jsonRequest('/api/tasks', {
      method: 'POST',
      headers: apiTokenHeaders('iso-token-a', 'shared-agent', { 'Idempotency-Key': 'shared-key' }),
      body: taskBody(project, 'idem-caller-one'),
    });
    assert.equal(first.response.status, 201);

    const second = await jsonRequest('/api/tasks', {
      method: 'POST',
      headers: apiTokenHeaders('iso-token-b', 'shared-agent', { 'Idempotency-Key': 'shared-key' }),
      body: taskBody(project, 'idem-caller-two'),
    });
    assert.equal(second.response.status, 201);
    assert.equal(second.response.headers.get('idempotency-replayed'), null);
    assert.equal(second.body.id, 'idem-caller-two');
    assert.equal(store.getTasks(project).length, 2);

    // A true duplicate in the second caller's namespace is still caught.
    const third = await jsonRequest('/api/tasks', {
      method: 'POST',
      headers: apiTokenHeaders('iso-token-b', 'shared-agent', { 'Idempotency-Key': 'shared-key' }),
      body: taskBody(project, 'idem-caller-two'),
    });
    assert.equal(third.response.status, 201);
    assert.equal(third.response.headers.get('idempotency-replayed'), 'true');
    assert.equal(third.body.id, 'idem-caller-two');
  } finally {
    delete process.env.KANBAN_PROJECT_TOKENS;
  }
});

test('3b. the same credential via Authorization or x-api-token replays', async () => {
  const project = 'idem-channel';
  process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({
    [project]: { token: 'channel-token', role: 'builder' },
  });
  try {
    const body = taskBody(project, 'idem-channel');
    const first = await jsonRequest('/api/tasks', {
      method: 'POST',
      headers: {
        Authorization: ['B' + 'earer', 'channel-token'].join(' '),
        'Content-Type': 'application/json',
        'X-Agent-Id': 'channel-agent',
        'Idempotency-Key': 'channel-key',
      },
      body,
    });
    assert.equal(first.response.status, 201);

    // Same token, different channel: the resolved credential is the identity,
    // so this must replay rather than 409 on the id collision.
    const second = await jsonRequest('/api/tasks', {
      method: 'POST',
      headers: apiTokenHeaders('channel-token', 'channel-agent', { 'Idempotency-Key': 'channel-key' }),
      body,
    });
    assert.equal(second.response.status, 201);
    assert.equal(second.response.headers.get('idempotency-replayed'), 'true');
    assert.equal(second.body.id, 'idem-channel');
    assert.equal(store.getTasks(project).length, 1);
  } finally {
    delete process.env.KANBAN_PROJECT_TOKENS;
  }
});

test('4. TTL expiry releases the key (retry hits the natural id collision)', async () => {
  process.env.KANBAN_IDEMPOTENCY_TTL_MS = '20';
  const project = 'idem-ttl';
  const body = taskBody(project, 'idem-ttl');
  const first = await jsonRequest('/api/tasks', {
    method: 'POST',
    headers: headers('idem-agent', { 'Idempotency-Key': 'ttl-key' }),
    body,
  });
  assert.equal(first.response.status, 201);

  await new Promise((resolve) => { setTimeout(resolve, 50); });

  const second = await jsonRequest('/api/tasks', {
    method: 'POST',
    headers: headers('idem-agent', { 'Idempotency-Key': 'ttl-key' }),
    body,
  });
  assert.equal(second.response.status, 409, 'past the TTL the create is attempted again');
  assert.equal(second.response.headers.get('idempotency-replayed'), null);
  assert.equal(store.getTasks(project).length, 1, 'still exactly one card');
});

test('5. a concurrent duplicate gets 409 idempotency_key_in_progress', async () => {
  const project = 'idem-concurrent';
  const body = taskBody(project, 'idem-concurrent');
  const opts = {
    method: 'POST',
    headers: headers('idem-agent', { 'Idempotency-Key': 'concurrent-key' }),
    body: JSON.stringify(body),
  };
  const [a, b] = await Promise.all([
    fetch(`${baseUrl}/api/tasks`, opts),
    fetch(`${baseUrl}/api/tasks`, opts),
  ]);
  const statuses = [a.status, b.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [201, 409], 'exactly one create and one in-progress rejection');
  const rejected = a.status === 409 ? a : b;
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.error, 'idempotency_key_in_progress');
  assert.equal(store.getTasks(project).length, 1, 'the concurrent duplicate never double-creates');
});

test('6. an oversized Idempotency-Key is a 400', async () => {
  const { response } = await jsonRequest('/api/tasks', {
    method: 'POST',
    headers: headers('idem-agent', { 'Idempotency-Key': 'k'.repeat(201) }),
    body: taskBody('idem-oversized', 'idem-oversized'),
  });
  assert.equal(response.status, 400);
  assert.equal(store.getTasks('idem-oversized').length, 0);
});

test('7. no header keeps the historical behaviour (retry collides on the id)', async () => {
  const project = 'idem-noheader';
  const body = taskBody(project, 'idem-no-header');
  const first = await jsonRequest('/api/tasks', { method: 'POST', body });
  assert.equal(first.response.status, 201);

  const second = await jsonRequest('/api/tasks', { method: 'POST', body });
  assert.equal(second.response.status, 409);
  assert.match(second.body.error, /already exists/);
  assert.equal(second.response.headers.get('idempotency-replayed'), null);
});

test('8. the same key with a different body is 409 idempotency_key_reuse', async () => {
  const project = 'idem-reuse';
  const first = await jsonRequest('/api/tasks', {
    method: 'POST',
    headers: headers('idem-agent', { 'Idempotency-Key': 'reuse-key' }),
    body: taskBody(project, 'idem-reuse-one', { title: 'first payload' }),
  });
  assert.equal(first.response.status, 201);

  const second = await jsonRequest('/api/tasks', {
    method: 'POST',
    headers: headers('idem-agent', { 'Idempotency-Key': 'reuse-key' }),
    body: taskBody(project, 'idem-reuse-two', { title: 'different payload' }),
  });
  assert.equal(second.response.status, 409);
  assert.equal(second.body.error, 'idempotency_key_reuse');
  assert.equal(second.response.headers.get('idempotency-replayed'), null);
  assert.equal(store.getTasks(project).length, 1, 'the different body never creates a card');
});

test('9. a failed create releases the key for a corrected retry', async () => {
  const project = 'idem-retry';
  // Missing id/title -> 400. The in-flight reservation must be released (a
  // no-op failIdempotentCreate leaves it in-flight and the retry gets 409).
  const failed = await jsonRequest('/api/tasks', {
    method: 'POST',
    headers: headers('idem-agent', { 'Idempotency-Key': 'retry-key' }),
    body: { project },
  });
  assert.equal(failed.response.status, 400);

  const retried = await jsonRequest('/api/tasks', {
    method: 'POST',
    headers: headers('idem-agent', { 'Idempotency-Key': 'retry-key' }),
    body: taskBody(project, 'idem-retried'),
  });
  assert.equal(retried.response.status, 201);
  assert.equal(retried.response.headers.get('idempotency-replayed'), null);
  assert.equal(retried.body.id, 'idem-retried');
  assert.equal(store.getTasks(project).length, 1);
});
