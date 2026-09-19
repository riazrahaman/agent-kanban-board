import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'kanban-stageowners-token';

function authHeader(token) {
  return ['B' + 'earer', token].join(' ');
}

function headers(role = 'builder', agentId) {
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
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

describe('KB-stageowners: per-stage ownership provenance', () => {
  let tmpDir;
  let server;
  let baseUrl;
  let realNow;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    process.env.KANBAN_REAP_ENABLED = 'false';
    realNow = () => Date.now();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-stageowners-'));
    store.setStorage(null);
    store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
    await store.loadStore();
    await new Promise((resolve) => {
      server = createApp().listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    store.stopReaper();
    store.setNowFn(realNow);
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_REAP_ENABLED;
    store.setStorage(null);
  });

  it('1. createTask seeds stage_owners to {}', async () => {
    const res = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('so-1', 'Stage owners one'),
    });
    assert.equal(res.response.status, 201);
    assert.deepEqual(res.body.stage_owners, {});
  });

  it('2. claim (builder) records stage_owners.BUILDING === agentId', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('so-2', 'Stage owners two'),
    });
    const claim = await jsonRequest(baseUrl, '/api/tasks/so-2/claim', {
      method: 'POST', headers: headers(undefined, 'builder-a'), body: JSON.stringify({ agent_id: 'builder-a' }),
    });
    assert.equal(claim.response.status, 200);
    assert.equal(claim.body.stage_owners.BUILDING, 'builder-a');
  });

  it('3. builder PATCH IN_REVIEW records the builder agent id', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('so-3', 'Stage owners three'),
    });
    await jsonRequest(baseUrl, '/api/tasks/so-3/claim', {
      method: 'POST', headers: headers(undefined, 'builder-b'), body: JSON.stringify({ agent_id: 'builder-b' }),
    });
    const res = await jsonRequest(baseUrl, '/api/tasks/so-3', {
      method: 'PATCH', headers: headers('builder', 'builder-b'), body: JSON.stringify({ status: 'IN_REVIEW' }),
    });
    assert.equal(res.response.status, 200);
    assert.equal(res.body.stage_owners.IN_REVIEW, 'builder-b');
  });

  it('4. reviewer PATCH IN_TEST records the reviewer agent id', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('so-4', 'Stage owners four'),
    });
    await jsonRequest(baseUrl, '/api/tasks/so-4/claim', {
      method: 'POST', headers: headers(undefined, 'builder-c'), body: JSON.stringify({ agent_id: 'builder-c' }),
    });
    await jsonRequest(baseUrl, '/api/tasks/so-4', {
      method: 'PATCH', headers: headers('builder', 'builder-c'), body: JSON.stringify({ status: 'IN_REVIEW' }),
    });
    const res = await jsonRequest(baseUrl, '/api/tasks/so-4', {
      method: 'PATCH', headers: headers('reviewer', 'reviewer-a'), body: JSON.stringify({ status: 'IN_TEST' }),
    });
    assert.equal(res.response.status, 200);
    assert.equal(res.body.stage_owners.IN_TEST, 'reviewer-a');
  });

  it('5. tester PATCH DONE records the tester agent id', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('so-5', 'Stage owners five'),
    });
    await jsonRequest(baseUrl, '/api/tasks/so-5/claim', {
      method: 'POST', headers: headers(undefined, 'builder-d'), body: JSON.stringify({ agent_id: 'builder-d' }),
    });
    await jsonRequest(baseUrl, '/api/tasks/so-5', {
      method: 'PATCH', headers: headers('builder', 'builder-d'), body: JSON.stringify({ status: 'IN_REVIEW' }),
    });
    await jsonRequest(baseUrl, '/api/tasks/so-5', {
      method: 'PATCH', headers: headers('reviewer', 'reviewer-b'), body: JSON.stringify({ status: 'IN_TEST' }),
    });
    const res = await jsonRequest(baseUrl, '/api/tasks/so-5', {
      method: 'PATCH', headers: headers('tester', 'tester-a'), body: JSON.stringify({ status: 'DONE' }),
    });
    assert.equal(res.response.status, 200);
    assert.equal(res.body.stage_owners.DONE, 'tester-a');
  });

  it('6. all four stage keys present at the end, assigned_agent still the original claimer', async () => {
    const t = store.getTask('so-5');
    assert.deepEqual(t.stage_owners, {
      BUILDING: 'builder-d',
      IN_REVIEW: 'builder-d',
      IN_TEST: 'reviewer-b',
      DONE: 'tester-a',
    });
    assert.equal(t.assigned_agent, 'builder-d', 'lease holder unchanged by transitions');
  });
});
