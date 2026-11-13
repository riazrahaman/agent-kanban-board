/**
 * Hard ceiling on failed auth: below AUTH_HARD_CAP_MULTIPLIER x limit failures
 * in a window, valid credentials are still served from an over-limit address;
 * past it, every credential-checked request from that address is refused until
 * the window ends. An explicit 0 disables all of it.
 */
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { proofInput } from '../routes/auth.js';
import { AUTH_HARD_CAP_MULTIPLIER, resetAuthLimits, resetRateLimits } from '../middleware/rateLimit.js';
import * as store from '../store.js';

const TOKEN = 'hardcap-global-token';
const SECRET = 'hardcap-session-secret';
const LIMIT = 2;
const CAP = LIMIT * AUTH_HARD_CAP_MULTIPLIER; // 20

function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function call(baseUrl, route, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Role': 'builder',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json, headers: res.headers };
}

let seq = 0;
const createTask = (baseUrl, token) => call(baseUrl, '/api/tasks', {
  method: 'POST', token, body: { id: `hc-${(seq += 1)}`, title: 't', status: 'BACKLOG', round: 1 },
});

/** Records exactly `n` failures (401 until the limit, 429 after). */
async function fail(baseUrl, n) {
  for (let i = 0; i < n; i += 1) {
    const r = await createTask(baseUrl, 'wrong-token');
    assert.ok(r.status === 401 || r.status === 429, `failure ${i + 1} -> ${r.status}`);
  }
}

function assertThrottled(r) {
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'Too many failed authentication attempts');
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
}

describe('failed-auth hard cap', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    for (const k of ['KANBAN_STORAGE_BACKEND', 'KANBAN_DEFAULT_PROJECT', 'KANBAN_ARCHIVE_AFTER_DAYS', 'KANBAN_PROJECT_TOKENS', 'KANBAN_RATE_LIMIT_PER_MIN']) delete process.env[k];
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-authhardcap-'));
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
    delete process.env.KANBAN_RATE_LIMIT_WINDOW_MS;
    delete process.env.KANBAN_READ_AUTH;
    resetAuthLimits();
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    for (const k of ['KANBAN_AUTH_TOKEN', 'KANBAN_AUTH_SECRET', 'KANBAN_DATA_DIR', 'KANBAN_DATA_FILE']) delete process.env[k];
    store.setStorage(null);
  });

  it('the multiplier is 10', () => {
    assert.equal(AUTH_HARD_CAP_MULTIPLIER, 10);
  });

  it('at the hard cap (not above it) a valid token is still served', async () => {
    await fail(baseUrl, CAP);
    assert.equal((await createTask(baseUrl, TOKEN)).status, 201);
    assertThrottled(await createTask(baseUrl, 'wrong-token')); // this is failure CAP + 1
  });

  it('above the hard cap a valid token gets 429 on mutation, stream-ticket, session and revoke', async () => {
    // Mint a session token first, while still under the cap, to test revoke.
    const nonce = crypto.randomBytes(8).toString('hex');
    const proof = crypto.createHmac('sha256', SECRET).update(proofInput(nonce, 'builder', 'default')).digest('hex');
    const session = await call(baseUrl, '/api/auth/session', { method: 'POST', body: { client_nonce: nonce, proof, role: 'builder' } });
    assert.equal(session.status, 200);

    await fail(baseUrl, CAP + 1);
    assertThrottled(await createTask(baseUrl, TOKEN));
    assertThrottled(await call(baseUrl, '/api/auth/stream-ticket', { method: 'POST', token: TOKEN, body: { role: 'builder' } }));
    const nonce2 = crypto.randomBytes(8).toString('hex');
    const proof2 = crypto.createHmac('sha256', SECRET).update(proofInput(nonce2, 'builder', 'default')).digest('hex');
    assertThrottled(await call(baseUrl, '/api/auth/session', { method: 'POST', body: { client_nonce: nonce2, proof: proof2, role: 'builder' } }));
    assertThrottled(await call(baseUrl, '/api/auth/revoke', { method: 'POST', token: session.body.token }));
  });

  it('above the hard cap gated reads are refused, open reads are not', async () => {
    await fail(baseUrl, CAP + 1);
    assert.equal((await call(baseUrl, '/api/tasks')).status, 200, 'open read');
    process.env.KANBAN_READ_AUTH = 'token';
    assertThrottled(await call(baseUrl, '/api/tasks', { token: TOKEN }));
  });

  it('window expiry restores service', async () => {
    process.env.KANBAN_RATE_LIMIT_WINDOW_MS = '400';
    await fail(baseUrl, CAP + 1);
    assertThrottled(await createTask(baseUrl, TOKEN));
    await new Promise((r) => setTimeout(r, 450));
    assert.equal((await createTask(baseUrl, TOKEN)).status, 201);
    assert.equal((await createTask(baseUrl, 'wrong-token')).status, 401, 'fresh window');
  });

  it('explicit 0 disables the hard cap too', async () => {
    process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN = '0';
    await fail(baseUrl, CAP + 5);
    assert.equal((await createTask(baseUrl, TOKEN)).status, 201);
  });
});
