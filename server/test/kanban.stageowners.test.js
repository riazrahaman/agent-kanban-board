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
  return JSON.stringify({ id, title, status: 'READY', round: 1, ...extra });
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
    // Hermetic on both roots (see kanban.nextclaim.test.js): loadStore()
    // enumerates jsonDataDir()/tasks (named projects) into the live array, so
    // without the dir pin real checkout data can leak in — and writes can leak
    // out — of this suite.
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_DATA_DIR = tmpDir;
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
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DATA_DIR;
    store.setStorage(null);
  });

  it('1. createTask seeds stage_owners to {}', async () => {
    const res = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('so-1', 'Stage owners one'),
    });
    assert.equal(res.response.status, 201);
    assert.deepEqual(res.body.stage_owners, {});
  });

  it('2. claim (builder) records stage_owners.IN_PROGRESS === agentId', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('so-2', 'Stage owners two'),
    });
    const claim = await jsonRequest(baseUrl, '/api/tasks/so-2/claim', {
      method: 'POST', headers: headers(undefined, 'builder-a'), body: JSON.stringify({ agent_id: 'builder-a' }),
    });
    assert.equal(claim.response.status, 200);
    assert.equal(claim.body.stage_owners.IN_PROGRESS, 'builder-a');
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

  it('4. reviewer PATCH VALIDATION records the reviewer agent id', async () => {
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
      method: 'PATCH', headers: headers('reviewer', 'reviewer-a'), body: JSON.stringify({ status: 'VALIDATION' }),
    });
    assert.equal(res.response.status, 200);
    assert.equal(res.body.stage_owners.VALIDATION, 'reviewer-a');
  });

  it('5. tester PATCH READY_TO_SHIP and releaser PATCH DONE records agents', async () => {
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
      method: 'PATCH', headers: headers('reviewer', 'reviewer-b'), body: JSON.stringify({ status: 'VALIDATION' }),
    });
    const resShip = await jsonRequest(baseUrl, '/api/tasks/so-5', {
      method: 'PATCH', headers: headers('tester', 'tester-a'), body: JSON.stringify({ status: 'READY_TO_SHIP' }),
    });
    assert.equal(resShip.response.status, 200);
    const resDone = await jsonRequest(baseUrl, '/api/tasks/so-5', {
      method: 'PATCH', headers: headers('releaser', 'releaser-a'), body: JSON.stringify({ status: 'DONE' }),
    });
    assert.equal(resDone.response.status, 200);
    assert.equal(resDone.body.stage_owners.DONE, 'releaser-a');
  });

  it('6. all stage keys present at the end; custody ends with the releaser', async () => {
    const t = store.getTask('so-5');
    // v3.9.4: READY_TO_SHIP is an active status, so the tester who moved the card
    // there is recorded. That was the point of adding it to ACTIVE_STATUSES.
    assert.deepEqual(t.stage_owners, {
      IN_PROGRESS: 'builder-d',
      IN_REVIEW: 'builder-d',
      VALIDATION: 'reviewer-b',
      READY_TO_SHIP: 'tester-a',
      DONE: 'releaser-a',
    });
    // v3.21.0: lease custody follows the stage — each expected-role transition
    // transferred assigned_agent, so the releaser holds it at DONE.
    assert.equal(t.assigned_agent, 'releaser-a');
  });

  it('7. custody transfers on each forward edge and releases on rejection', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('so-7', 'Custody chain'),
    });
    await jsonRequest(baseUrl, '/api/tasks/so-7/claim', {
      method: 'POST', headers: headers(undefined, 'builder-e'), body: JSON.stringify({ agent_id: 'builder-e' }),
    });
    const patch = (role, agent, status) => jsonRequest(baseUrl, '/api/tasks/so-7', {
      method: 'PATCH', headers: headers(role, agent), body: JSON.stringify({ status }),
    });
    // Builder submits for review: builder is the expected IN_REVIEW worker, so
    // custody stays with the claim holder.
    let res = await patch('builder', 'builder-e', 'IN_REVIEW');
    assert.equal(res.response.status, 200);
    assert.equal(res.body.assigned_agent, 'builder-e', 'builder keeps custody through IN_REVIEW');
    // Reviewer validates: custody transfers to the reviewer with a live lease.
    res = await patch('reviewer', 'reviewer-c', 'VALIDATION');
    assert.equal(res.response.status, 200);
    assert.equal(res.body.assigned_agent, 'reviewer-c', 'VALIDATION transfers custody to the reviewer');
    assert.ok(Date.parse(res.body.claim_expires_at) > Date.now(), 'transferred lease is live');
    // Tester rejects back to IN_PROGRESS: ownership is RELEASED, not handed to
    // the rejector — the card returns to the claimable pool for the builder.
    res = await patch('tester', 'tester-b', 'IN_PROGRESS');
    assert.equal(res.response.status, 200);
    assert.equal(res.body.assigned_agent, null, 'rejection releases ownership to the pool');
    assert.equal(res.body.claim_expires_at, null);
    assert.equal(res.body.claim_lease_ms, null);
    // The builder re-claims the ownerless IN_PROGRESS card without a 409.
    const reclaim = await jsonRequest(baseUrl, '/api/tasks/so-7/claim', {
      method: 'POST', headers: headers(undefined, 'builder-e'), body: JSON.stringify({ agent_id: 'builder-e' }),
    });
    assert.equal(reclaim.response.status, 200, 'released card is claimable by the builder');
    assert.equal(reclaim.body.assigned_agent, 'builder-e');
  });

  it('8. a privileged transition keeps the existing owner (lifecycle repair)', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('so-8', 'Privileged patch'),
    });
    await jsonRequest(baseUrl, '/api/tasks/so-8/claim', {
      method: 'POST', headers: headers(undefined, 'builder-f'), body: JSON.stringify({ agent_id: 'builder-f' }),
    });
    const res = await jsonRequest(baseUrl, '/api/tasks/so-8', {
      method: 'PATCH', headers: headers('admin', 'ops-1'), body: JSON.stringify({ status: 'IN_REVIEW' }),
    });
    assert.equal(res.response.status, 200);
    assert.equal(res.body.assigned_agent, 'builder-f', 'admin repair does not steal or release the lease');
  });
});
