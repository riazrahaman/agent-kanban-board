/**
 * Auth defaults hardening.
 *
 * A5 — the challenge-bound session handshake is the default: a challenge-less
 * proof is refused unless KANBAN_SESSION_NONCE_MODE is exactly 'legacy'.
 *
 * A8 — destructive operations (task delete, bulk purge incl. hard, trash
 * restore and hard-delete) require a credential-derived privilege in every
 * auth mode: the admin token or a privileged session. A declared header role
 * no longer suffices in single-token mode; non-destructive role gates there
 * are unchanged.
 */
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, startupAuthWarnings } from '../server.js';
import { proofInput, challengeProofInput } from '../routes/auth.js';
import { resetSessionChallenges } from '../sessionChallenge.js';
import { resetAuthLimits, resetRateLimits } from '../middleware/rateLimit.js';
import * as store from '../store.js';

const SECRET = 'authdefaults-secret';
const TOKEN = 'authdefaults-shared-token';
const ADMIN = 'authdefaults-admin-token';
const hmac = (input) => crypto.createHmac('sha256', SECRET).update(input).digest('hex');

const ENV = [
  'KANBAN_AUTH_SECRET', 'KANBAN_AUTH_TOKEN', 'KANBAN_ADMIN_TOKEN', 'KANBAN_PROJECT_TOKENS',
  'KANBAN_SESSION_NONCE_MODE', 'KANBAN_AUTH_RATE_LIMIT_PER_MIN',
];

let tmpDir;
let server;
let baseUrl;

