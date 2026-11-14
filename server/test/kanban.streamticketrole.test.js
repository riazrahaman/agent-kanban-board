/**
 * Stream-ticket role resolution and failed-auth throttling defaults.
 *
 * - The ticket mint accepts the role from the `X-Agent-Role` header when the
 *   body carries none (unbound credentials), still refuses privileged roles
 *   where it did before, and does not count a missing/invalid role as a
 *   failed authentication.
 * - The failed-auth limiter is on by default (60 per window); an explicit 0
 *   disables it; successes are not counted; forwarded client addresses get
 *   separate buckets under the default trust-proxy setting.
 */
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { resetAuthLimits, resetRateLimits, trackedAuthIpCount } from '../middleware/rateLimit.js';
import * as store from '../store.js';

const TOKEN = 'global-token-for-tests';
const PROJECT_TOKEN = 'project-token-alpha';

function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function mint(baseUrl, { token = TOKEN, body = {}, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}/api/auth/stream-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, body: json };
}

const ENV_KEYS = [
  'KANBAN_AUTH_RATE_LIMIT_PER_MIN', 'KANBAN_RATE_LIMIT_PER_MIN', 'KANBAN_PROJECT_TOKENS',
  'KANBAN_READ_AUTH', 'KANBAN_AUTH_SECRET', 'KANBAN_TRUST_PROXY',
];

describe('stream ticket role + failed-auth limiter defaults', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    for (const k of ENV_KEYS) delete process.env[k];
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-ticketrole-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    process.env.KANBAN_TRUST_PROXY = '1'; // explicit one-hop trust: the app reads X-Forwarded-For
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  beforeEach(() => {
    resetAuthLimits();
    resetRateLimits();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
  });

  describe('POST /api/auth/stream-ticket role', () => {
    it('global token: body role mints', async () => {
      const r = await mint(baseUrl, { body: { role: 'builder' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.role, 'builder');
    });

    it('global token: X-Agent-Role header is the fallback when the body has no role', async () => {
      const r = await mint(baseUrl, { headers: { 'X-Agent-Role': 'Builder' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.role, 'builder');
    });

    it('body role takes precedence over the header', async () => {
      const r = await mint(baseUrl, { body: { role: 'reviewer' }, headers: { 'X-Agent-Role': 'builder' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.role, 'reviewer');
    });

    it('missing or invalid role is 403 and NOT counted as a failed authentication', async () => {
      const a = await mint(baseUrl);
      assert.equal(a.status, 403);
      const b = await mint(baseUrl, { headers: { 'X-Agent-Role': 'nonsense' } });
      assert.equal(b.status, 403);
      assert.equal(trackedAuthIpCount(), 0, 'no failed-auth bucket was created');
    });

    it('unbound project credential mints its functional role from the header', async () => {
      process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ alpha: PROJECT_TOKEN });
      const r = await mint(baseUrl, { token: PROJECT_TOKEN, body: { project: 'alpha' }, headers: { 'X-Agent-Role': 'builder' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.role, 'builder');
      assert.equal(r.body.project, 'alpha');
    });

    it('project credential still cannot mint a privileged role via body or header', async () => {
      process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ alpha: PROJECT_TOKEN });
      const viaHeader = await mint(baseUrl, { token: PROJECT_TOKEN, body: { project: 'alpha' }, headers: { 'X-Agent-Role': 'admin' } });
      assert.equal(viaHeader.status, 403);
      const viaBody = await mint(baseUrl, { token: PROJECT_TOKEN, body: { project: 'alpha', role: 'admin' } });
      assert.equal(viaBody.status, 403);
    });

    it('global token cannot mint a privileged role via header once project tokens are configured', async () => {
      process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ alpha: PROJECT_TOKEN });
      const viaHeader = await mint(baseUrl, { headers: { 'X-Agent-Role': 'admin' } });
      assert.equal(viaHeader.status, 403);
      const viaBody = await mint(baseUrl, { body: { role: 'admin' } });
      assert.equal(viaBody.status, 403);
      const worker = await mint(baseUrl, { headers: { 'X-Agent-Role': 'builder' } });
      assert.equal(worker.status, 200);
    });

    it('a header-role ticket opens the read-gated event stream', async () => {
      process.env.KANBAN_READ_AUTH = 'token';
      const r = await mint(baseUrl, { headers: { 'X-Agent-Role': 'builder' } });
      assert.equal(r.status, 200);
      const ac = new AbortController();
      const res = await fetch(`${baseUrl}/api/events?ticket=${encodeURIComponent(r.body.ticket)}`, { signal: ac.signal });
      assert.equal(res.status, 200);
      ac.abort();
      const anon = await fetch(`${baseUrl}/api/events`);
      assert.equal(anon.status, 401);
      await anon.body?.cancel();
    });
  });

  describe('failed-auth limiter default', () => {
    async function badMutation(headers = {}) {
      const res = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong', 'X-Agent-Role': 'builder', ...headers },
        body: JSON.stringify({ id: 'x', title: 'x' }),
      });
      await res.body?.cancel();
      return res.status;
    }

    it('unset: the 61st failed attempt in a window gets 429', async () => {
      for (let i = 0; i < 60; i += 1) assert.equal(await badMutation(), 401, `attempt ${i + 1}`);
      assert.equal(await badMutation(), 429);
    });

    it('explicit 0 disables it', async () => {
      process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN = '0';
      for (let i = 0; i < 70; i += 1) assert.equal(await badMutation(), 401, `attempt ${i + 1}`);
      assert.equal(trackedAuthIpCount(), 0);
    });

    it('successful requests are not counted', async () => {
      for (let i = 0; i < 70; i += 1) {
        const r = await mint(baseUrl, { body: { role: 'builder' } });
        assert.equal(r.status, 200, `mint ${i + 1}`);
      }
      assert.equal(trackedAuthIpCount(), 0);
      assert.equal(await badMutation(), 401);
    });

    it('distinct X-Forwarded-For client addresses get separate buckets (explicit one-hop trust proxy)', async () => {
      for (let i = 0; i < 60; i += 1) await badMutation({ 'X-Forwarded-For': '203.0.113.1' });
      assert.equal(await badMutation({ 'X-Forwarded-For': '203.0.113.1' }), 429);
      assert.equal(await badMutation({ 'X-Forwarded-For': '203.0.113.2' }), 401);
      assert.equal(trackedAuthIpCount(), 2);
    });
  });
});
