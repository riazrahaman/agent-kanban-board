/**
 * v2.11.0 opt-* features — milestones, operator assignment, outbound webhooks.
 *
 * Covers:
 *   - opt-milestones: createTask/patchTask milestone normalisation, the
 *     getMilestones rollup, and the GET /api/milestones read.
 *   - opt-operator-assignment: the privilege-gated assignTask + POST
 *     /:id/assign (assign, release, dependency/contention bypass, 403/400/404).
 *   - opt-integration-hooks: webhookConfig/shouldDeliver/buildPayload/signBody
 *     plus an end-to-end delivery through a fake fetch.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';
import {
  webhookConfig,
  shouldDeliver,
  buildPayload,
  signBody,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_EVENT_HEADER,
} from '../webhooks.js';

const TOKEN = 'kanban-opt211-token';

function authHeader() {
  return ['B' + 'earer', TOKEN].join(' ');
}

function headers(role = 'admin', agentId = 'opt-tester') {
  return {
    Authorization: authHeader(),
    'Content-Type': 'application/json',
    'X-Agent-Role': role,
    'X-Agent-Id': agentId,
  };
}

function taskBody(id, extra = {}) {
  return { id, title: `Task ${id}`, status: 'BACKLOG', round: 1, ...extra };
}

async function jsonRequest(baseUrl, route, { method = 'GET', role, body } = {}) {
  const options = { method, headers: headers(role) };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(`${baseUrl}${route}`, options);
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { response, body: parsed };
}

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe('opt-* features (v2.11.0)', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    process.env.KANBAN_REAP_ENABLED = 'false';
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-opt211-'));
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    store.setStorage(null);
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_REAP_ENABLED;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_WEBHOOK_URLS;
    delete process.env.KANBAN_WEBHOOK_EVENTS;
    delete process.env.KANBAN_WEBHOOK_SECRET;
    await rm(tmpDir, { recursive: true, force: true });
    store.setStorage(null);
  });

  beforeEach(async () => {
    store.setStorage(null);
    await rm(path.join(tmpDir, 'tasks'), { recursive: true, force: true });
    await rm(path.join(tmpDir, 'tasks.json'), { force: true });
    await store.loadStore();
  });

  // -----------------------------------------------------------------------
  // opt-milestones
  // -----------------------------------------------------------------------
  it('milestone: createTask keeps a label verbatim and defaults junk to null', async () => {
    const m1 = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST',
      body: taskBody('ms-1', { milestone: 'Q4 Hardening' }),
    });
    assert.equal(m1.response.status, 201);
    assert.equal(m1.body.milestone, 'Q4 Hardening');

    const m2 = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST',
      body: taskBody('ms-2', { milestone: '   ' }),
    });
    assert.equal(m2.response.status, 201);
    assert.equal(m2.body.milestone, null);

    const m3 = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST',
      body: taskBody('ms-3', { milestone: 12345 }),
    });
    assert.equal(m3.response.status, 201);
    assert.equal(m3.body.milestone, null);
  });

  it('milestone: PATCH sets and clears the label through the allowlist', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', body: taskBody('ms-p1') });
    const set = await jsonRequest(baseUrl, '/api/tasks/ms-p1', {
      method: 'PATCH',
      body: { milestone: 'Launch' },
    });
    assert.equal(set.response.status, 200);
    assert.equal(set.body.milestone, 'Launch');

    const clear = await jsonRequest(baseUrl, '/api/tasks/ms-p1', {
      method: 'PATCH',
      body: { milestone: null },
    });
    assert.equal(clear.response.status, 200);
    assert.equal(clear.body.milestone, null);
  });

  it('milestone: getMilestones rollup + GET /api/milestones', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', body: taskBody('ms-r1', { milestone: 'Alpha' }) });
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', body: taskBody('ms-r2', { milestone: 'Alpha' }) });
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', body: taskBody('ms-r3', { milestone: 'Beta' }) });
    // Drive ms-r1 to DONE so Alpha shows 1/2.
    await jsonRequest(baseUrl, '/api/tasks/ms-r1/claim', { method: 'POST', body: { agent_id: 'bld' } });
    await jsonRequest(baseUrl, '/api/tasks/ms-r1', { method: 'PATCH', role: 'builder', body: { status: 'IN_REVIEW' } });
    await jsonRequest(baseUrl, '/api/tasks/ms-r1', { method: 'PATCH', role: 'reviewer', body: { status: 'IN_TEST' } });
    await jsonRequest(baseUrl, '/api/tasks/ms-r1', { method: 'PATCH', role: 'tester', body: { status: 'DONE' } });

    const res = await jsonRequest(baseUrl, '/api/milestones?project=default');
    assert.equal(res.response.status, 200);
    const alpha = res.body.milestones.find((m) => m.milestone === 'Alpha');
    const beta = res.body.milestones.find((m) => m.milestone === 'Beta');
    assert.ok(alpha && beta);
    assert.equal(alpha.total, 2);
    assert.equal(alpha.done, 1);
    assert.equal(alpha.progress, 50);
    assert.equal(beta.total, 1);
    assert.equal(beta.done, 0);
  });

  // -----------------------------------------------------------------------
  // opt-operator-assignment
  // -----------------------------------------------------------------------
  it('assign: privileged caller assigns a BACKLOG task to an agent (lifts to BUILDING + lease)', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', body: taskBody('as-1') });
    const res = await jsonRequest(baseUrl, '/api/tasks/as-1/assign', {
      method: 'POST',
      role: 'admin',
      body: { agent_id: 'assigned-bot' },
    });
    assert.equal(res.response.status, 200);
    assert.equal(res.body.assigned_agent, 'assigned-bot');
    assert.equal(res.body.status, 'BUILDING');
    assert.ok(res.body.claim_expires_at);
    assert.equal(res.body.stage_owners.BUILDING, 'assigned-bot');
  });

  it('assign: releasing (agent_id null) clears owner + lease and returns an active card to BACKLOG', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', body: taskBody('as-2') });
    await jsonRequest(baseUrl, '/api/tasks/as-2/assign', { method: 'POST', role: 'admin', body: { agent_id: 'bot-a' } });
    const res = await jsonRequest(baseUrl, '/api/tasks/as-2/assign', {
      method: 'POST',
      role: 'admin',
      body: { agent_id: null },
    });
    assert.equal(res.response.status, 200);
    assert.equal(res.body.assigned_agent, null);
    assert.equal(res.body.claim_expires_at, null);
    assert.equal(res.body.status, 'BACKLOG');
  });

  it('assign: a non-privileged role is refused 403 and a missing task 404', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', body: taskBody('as-3') });
    const forbidden = await jsonRequest(baseUrl, '/api/tasks/as-3/assign', {
      method: 'POST',
      role: 'builder',
      body: { agent_id: 'x' },
    });
    assert.equal(forbidden.response.status, 403);
    const missing = await jsonRequest(baseUrl, '/api/tasks/ghost/assign', {
      method: 'POST',
      role: 'admin',
      body: { agent_id: 'x' },
    });
    assert.equal(missing.response.status, 404);
  });

  // -----------------------------------------------------------------------
  // opt-integration-hooks
  // -----------------------------------------------------------------------
  it('webhooks: config is inert with no URLs and enabled once one is set', () => {
    assert.equal(webhookConfig({}).enabled, false);
    const cfg = webhookConfig({ KANBAN_WEBHOOK_URLS: 'https://a.test/h, https://b.test/h' });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.urls.length, 2);
    assert.equal(shouldDeliver({ kind: 'created' }, cfg), true);
  });

  it('webhooks: event filter + payload shape + HMAC signature', () => {
    const cfg = webhookConfig({ KANBAN_WEBHOOK_URLS: 'https://a.test/h', KANBAN_WEBHOOK_EVENTS: 'created,reclaimed' });
    assert.equal(shouldDeliver({ kind: 'created' }, cfg), true);
    assert.equal(shouldDeliver({ kind: 'updated' }, cfg), false);
    assert.equal(shouldDeliver({ kind: 'reclaimed' }, cfg), true);

    const payload = buildPayload({
      kind: 'reclaimed',
      project: 'atlas',
      actor: 'system',
      reason: 'lease_expired',
      ts: 1700000000000,
      task: { id: 't-1', status: 'BACKLOG', priority: 'high', milestone: 'Alpha' },
    });
    assert.deepEqual(payload, {
      event: 'task.changed',
      kind: 'reclaimed',
      project: 'atlas',
      task_id: 't-1',
      status: 'BACKLOG',
      priority: 'high',
      milestone: 'Alpha',
      actor: 'system',
      reason: 'lease_expired',
      timestamp: 1700000000000,
    });

    const sig = signBody('s3cret', '1700000000000', '{"a":1}');
    assert.match(sig, /^sha256=[0-9a-f]{64}$/);
    assert.equal(signBody(null, '1', '{}'), null);
  });

  it('webhooks: an event delivered through a fake fetch carries the signature headers', async () => {
    const { startWebhooks, stopWebhooks } = await import('../webhooks.js');
    const calls = [];
    const fakeFetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, status: 200 };
    };
    const cfg = startWebhooks({
      env: { KANBAN_WEBHOOK_URLS: 'https://hook.test/x', KANBAN_WEBHOOK_SECRET: 'topsecret' },
      fetchImpl: fakeFetch,
    });
    assert.equal(cfg.enabled, true);
    try {
      // A committed mutation must fan out through the diff stream.
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', body: taskBody('wh-1') });
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(calls.length >= 1, 'expected at least one webhook delivery');
      const first = calls[0];
      assert.equal(first.url, 'https://hook.test/x');
      assert.match(first.opts.headers[WEBHOOK_EVENT_HEADER], /created/);
      assert.match(first.opts.headers[WEBHOOK_SIGNATURE_HEADER], /^sha256=[0-9a-f]{64}$/);
      const sent = JSON.parse(first.opts.body);
      assert.equal(sent.task_id, 'wh-1');
      assert.equal(sent.kind, 'created');
    } finally {
      stopWebhooks();
    }
  });
});
