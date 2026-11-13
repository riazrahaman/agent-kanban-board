/**
 * SEC-04 (v3.12.11): in per-project token mode, a privileged role DECLARED in
 * the X-Agent-Role header on an unbound project credential confers no
 * privilege for the role matrix or the per-agent claim cap. The admin token
 * keeps full privilege; a functional header role on the same credential keeps
 * working.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.KANBAN_REAP_ENABLED = 'false';

const { createApp } = await import('../server.js');
const store = await import('../store.js');
const { resetRateLimits } = await import('../middleware/rateLimit.js');

const PROJECT = 'sec4';
const UNBOUND = 'tok-sec4-unbound';
const ADMIN_TOKEN = 'tok-sec4-admin';

function headers(token, role, agentId) {
  return {
    Authorization: ['B' + 'earer', token].join(' '),
    'Content-Type': 'application/json',
    ...(role ? { 'X-Agent-Role': role } : {}),
    ...(agentId ? { 'X-Agent-Id': agentId } : {}),
  };
}

async function req(baseUrl, route, { method = 'GET', hdrs = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method, headers: hdrs, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  return { status: response.status, body: parsed };
}

describe('SEC-04 privileged header role on an unbound project credential', { concurrency: 1 }, () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_SESSION_SECRET;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-sec4-'));
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ [PROJECT]: { credentials: [{ token: UNBOUND }] } });
    process.env.KANBAN_ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.KANBAN_MAX_CLAIMS_PER_AGENT = '1';
    resetRateLimits?.();
    store.setStorage(null);
    await store.loadStore();
    await new Promise((resolve) => {
      server = createApp().listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    delete process.env.KANBAN_PROJECT_TOKENS;
    delete process.env.KANBAN_ADMIN_TOKEN;
    delete process.env.KANBAN_MAX_CLAIMS_PER_AGENT;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeTask(id) {
    const r = await req(baseUrl, `/api/tasks?project=${PROJECT}`, {
      method: 'POST', hdrs: headers(ADMIN_TOKEN, 'admin', 'ops'),
      body: { id, title: id, status: 'READY', round: 1, project: PROJECT },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }

  it('role matrix: header admin on an unbound credential cannot set BLOCKED; the admin token can', async () => {
    await makeTask('m1');
    const denied = await req(baseUrl, `/api/tasks/m1?project=${PROJECT}`, {
      method: 'PATCH', hdrs: headers(UNBOUND, 'admin', 'w1'), body: { status: 'BLOCKED' },
    });
    assert.equal(denied.status, 403);
    const allowed = await req(baseUrl, `/api/tasks/m1?project=${PROJECT}`, {
      method: 'PATCH', hdrs: headers(ADMIN_TOKEN, 'admin', 'ops'), body: { status: 'BLOCKED' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.status, 'BLOCKED');
  });

  it('claim cap: header admin on an unbound credential is capped on /claim and /next-claim', async () => {
    await makeTask('c1');
    await makeTask('c2');
    const first = await req(baseUrl, `/api/tasks/c1/claim?project=${PROJECT}`, {
      method: 'POST', hdrs: headers(UNBOUND, 'admin', 'hoarder'), body: {},
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await req(baseUrl, `/api/tasks/c2/claim?project=${PROJECT}`, {
      method: 'POST', hdrs: headers(UNBOUND, 'admin', 'hoarder'), body: {},
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.reason, 'claim_limit');
    const next = await req(baseUrl, `/api/tasks/next-claim?project=${PROJECT}`, {
      method: 'POST', hdrs: headers(UNBOUND, 'admin', 'hoarder'), body: {},
    });
    assert.equal(next.status, 409);
    assert.equal(next.body.reason, 'claim_limit');
  });

  it('a functional header role on the unbound credential keeps working', async () => {
    await makeTask('f1');
    const claimed = await req(baseUrl, `/api/tasks/f1/claim?project=${PROJECT}`, {
      method: 'POST', hdrs: headers(UNBOUND, 'builder', 'b1'), body: {},
    });
    assert.equal(claimed.status, 200);
    const review = await req(baseUrl, `/api/tasks/f1?project=${PROJECT}`, {
      method: 'PATCH', hdrs: headers(UNBOUND, 'builder', 'b1'), body: { status: 'IN_REVIEW' },
    });
    assert.equal(review.status, 200);
  });
});
