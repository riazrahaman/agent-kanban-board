/**
 * HMAC session-token auth (variant B) — two-phase handshake + stateless tokens,
 * additive to the existing static-token path.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { proofInput } from '../routes/auth.js';
import * as store from '../store.js';

const SECRET = 'test-session-secret';
const STATIC_TOKEN = 'static-token';

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

function proofFor(secret, clientNonce, role, project) {
  return crypto.createHmac('sha256', secret).update(proofInput(clientNonce, role, project)).digest('hex');
}

describe('HMAC session-token auth (variant B)', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-session-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  afterEach(() => {
    delete process.env.KANBAN_AUTH_SECRET;
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_PROJECT_TOKENS;
    delete process.env.KANBAN_ADMIN_TOKEN;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
  });

  function headers(token, role) {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(role ? { 'X-Agent-Role': role } : {}),
    };
  }

  async function handshake(clientNonce = 'client-nonce-1', role = 'builder', project = 'alpha') {
    return jsonRequest(baseUrl, '/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_nonce: clientNonce,
        proof: proofFor(SECRET, clientNonce, role, project),
        role,
        project,
      }),
    });
  }

  it('(a) 503 when KANBAN_AUTH_SECRET is unset', async () => {
    delete process.env.KANBAN_AUTH_SECRET;
    const r = await jsonRequest(baseUrl, '/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_nonce: 'n', proof: 'p' }),
    });
    assert.equal(r.response.status, 503);
  });

  it('(b) 401 on a wrong proof', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    const r = await jsonRequest(baseUrl, '/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_nonce: 'n', proof: 'deadbeef', role: 'builder', project: 'alpha' }),
    });
    assert.equal(r.response.status, 401);
  });

  it('(c) 200 + usable token on correct proof', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    const r = await handshake();
    assert.equal(r.response.status, 200);
    assert.ok(r.body.token, 'a token is returned');
    assert.ok(r.body.server_nonce, 'a server_nonce is returned');
    assert.ok(r.body.expires_at > Date.now(), 'expires in the future');
    assert.equal(r.body.role, 'builder');
    assert.equal(r.body.project, 'alpha');
  });

  it('(d) a mutation using the issued session token succeeds', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    const hs = await handshake('client-nonce-d', 'builder', 'alpha');
    assert.equal(hs.response.status, 200);

    const r = await jsonRequest(baseUrl, '/api/tasks?project=alpha', {
      method: 'POST',
      headers: headers(hs.body.token, 'builder'),
      body: JSON.stringify({ id: 'sess-1', title: 'Session', status: 'BACKLOG', round: 1 }),
    });
    assert.equal(r.response.status, 201, r.body.error || '');
    assert.equal(r.body.project, 'alpha');
  });

  it('(e) a tampered or expired token fails', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    const hs = await handshake('client-nonce-e', 'builder', 'alpha');
    assert.equal(hs.response.status, 200);
    const token = hs.body.token;

    // Tamper: flip the last MAC hex char.
    const last = token[token.length - 1];
    const flipped = last === '0' ? '1' : '0';
    const tampered = token.slice(0, -1) + flipped;
    const tamperR = await jsonRequest(baseUrl, '/api/tasks?project=alpha', {
      method: 'POST',
      headers: headers(tampered, 'builder'),
      body: JSON.stringify({ id: 'tamper-1', title: 'T', status: 'BACKLOG', round: 1 }),
    });
    assert.equal(tamperR.response.status, 401);

    // Expired: forge a validly-signed token whose exp is in the past. We sign it
    // with the known secret to prove that expiry — not just MAC — is enforced.
    const past = Date.now() - 1000;
    const payload = Buffer.from(
      JSON.stringify({ cn: 'n', sn: 's', exp: past, role: 'builder', project: 'alpha' })
    ).toString('base64url');
    const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    const expiredToken = `${payload}.${mac}`;
    const expiredR = await jsonRequest(baseUrl, '/api/tasks?project=alpha', {
      method: 'POST',
      headers: headers(expiredToken, 'builder'),
      body: JSON.stringify({ id: 'exp-1', title: 'E', status: 'BACKLOG', round: 1 }),
    });
    assert.equal(expiredR.response.status, 401);
  });

  it('(f) static KANBAN_AUTH_TOKEN still works alongside the new path', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    process.env.KANBAN_AUTH_TOKEN = STATIC_TOKEN;

    const staticR = await jsonRequest(baseUrl, '/api/tasks?project=beta', {
      method: 'POST',
      headers: headers(STATIC_TOKEN, 'builder'),
      body: JSON.stringify({ id: 'static-1', title: 'Static', status: 'BACKLOG', round: 1 }),
    });
    assert.equal(staticR.response.status, 201, 'legacy static token still authenticates');

    // A session token still works at the same time.
    const hs = await handshake('client-nonce-f', 'builder', 'beta');
    assert.equal(hs.response.status, 200);
    const sessR = await jsonRequest(baseUrl, '/api/tasks?project=beta', {
      method: 'POST',
      headers: headers(hs.body.token, 'builder'),
      body: JSON.stringify({ id: 'static-2', title: 'Both', status: 'BACKLOG', round: 1 }),
    });
    assert.equal(sessR.response.status, 201, 'session token works alongside the static token');
  });

  it('(g) a session token is bound to its project scope', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    const hs = await handshake('client-nonce-g', 'builder', 'alpha');
    assert.equal(hs.response.status, 200);

    const r = await jsonRequest(baseUrl, '/api/tasks?project=beta', {
      method: 'POST',
      headers: headers(hs.body.token, 'builder'),
      body: JSON.stringify({ id: 'scope-1', title: 'Scope', status: 'BACKLOG', round: 1 }),
    });
    assert.equal(r.response.status, 403, 'alpha-scoped session token cannot write beta');
  });
});
