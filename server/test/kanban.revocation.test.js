/**
 * ENH-12 (v2.10.0) — session-token revocation. A `jti` deny-list lets a holder
 * kill a session before its natural expiry. Tokens minted before revocation
 * existed carry no `jti` and remain valid-but-irrevocable.
 *
 * Also covers the pure helpers in sessionAuth.js directly so the deny-list
 * semantics are pinned without a server round-trip.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { proofInput } from '../routes/auth.js';
import {
  createSessionToken,
  revokeSessionToken,
  revokedSessionCount,
  resetRevokedSessions,
  verifySessionToken,
} from '../sessionAuth.js';
import * as store from '../store.js';

const SECRET = 'test-revocation-secret';

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

describe('ENH-12 session-token revocation', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-revoke-'));
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
    resetRevokedSessions();
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

  async function handshake(clientNonce, role = 'builder', project = 'alpha') {
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

  it('(a) createSessionToken now mints a jti and verify returns it', () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    const created = createSessionToken({ clientNonce: 'n', serverNonce: 's', role: 'builder', project: 'alpha' });
    assert.ok(created.jti && created.jti.length === 32, 'a 16-byte hex jti is returned');
    const verified = verifySessionToken(created.token);
    assert.equal(verified.role, 'builder');
    assert.equal(verified.project, 'alpha');
    assert.equal(verified.jti, created.jti);
  });

  it('(b) a revoked token fails verification even with a valid MAC', () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    const created = createSessionToken({ clientNonce: 'n', serverNonce: 's', role: 'builder', project: 'alpha' });
    assert.ok(verifySessionToken(created.token), 'valid before revocation');
    const jti = revokeSessionToken(created.token);
    assert.equal(jti, created.jti);
    assert.equal(verifySessionToken(created.token), null, 'rejected after revocation');
  });

  it('(c) revokeSessionToken returns null for a legacy token with no jti', () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    const payload = Buffer.from(JSON.stringify({ cn: 'n', sn: 's', exp: Date.now() + 60_000, role: 'builder', project: 'alpha' })).toString('base64url');
    const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    const legacy = `${payload}.${mac}`;
    assert.ok(verifySessionToken(legacy), 'a legacy token still verifies');
    assert.equal(revokeSessionToken(legacy), null, 'but cannot be revoked');
  });

  it('(d) revokeSessionToken returns null for malformed / expired tokens', () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    assert.equal(revokeSessionToken('not-a-token'), null);
    assert.equal(revokeSessionToken('a.b'), null);
    const past = Date.now() - 1000;
    const payload = Buffer.from(JSON.stringify({ jti: 'deadbeef', exp: past, role: 'builder', project: 'alpha' })).toString('base64url');
    const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    assert.equal(revokeSessionToken(`${payload}.${mac}`), null, 'an already-expired token is not revocable');
  });

  it('(e) revokedSessionCount tracks live entries and resetRevokedSessions clears', () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    assert.equal(revokedSessionCount(), 0);
    const a = createSessionToken({ clientNonce: 'a', serverNonce: 's', role: 'builder', project: 'alpha' });
    const b = createSessionToken({ clientNonce: 'b', serverNonce: 's', role: 'builder', project: 'alpha' });
    revokeSessionToken(a.token);
    revokeSessionToken(b.token);
    assert.equal(revokedSessionCount(), 2);
    resetRevokedSessions();
    assert.equal(revokedSessionCount(), 0);
  });

  it('(f) end-to-end: revoke via POST /api/auth/revoke then the token is rejected', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    const hs = await handshake('client-nonce-revoke');
    assert.equal(hs.response.status, 200);

    // The token works for a mutation first.
    const before = await jsonRequest(baseUrl, '/api/tasks?project=alpha', {
      method: 'POST',
      headers: headers(hs.body.token, 'builder'),
      body: JSON.stringify({ id: 'rev-1', title: 'Rev', status: 'BACKLOG', round: 1 }),
    });
    assert.equal(before.response.status, 201, before.body.error || '');

    // Revoke it.
    const rev = await jsonRequest(baseUrl, '/api/auth/revoke', {
      method: 'POST',
      headers: { Authorization: `Bearer ${hs.body.token}`, 'Content-Type': 'application/json' },
    });
    assert.equal(rev.response.status, 200);
    assert.equal(rev.body.revoked, true);
    assert.ok(rev.body.jti, 'the revoked jti is echoed');

    // The same token is now rejected.
    const after = await jsonRequest(baseUrl, '/api/tasks?project=alpha', {
      method: 'POST',
      headers: headers(hs.body.token, 'builder'),
      body: JSON.stringify({ id: 'rev-2', title: 'Rev', status: 'BACKLOG', round: 1 }),
    });
    assert.equal(after.response.status, 401, 'revoked token cannot mutate');
  });

  it('(g) POST /api/auth/revoke rejects a non-session / absent credential', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    process.env.KANBAN_AUTH_TOKEN = 'static-x';
    const noToken = await jsonRequest(baseUrl, '/api/auth/revoke', { method: 'POST' });
    assert.equal(noToken.response.status, 401);
    const staticToken = await jsonRequest(baseUrl, '/api/auth/revoke', {
      method: 'POST',
      headers: { Authorization: 'Bearer static-x' },
    });
    assert.equal(staticToken.response.status, 401, 'a static token is not a session token');
  });
});
