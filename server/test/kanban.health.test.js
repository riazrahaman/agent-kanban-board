import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function jsonRequest(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

describe('§health GET /api/health', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-health-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
  });

  it('1. returns 200 with an ok body and the documented fields', async () => {
    const { response, body } = await jsonRequest(baseUrl, '/api/health');
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.store_loaded, true);
    assert.equal(typeof body.uptime_seconds, 'number');
    assert.equal(typeof body.tasks_total, 'number');
    assert.equal(typeof body.tasks_live, 'number');
    assert.ok(body.listeners && typeof body.listeners === 'object');
    assert.ok(body.reaper && typeof body.reaper === 'object');
    assert.equal(typeof body.reaper.enabled, 'boolean');
    assert.equal(typeof body.reaper.running, 'boolean');
    assert.equal(typeof body.version, 'string');
    assert.ok(!Number.isNaN(Date.parse(body.timestamp)), 'timestamp is a valid ISO date');
  });

  it('2. is unauthenticated (no token required)', async () => {
    const { response } = await jsonRequest(baseUrl, '/api/health');
    assert.equal(response.status, 200);
  });

  it('3. is read-only: tasks_total is stable across repeated calls', async () => {
    const first = await jsonRequest(baseUrl, '/api/health');
    const second = await jsonRequest(baseUrl, '/api/health');
    assert.equal(first.body.tasks_total, second.body.tasks_total);
    assert.equal(first.body.tasks_live, second.body.tasks_live);
    assert.equal(store.getTasks().length, first.body.tasks_total);
  });

  it('4. /healthz alias returns the same shape', async () => {
    const { response, body } = await jsonRequest(baseUrl, '/healthz');
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.tasks_total, 'number');
    assert.ok(body.reaper);
  });

  // B3 (v3.12.2): the probe counts via the O(1) getTaskCount() instead of the
  // O(n log n) sorted getTasks() copy. The reported numbers must not change.
  // D9 (v3.12.6): KANBAN_REAP_INTERVAL_MS <= 0 disables the reaper, so the
  // probe must not keep reporting `ok` while nothing reclaims stale leases.
  it('6. reports degraded when the reaper is disabled by a non-positive interval', async () => {
    const prev = process.env.KANBAN_REAP_INTERVAL_MS;
    process.env.KANBAN_REAP_INTERVAL_MS = '0';
    try {
      const { response, body } = await jsonRequest(baseUrl, '/api/health');
      assert.equal(response.status, 200);
      assert.equal(body.status, 'degraded');
      assert.equal(body.reaper.enabled, false);
      // The other fields are unchanged by the status decision.
      assert.equal(body.store_loaded, true);
      assert.equal(typeof body.tasks_total, 'number');
      assert.equal(typeof body.version, 'string');
    } finally {
      if (prev === undefined) delete process.env.KANBAN_REAP_INTERVAL_MS;
      else process.env.KANBAN_REAP_INTERVAL_MS = prev;
    }
  });

  it('7. reports ok again once the reaper interval is positive', async () => {
    const prev = process.env.KANBAN_REAP_INTERVAL_MS;
    process.env.KANBAN_REAP_INTERVAL_MS = '30000';
    try {
      const { body } = await jsonRequest(baseUrl, '/api/health');
      assert.equal(body.status, 'ok');
      assert.equal(body.reaper.enabled, true);
    } finally {
      if (prev === undefined) delete process.env.KANBAN_REAP_INTERVAL_MS;
      else process.env.KANBAN_REAP_INTERVAL_MS = prev;
    }
  });

  it('5. tasks_total matches store.getTaskCount() and tracks a new task', async () => {
    const before = await jsonRequest(baseUrl, '/api/health');
    assert.equal(before.body.tasks_total, store.getTaskCount());
    assert.equal(before.body.tasks_live, store.getTaskCount());

    await store.createTask({ id: 'health-count-1', title: 'Count me', status: 'READY', project: 'healthcount', round: 1 });
    const after = await jsonRequest(baseUrl, '/api/health');
    assert.equal(after.body.tasks_total, before.body.tasks_total + 1, 'the new task is counted');
    assert.equal(after.body.tasks_total, store.getTaskCount());
    assert.equal(after.body.tasks_live, store.getTaskCount());
  });
});
