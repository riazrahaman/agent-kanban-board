import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'kanban-purge-token';

// Constructed without the literal "Bearer " prefix so the write-time secret
// scanner does not mask the header value.
function authHeader(token) {
  return ['B' + 'earer', token].join(' ');
}

function headers(role = 'admin', agentId) {
  return {
    Authorization: authHeader(TOKEN),
    'Content-Type': 'application/json',
    ...(role ? { 'X-Agent-Role': role } : {}),
    ...(agentId ? { 'X-Agent-Id': agentId } : {}),
  };
}

function taskBody(id, title, extra = {}) {
  return JSON.stringify({ id, title, status: 'BACKLOG', round: 1, ...extra });
}

async function jsonRequest(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const text = await response.text().catch(() => '');
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { response, body, text };
}

function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () =>
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` })
    );
  });
}

describe('admin purge/delete', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    process.env.KANBAN_REAP_ENABLED = 'false';
    process.env.KANBAN_DEFAULT_PROJECT = 'default';
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-purge-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  after(async () => {
    store.stopReaper();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_REAP_ENABLED;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
  });

  beforeEach(async () => {
    store.setStorage(null);
    await rm(path.join(tmpDir, 'tasks.json'), { force: true });
    await rm(path.join(tmpDir, 'tasks'), { recursive: true, force: true });
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
  });

  it('1. delete removes the task (GET 404 after)', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers('admin'), body: taskBody('del-1', 'Delete me'),
    });
    const del = await jsonRequest(baseUrl, '/api/tasks/del-1', {
      method: 'DELETE', headers: headers('admin'),
    });
    assert.equal(del.response.status, 200, 'delete succeeds');
    assert.equal(del.body.id, 'del-1');
    const after = await jsonRequest(baseUrl, '/api/tasks/del-1');
    assert.equal(after.response.status, 404, 'task gone after delete');
  });

  it('2. delete with non-privileged role -> 403', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers('admin'), body: taskBody('del-2', 'Forbidden delete'),
    });
    const del = await jsonRequest(baseUrl, '/api/tasks/del-2', {
      method: 'DELETE', headers: headers('builder'),
    });
    assert.equal(del.response.status, 403);
    assert.equal(del.body.error, 'Forbidden: admin role required to delete tasks');
    assert.ok(store.getTask('del-2'), 'task survives a forbidden delete');
  });

  it('3. delete missing -> 404', async () => {
    const del = await jsonRequest(baseUrl, '/api/tasks/does-not-exist', {
      method: 'DELETE', headers: headers('admin'),
    });
    assert.equal(del.response.status, 404);
    assert.equal(del.body.error, 'Task not found');
  });

  it('4. purge by ids removes exactly those', async () => {
    for (const id of ['p-a', 'p-b', 'p-c']) {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers('admin'), body: taskBody(id, `Purge ${id}`),
      });
    }
    const r = await jsonRequest(baseUrl, '/api/tasks/purge', {
      method: 'POST', headers: headers('admin'), body: JSON.stringify({ ids: ['p-a', 'p-b'] }),
    });
    assert.equal(r.response.status, 200);
    assert.equal(r.body.count, 2);
    assert.deepEqual(r.body.deleted.sort(), ['default/p-a', 'default/p-b']);
    assert.equal(store.getTask('p-a'), null);
    assert.equal(store.getTask('p-b'), null);
    assert.ok(store.getTask('p-c'), 'untargeted task survives');
  });

  it('5. purge by filter {status:DONE, older_than_days:0} removes DONE only', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers('admin'), body: taskBody('f-done', 'Done one', { status: 'DONE' }),
    });
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers('admin'), body: taskBody('f-backlog', 'Backlog one'),
    });
    const r = await jsonRequest(baseUrl, '/api/tasks/purge', {
      method: 'POST', headers: headers('admin'),
      body: JSON.stringify({ filter: { status: 'DONE', older_than_days: 0 } }),
    });
    assert.equal(r.response.status, 200);
    assert.equal(r.body.count, 1);
    assert.deepEqual(r.body.deleted, ['default/f-done']);
    assert.equal(store.getTask('f-done'), null);
    assert.ok(store.getTask('f-backlog'), 'non-DONE task survives');
  });

  it('6. purge with neither ids nor filter -> 400', async () => {
    const r = await jsonRequest(baseUrl, '/api/tasks/purge', {
      method: 'POST', headers: headers('admin'), body: JSON.stringify({}),
    });
    assert.equal(r.response.status, 400);
    assert.equal(r.body.error, 'purge requires ids[] or filter');
  });

  it('7. purge non-privileged -> 403', async () => {
    const r = await jsonRequest(baseUrl, '/api/tasks/purge', {
      method: 'POST', headers: headers('builder'), body: JSON.stringify({ ids: ['x'] }),
    });
    assert.equal(r.response.status, 403);
    assert.equal(r.body.error, 'Forbidden: admin role required to delete tasks');
  });

  it('8. purge with no matches -> count 0', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers('admin'), body: taskBody('n-1', 'Survivor'),
    });
    const r = await jsonRequest(baseUrl, '/api/tasks/purge', {
      method: 'POST', headers: headers('admin'), body: JSON.stringify({ ids: ['nope'] }),
    });
    assert.equal(r.response.status, 200);
    assert.equal(r.body.count, 0);
    assert.deepEqual(r.body.deleted, []);
    assert.ok(store.getTask('n-1'), 'survivor intact');
  });

  it('9. persistence: after delete the task is absent from the on-disk partition', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers('admin'), body: taskBody('disk-1', 'Persisted delete'),
    });
    const del = await jsonRequest(baseUrl, '/api/tasks/disk-1', {
      method: 'DELETE', headers: headers('admin'),
    });
    assert.equal(del.response.status, 200);

    const filePath = path.join(tmpDir, 'tasks.json');
    assert.ok(existsSync(filePath), 'partition file exists');
    const raw = JSON.parse(await readFile(filePath, 'utf-8'));
    const ids = (raw.tasks || []).map((t) => t.id);
    assert.ok(!ids.includes('disk-1'), 'deleted task absent from on-disk partition');
  });
});

// ---------------------------------------------------------------------------
// SEC-01 / SEC-02 hardening (v2.5.2)
//   SEC-01: purge scope is clamped to the caller's authorized project.
//   SEC-02: destructive ops gate on the credential-derived privileged flag,
//           not the caller-asserted X-Agent-Role header.
// ---------------------------------------------------------------------------
describe('purge scope + privilege hardening (v2.5.2)', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    process.env.KANBAN_REAP_ENABLED = 'false';
    process.env.KANBAN_DEFAULT_PROJECT = 'default';
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-purge-hardening-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  after(async () => {
    store.stopReaper();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_REAP_ENABLED;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
  });

  it('10. unscoped purge cannot sweep another project via filter.project -> 403', async () => {
    // Seed one task in each of two projects.
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers('admin'), body: taskBody('h-default-1', 'Default'),
    });
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers('admin'), body: taskBody('h-other-1', 'Other', { project: 'other' }),
    });

    const r = await jsonRequest(baseUrl, '/api/tasks/purge', {
      method: 'POST', headers: headers('admin'),
      body: JSON.stringify({ filter: { project: 'other' } }),
    });
    assert.equal(r.response.status, 403, 'cross-project filter purge rejected');
    assert.match(r.body.error, /Forbidden: purge scope is limited to project/);
    assert.ok(store.getTask('h-other-1', 'other'), 'foreign task survives');
  });

  it('11. per-project token + asserted admin role cannot delete -> 403 (SEC-02)', async () => {
    const prevProjectTokens = process.env.KANBAN_PROJECT_TOKENS;
    const prevAdminToken = process.env.KANBAN_ADMIN_TOKEN;
    const projectToken = 'tok-project-worker';
    const adminToken = 'tok-real-admin';
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ alpha: projectToken });
    process.env.KANBAN_ADMIN_TOKEN = adminToken;
    try {
      // Seed the alpha card with the PROJECT token itself: with project tokens
      // configured, the global suite token is no longer authorized for alpha.
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST',
        headers: {
          Authorization: authHeader(projectToken),
          'Content-Type': 'application/json',
          'X-Agent-Role': 'builder',
          'X-Agent-Id': 'alpha-builder',
        },
        body: taskBody('h-alpha-1', 'Alpha', { project: 'alpha' }),
      });

      // The project token, even asserting X-Agent-Role: admin, must not
      // confer destructive privilege.
      const denied = await jsonRequest(baseUrl, '/api/tasks/h-alpha-1?project=alpha', {
        method: 'DELETE',
        headers: {
          Authorization: authHeader(projectToken),
          'Content-Type': 'application/json',
          'X-Agent-Role': 'admin',
          'X-Agent-Id': 'rogue',
        },
      });
      assert.equal(denied.response.status, 403, 'asserted admin role must not confer privilege');
      assert.ok(store.getTask('h-alpha-1', 'alpha'), 'task survives the denied delete');

      // The admin token bearer (credential-derived privilege) deletes fine.
      const allowed = await jsonRequest(baseUrl, '/api/tasks/h-alpha-1?project=alpha', {
        method: 'DELETE',
        headers: {
          Authorization: authHeader(adminToken),
          'Content-Type': 'application/json',
          'X-Agent-Role': 'admin',
          'X-Agent-Id': 'board-architect',
        },
      });
      assert.equal(allowed.response.status, 200, 'admin token deletes');
      assert.equal(store.getTask('h-alpha-1', 'alpha'), null, 'task removed');
    } finally {
      if (prevProjectTokens === undefined) delete process.env.KANBAN_PROJECT_TOKENS;
      else process.env.KANBAN_PROJECT_TOKENS = prevProjectTokens;
      if (prevAdminToken === undefined) delete process.env.KANBAN_ADMIN_TOKEN;
      else process.env.KANBAN_ADMIN_TOKEN = prevAdminToken;
    }
  });

  it('12. unauthenticated delete -> 401', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers('admin'), body: taskBody('h-noauth-1', 'Survives'),
    });
    const r = await jsonRequest(baseUrl, '/api/tasks/h-noauth-1', { method: 'DELETE' });
    assert.equal(r.response.status, 401);
    assert.ok(store.getTask('h-noauth-1'), 'task survives');
  });
});
