/**
 * 3.18.1 — GET /api/auth/details and GET /api/health tell a valid token from an
 * invalid one by design. With KANBAN_READ_AUTH=token an invalid bearer /
 * x-api-token presented to either counts a failed-auth strike exactly as an
 * ordinary read would, with the same 429 once the address is over budget.
 * Responses for valid tokens, the unlock header and anonymous callers (every
 * health probe that sends no token) are unchanged.
 */
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { resetAuthLimits, resetRateLimits } from '../middleware/rateLimit.js';
import { createUnlockToken, resetUnlockFailures, resetUnlockKeyMaterial } from '../masterUnlock.js';
import * as store from '../store.js';

const TOKEN = 'details-global-token';
const ALPHA = 'details-alpha-token';
const MASTER = 'details-master-password';
const LIMIT = 3;
const ENV = [
  'KANBAN_STORAGE_BACKEND', 'KANBAN_DEFAULT_PROJECT', 'KANBAN_PROJECT_TOKENS', 'KANBAN_RATE_LIMIT_PER_MIN',
  'KANBAN_AUTH_TOKEN', 'KANBAN_AUTH_SECRET', 'KANBAN_ADMIN_TOKEN', 'KANBAN_READ_AUTH', 'KANBAN_AUTH_RATE_LIMIT_PER_MIN',
  'KANBAN_MASTER_PASSWORD', 'KANBAN_DATA_DIR', 'KANBAN_DATA_FILE',
];

function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function get(baseUrl, route, headers = {}) {
  const res = await fetch(`${baseUrl}${route}`, { headers });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, body, headers: res.headers };
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

function assertThrottled(r) {
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'Too many failed authentication attempts');
  assert.ok(Number(r.headers.get('retry-after')) >= 1, 'carries Retry-After');
}

describe('identify-only routes charge invalid tokens like a read (3.18.1)', () => {
  let saved;
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-detailsthrottle-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ alpha: { token: ALPHA, role: 'builder' } });
    process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN = String(LIMIT);
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  beforeEach(() => {
    process.env.KANBAN_READ_AUTH = 'token';
    delete process.env.KANBAN_MASTER_PASSWORD;
    resetUnlockKeyMaterial();
    resetUnlockFailures();
    resetAuthLimits();
    resetRateLimits();
  });

  afterEach(() => {
    resetAuthLimits();
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    store.setStorage(null);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetUnlockKeyMaterial();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('details: N invalid bearers answer as before, then 429 like a read', async () => {
    for (let i = 0; i < LIMIT; i += 1) {
      const r = await get(baseUrl, '/api/auth/details', bearer(`wrong-${i}`));
      assert.equal(r.status, 200, `strike ${i + 1} keeps the documented body`);
      assert.equal(typeof r.body.details, 'boolean');
    }
    assertThrottled(await get(baseUrl, '/api/auth/details', bearer('wrong-again')));
    // The strikes are the SAME budget an ordinary read uses.
    assertThrottled(await get(baseUrl, '/api/tasks', bearer('wrong-read')));
  });

  it('details strikes and read strikes share one budget (x-api-token too)', async () => {
    for (let i = 0; i < LIMIT; i += 1) {
      assert.equal((await get(baseUrl, '/api/tasks', { 'X-API-Token': `bad-${i}` })).status, 401);
    }
    assertThrottled(await get(baseUrl, '/api/auth/details', { 'X-API-Token': 'bad-x' }));
  });

  it('details: a valid token is still served while the address is over budget, and is never charged', async () => {
    for (let i = 0; i < LIMIT + 1; i += 1) await get(baseUrl, '/api/auth/details', bearer(`wrong-${i}`));
    for (const tok of [TOKEN, ALPHA]) {
      const r = await get(baseUrl, '/api/auth/details', bearer(tok));
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { details: true, unlock: false });
    }
  });

  it('details: anonymous callers are never charged', async () => {
    for (let i = 0; i < LIMIT * 3; i += 1) {
      const r = await get(baseUrl, '/api/auth/details');
      assert.equal(r.status, 200);
    }
    // ...so the first wrong token afterwards is still only strike one.
    assert.equal((await get(baseUrl, '/api/tasks', bearer('wrong'))).status, 401);
  });

  it('details: with read auth off an invalid token is an anonymous read (no strike), as on /api/tasks', async () => {
    process.env.KANBAN_READ_AUTH = 'off';
    for (let i = 0; i < LIMIT * 3; i += 1) {
      assert.equal((await get(baseUrl, '/api/auth/details', bearer(`wrong-${i}`))).status, 200);
    }
    process.env.KANBAN_READ_AUTH = 'token';
    assert.equal((await get(baseUrl, '/api/tasks', bearer('wrong'))).status, 401, 'budget untouched');
  });

  it('details: a valid unlock header with a stray bearer is not charged (it opens reads on its own)', async () => {
    process.env.KANBAN_MASTER_PASSWORD = MASTER;
    const { token: unlock } = createUnlockToken();
    for (let i = 0; i < LIMIT * 2; i += 1) {
      const r = await get(baseUrl, '/api/auth/details', { ...bearer(`stale-${i}`), 'X-Kanban-Unlock': unlock });
      assert.equal(r.status, 200);
      assert.equal(r.body.unlock, true);
      assert.equal(r.body.details, true);
    }
    // Without the unlock the same stray bearer is a strike.
    for (let i = 0; i < LIMIT; i += 1) {
      const r = await get(baseUrl, '/api/auth/details', bearer(`stale-${i}`));
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { details: false, unlock: false });
    }
    assertThrottled(await get(baseUrl, '/api/auth/details', bearer('stale-x')));
  });

  it('health: an invalid token is charged under read auth; probes without a token never are', async () => {
    for (let i = 0; i < LIMIT * 3; i += 1) {
      assert.equal((await get(baseUrl, '/api/health')).status, 200, 'tokenless probe');
      assert.equal((await get(baseUrl, '/healthz')).status, 200, 'tokenless probe');
    }
    for (let i = 0; i < LIMIT; i += 1) {
      const r = await get(baseUrl, '/api/health', bearer(`wrong-${i}`));
      assert.equal(r.status, 200, 'below budget the documented body is unchanged');
      assert.equal(r.body.credential_map.missing, undefined, 'no names for an invalid token');
    }
    assertThrottled(await get(baseUrl, '/api/health', bearer('wrong-x')));
    // Tokenless probes and valid tokens are still served.
    assert.equal((await get(baseUrl, '/api/health')).status, 200);
    assert.equal((await get(baseUrl, '/api/health/ready')).status, 200);
    const valid = await get(baseUrl, '/api/health', bearer(TOKEN));
    assert.equal(valid.status, 200);
    assert.ok(Array.isArray(valid.body.credential_map.missing), 'valid token still sees names (v3.2.0)');
  });

  it('health: with read auth off an invalid token is not charged', async () => {
    process.env.KANBAN_READ_AUTH = 'off';
    for (let i = 0; i < LIMIT * 3; i += 1) {
      assert.equal((await get(baseUrl, '/api/health', bearer(`wrong-${i}`))).status, 200);
    }
    process.env.KANBAN_READ_AUTH = 'token';
    assert.equal((await get(baseUrl, '/api/tasks', bearer('wrong'))).status, 401, 'budget untouched');
  });
});