async function req(route, { method = 'GET', token, role, body } = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(role ? { 'X-Agent-Role': role } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

let seq = 0;
async function seed(token = TOKEN, extra = {}) {
  const id = `ad-${(seq += 1)}`;
  const r = await req('/api/tasks', { method: 'POST', token, role: 'builder', body: { id, title: id, status: 'BACKLOG', round: 1, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return id;
}

async function challengeSession(role = 'builder', project = 'default') {
  const { challenge } = (await req('/api/auth/challenge', { method: 'POST' })).body;
  const cn = crypto.randomBytes(6).toString('hex');
  return req('/api/auth/session', {
    method: 'POST',
    body: { client_nonce: cn, server_nonce: challenge, proof: hmac(challengeProofInput(challenge, cn, role, project)), role, project },
  });
}

before(async () => {
  for (const k of [...ENV, 'KANBAN_STORAGE_BACKEND', 'KANBAN_DEFAULT_PROJECT', 'KANBAN_ARCHIVE_AFTER_DAYS']) delete process.env[k];
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-authdefaults-'));
  store.setStorage(null);
  process.env.KANBAN_DATA_DIR = tmpDir;
  process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
  await store.loadStore();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN = '0';
  resetAuthLimits();
  resetRateLimits();
  resetSessionChallenges();
});

afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(tmpDir, { recursive: true, force: true });
  delete process.env.KANBAN_DATA_DIR;
  delete process.env.KANBAN_DATA_FILE;
  store.setStorage(null);
});

describe('A5: challenge-bound session handshake is the default', () => {
  beforeEach(() => { process.env.KANBAN_AUTH_SECRET = SECRET; });

  const legacyAttempt = (cn) => req('/api/auth/session', {
    method: 'POST',
    body: { client_nonce: cn, proof: hmac(proofInput(cn, 'builder', 'default')), role: 'builder', project: 'default' },
  });

  it('default: a challenge-less proof gets 401 with the existing message', async () => {
    const r = await legacyAttempt('cn-default');
    assert.equal(r.status, 401);
    assert.equal(
      r.body.error,
      "Unauthorized: a fresh POST /api/auth/challenge nonce is required (KANBAN_SESSION_NONCE_MODE='required')",
    );
    assert.equal(r.body.nonce_mode, 'required');
  });

  it('only the exact value "legacy" opts out; typos and other values stay required', async () => {
    for (const v of ['Legacy', 'legacy ', 'off', 'none', '']) {
      process.env.KANBAN_SESSION_NONCE_MODE = v;
      assert.equal((await legacyAttempt(`cn-${v}`)).status, 401, `mode '${v}'`);
    }
  });

  it('explicit legacy: a challenge-less proof is accepted', async () => {
    process.env.KANBAN_SESSION_NONCE_MODE = 'legacy';
    const r = await legacyAttempt('cn-legacy');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.token);
  });

  it('a replayed challenge-bound proof gets 401', async () => {
    const { challenge } = (await req('/api/auth/challenge', { method: 'POST' })).body;
    const body = {
      client_nonce: 'cn-replay', server_nonce: challenge,
      proof: hmac(challengeProofInput(challenge, 'cn-replay', 'builder', 'default')), role: 'builder', project: 'default',
    };
    assert.equal((await req('/api/auth/session', { method: 'POST', body })).status, 200);
    assert.equal((await req('/api/auth/session', { method: 'POST', body })).status, 401);
  });

  it('/api/auth/challenge reports the effective mode', async () => {
    assert.equal((await req('/api/auth/challenge', { method: 'POST' })).body.mode, 'required');
    process.env.KANBAN_SESSION_NONCE_MODE = 'legacy';
    assert.equal((await req('/api/auth/challenge', { method: 'POST' })).body.mode, 'legacy');
  });

  it('startup warning only in explicit legacy mode', () => {
    const legacy = startupAuthWarnings({ KANBAN_SESSION_NONCE_MODE: 'legacy' });
    assert.equal(legacy.filter((l) => l.includes('KANBAN_SESSION_NONCE_MODE=legacy')).length, 1);
    assert.equal(startupAuthWarnings({}).length, 0);
    assert.equal(startupAuthWarnings({ KANBAN_SESSION_NONCE_MODE: 'required' }).length, 0);
  });
});

describe('A8: destructive operations need a credential-derived privilege', () => {
  describe('single-token mode without an admin token', () => {
    beforeEach(() => { process.env.KANBAN_AUTH_TOKEN = TOKEN; });

    it('delete with X-Agent-Role: admin -> 403 naming KANBAN_ADMIN_TOKEN', async () => {
      const id = await seed();
      const r = await req(`/api/tasks/${id}`, { method: 'DELETE', token: TOKEN, role: 'admin' });
      assert.equal(r.status, 403);
      assert.match(r.body.error, /KANBAN_ADMIN_TOKEN/);
      assert.ok(store.getTask(id), 'task survives');
    });

    it('purge (soft and hard) with X-Agent-Role: admin -> 403', async () => {
      const id = await seed();
      for (const hard of [false, true]) {
        const r = await req('/api/tasks/purge', { method: 'POST', token: TOKEN, role: 'admin', body: { ids: [id], hard } });
        assert.equal(r.status, 403, `hard=${hard}`);
        assert.match(r.body.error, /KANBAN_ADMIN_TOKEN/);
      }
      assert.ok(store.getTask(id));
    });

    it('non-destructive role gates still follow the header (assign with X-Agent-Role: admin)', async () => {
      const id = await seed();
      const r = await req(`/api/tasks/${id}/assign`, { method: 'POST', token: TOKEN, role: 'admin', body: { agent_id: 'someone' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    });

    it('startup warning names KANBAN_ADMIN_TOKEN; not when an admin token or project tokens exist', () => {
      const w = startupAuthWarnings({ KANBAN_AUTH_TOKEN: 't' });
      assert.equal(w.length, 1);
      assert.match(w[0], /KANBAN_ADMIN_TOKEN/);
      assert.equal(startupAuthWarnings({ KANBAN_AUTH_TOKEN: 't', KANBAN_ADMIN_TOKEN: 'a' }).length, 0);
      assert.equal(startupAuthWarnings({ KANBAN_AUTH_TOKEN: 't', KANBAN_PROJECT_TOKENS: '{}' }).length, 0);
    });
  });

  describe('single-token mode with KANBAN_ADMIN_TOKEN', () => {
    beforeEach(() => {
      process.env.KANBAN_AUTH_TOKEN = TOKEN;
      process.env.KANBAN_ADMIN_TOKEN = ADMIN;
    });

    it('shared token + X-Agent-Role: admin is still refused; the admin token deletes -> 200', async () => {
      const id = await seed();
      assert.equal((await req(`/api/tasks/${id}`, { method: 'DELETE', token: TOKEN, role: 'admin' })).status, 403);
      const ok = await req(`/api/tasks/${id}`, { method: 'DELETE', token: ADMIN });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(store.getTask(id), null);
    });

    it('trash restore and hard-delete follow the same rule', async () => {
      const a = await seed();
      const b = await seed();
      assert.equal((await req(`/api/tasks/${a}`, { method: 'DELETE', token: ADMIN })).status, 200);
      assert.equal((await req(`/api/tasks/${b}`, { method: 'DELETE', token: ADMIN })).status, 200);

      assert.equal((await req(`/api/tasks/trash/${a}/restore`, { method: 'POST', token: TOKEN, role: 'admin' })).status, 403);
      assert.equal((await req(`/api/tasks/trash/${a}/restore`, { method: 'POST', token: ADMIN })).status, 200);
      assert.ok(store.getTask(a), 'restored');

      assert.equal((await req(`/api/tasks/trash/${b}`, { method: 'DELETE', token: TOKEN, role: 'admin' })).status, 403);
      assert.equal((await req(`/api/tasks/trash/${b}`, { method: 'DELETE', token: ADMIN })).status, 200);
    });

    it('purge with the admin token works, including hard', async () => {
      const a = await seed();
      const b = await seed();
      const soft = await req('/api/tasks/purge', { method: 'POST', token: ADMIN, body: { ids: [a] } });
      assert.equal(soft.status, 200, JSON.stringify(soft.body));
      const hard = await req('/api/tasks/purge', { method: 'POST', token: ADMIN, body: { ids: [b], hard: true } });
      assert.equal(hard.status, 200, JSON.stringify(hard.body));
      assert.equal(store.getTask(a), null);
      assert.equal(store.getTask(b), null);
    });
  });

  describe('sessions', () => {
    beforeEach(() => {
      process.env.KANBAN_AUTH_TOKEN = TOKEN;
      process.env.KANBAN_AUTH_SECRET = SECRET;
    });

    it('a privileged session deletes; a non-privileged session cannot', async () => {
      const id = await seed();
      const worker = await challengeSession('builder');
      assert.equal((await req(`/api/tasks/${id}`, { method: 'DELETE', token: worker.body.token, role: 'admin' })).status, 403);
      const admin = await challengeSession('admin');
      assert.equal(admin.status, 200);
      assert.equal((await req(`/api/tasks/${id}`, { method: 'DELETE', token: admin.body.token })).status, 200);
    });
  });

  describe('hosted-style configuration (role-bound project credentials + admin token)', () => {
    const BUILDER = 'authdefaults-builder-cred';
    beforeEach(() => {
      process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({
        default: { credentials: [{ token: BUILDER, role: 'builder' }] },
      });
      process.env.KANBAN_ADMIN_TOKEN = ADMIN;
    });

    it('the admin token deletes; a project credential asserting admin cannot', async () => {
      const id = await seed(BUILDER);
      assert.equal((await req(`/api/tasks/${id}`, { method: 'DELETE', token: BUILDER, role: 'admin' })).status, 403);
      assert.equal((await req(`/api/tasks/${id}`, { method: 'DELETE', token: ADMIN })).status, 200);
    });
  });
});
