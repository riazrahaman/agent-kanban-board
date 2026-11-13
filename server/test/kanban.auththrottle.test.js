/**
 * Failed-auth throttling applies only to requests that fail authentication.
 * While an address is over the failed-auth budget, a request whose credential
 * validates is still served and does not touch the counter; a failing request
 * gets the 429 (same body, plus Retry-After). The pre-auth challenge route has
 * no credential and keeps throttling up front.
 */
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { proofInput } from '../routes/auth.js';
import { resetAuthLimits, resetRateLimits, trackedAuthIpCount } from '../middleware/rateLimit.js';
import * as store from '../store.js';

const TOKEN = 'throttle-global-token';
const SECRET = 'throttle-session-secret';
const LIMIT = 3;

function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function call(baseUrl, route, { method = 'GET', token, headers = {}, body } = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Role': 'builder',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json, headers: res.headers };
}

let seq = 0;
const createTask = (baseUrl, token) =>
  call(baseUrl, '/api/tasks', { method: 'POST', token, body: { id: `th-${(seq += 1)}`, title: 't', status: 'BACKLOG', round: 1 } });

async function exhaust(baseUrl) {
  for (let i = 0; i < LIMIT; i += 1) {
    assert.equal((await createTask(baseUrl, 'wrong-token')).status, 401, `failure ${i + 1}`);
  }
}

function assertThrottled(r) {
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'Too many failed authentication attempts');
  assert.equal(typeof r.body.retry_after_ms, 'number');
  assert.ok(Number(r.headers.get('retry-after')) >= 1, 'carries Retry-After');
}

describe('failed-auth throttling spares valid credentials', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    delete process.env.KANBAN_PROJECT_TOKENS;
    delete process.env.KANBAN_RATE_LIMIT_PER_MIN;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-auththrottle-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    process.env.KANBAN_AUTH_SECRET = SECRET;
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  beforeEach(() => {
    process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN = String(LIMIT);
    resetAuthLimits();
    resetRateLimits();
  });

  afterEach(() => {
    delete process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN;
    delete process.env.KANBAN_READ_AUTH;
    resetAuthLimits();
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    for (const k of ['KANBAN_AUTH_TOKEN', 'KANBAN_AUTH_SECRET', 'KANBAN_DATA_DIR', 'KANBAN_DATA_FILE']) delete process.env[k];
    store.setStorage(null);
  });

  it('(a) over the limit, a mutation with a valid token is served', async () => {
    await exhaust(baseUrl);
    const r = await createTask(baseUrl, TOKEN);
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  it('(b) over the limit, a mutation with an invalid or missing token gets 429', async () => {
    await exhaust(baseUrl);
    assertThrottled(await createTask(baseUrl, 'still-wrong'));
    assertThrottled(await createTask(baseUrl, undefined));
  });

  it('(c) a valid request neither clears nor extends the failure window', async () => {
    await exhaust(baseUrl);
    const before = (await createTask(baseUrl, 'wrong-again')).body.retry_after_ms;
    for (let i = 0; i < 5; i += 1) assert.equal((await createTask(baseUrl, TOKEN)).status, 201);
    const r = await createTask(baseUrl, 'wrong-again');
    assertThrottled(r);
    assert.ok(r.body.retry_after_ms <= before, 'window was not extended by valid requests');
    assert.equal(trackedAuthIpCount(), 1);
  });

  it('read-auth path: over the limit, a valid token reads, a missing one gets 429', async () => {
    process.env.KANBAN_READ_AUTH = 'token';
    await exhaust(baseUrl);
    assert.equal((await call(baseUrl, '/api/tasks', { token: TOKEN })).status, 200);
    assertThrottled(await call(baseUrl, '/api/tasks'));
  });

  it('open reads are not throttled for an over-limit address', async () => {
    await exhaust(baseUrl);
    assert.equal((await call(baseUrl, '/api/tasks')).status, 200);
  });

  it('stream-ticket: over the limit, a valid token mints, an invalid one gets 429', async () => {
    await exhaust(baseUrl);
    const ok = await call(baseUrl, '/api/auth/stream-ticket', { method: 'POST', token: TOKEN, body: { role: 'builder' } });
    assert.equal(ok.status, 200);
    assertThrottled(await call(baseUrl, '/api/auth/stream-ticket', { method: 'POST', token: 'nope', body: { role: 'builder' } }));
  });

  it('session: over the limit, a valid proof is served, an invalid proof gets 429', async () => {
    await exhaust(baseUrl);
    const nonce = crypto.randomBytes(8).toString('hex');
    const proof = crypto.createHmac('sha256', SECRET).update(proofInput(nonce, 'builder', 'default')).digest('hex');
    const ok = await call(baseUrl, '/api/auth/session', { method: 'POST', body: { client_nonce: nonce, proof, role: 'builder' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assertThrottled(await call(baseUrl, '/api/auth/session', { method: 'POST', body: { client_nonce: nonce, proof: 'ab'.repeat(32), role: 'builder' } }));

    // revoke follows the same rule with the session token just minted.
    const revoked = await call(baseUrl, '/api/auth/revoke', { method: 'POST', token: ok.body.token });
    assert.equal(revoked.status, 200);
    assertThrottled(await call(baseUrl, '/api/auth/revoke', { method: 'POST', token: 'not-a-session' }));
  });

  it('challenge (pre-auth, no credential) is still throttled up front', async () => {
    assert.equal((await call(baseUrl, '/api/auth/challenge', { method: 'POST' })).status, 200);
    await exhaust(baseUrl);
    assertThrottled(await call(baseUrl, '/api/auth/challenge', { method: 'POST' }));
  });
});
