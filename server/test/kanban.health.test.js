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
});
