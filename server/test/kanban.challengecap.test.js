/**
 * Hardening: bounded pending session-challenge set with cheap in-order pruning.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import {
  createSessionChallenge,
  consumeSessionChallenge,
  resetSessionChallenges,
  consumedSessionChallengeCount,
  sessionChallengeTtlMs,
} from '../sessionChallenge.js';
import { challengeProofInput } from '../routes/auth.js';
import crypto from 'node:crypto';
import * as store from '../store.js';

describe('session challenge cap', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-challengecap-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_AUTH_SECRET = 'cap-secret';
    await store.loadStore();
    server = await new Promise((resolve) => {
      const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => {
    resetSessionChallenges();
    delete process.env.KANBAN_SESSION_CHALLENGE_TTL_MS;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_AUTH_SECRET;
    store.setStorage(null);
  });

  const SECRET = 'cap-secret';
  const post = (p, body) => fetch(`${baseUrl}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const handshakeBody = (challenge, cn = 'cn') => ({
    server_nonce: challenge, client_nonce: cn, role: 'builder', project: 'alpha',
    proof: crypto.createHmac('sha256', SECRET).update(challengeProofInput(challenge, cn, 'builder', 'alpha')).digest('hex'),
  });

  it('20,000 anonymous challenges do not prevent a new client handshake, and hold no state', async () => {
    const first = await (await post('/api/auth/challenge')).json();
    for (let i = 0; i < 20000; i += 1) assert.ok(createSessionChallenge().challenge);
    assert.equal(consumedSessionChallengeCount(), 0, 'issuance writes no server state');
    const res = await post('/api/auth/session', handshakeBody(first.challenge));
    assert.equal(res.status, 200, 'an early challenge survives the flood');
    const fresh = await (await post('/api/auth/challenge')).json();
    assert.equal((await post('/api/auth/session', handshakeBody(fresh.challenge))).status, 200);
  });

  it('a replayed valid proof is refused', async () => {
    const { challenge } = await (await post('/api/auth/challenge')).json();
    assert.equal((await post('/api/auth/session', handshakeBody(challenge))).status, 200);
    assert.equal((await post('/api/auth/session', handshakeBody(challenge))).status, 401);
    assert.equal(consumedSessionChallengeCount(), 1);
  });

  it('forged, tampered and malformed nonces are refused and never recorded', async () => {
    const { challenge } = createSessionChallenge();
    const raw = Buffer.from(challenge, 'base64url');
    raw[30] ^= 1; // flip a MAC bit
    const forged = raw.toString('base64url');
    assert.equal(consumeSessionChallenge(forged), false);
    assert.equal(consumeSessionChallenge('x'.repeat(64)), false);
    assert.equal(consumeSessionChallenge(''), false);
    assert.equal((await post('/api/auth/session', handshakeBody(forged))).status, 401);
    assert.equal(consumedSessionChallengeCount(), 0);
  });

  it('an expired nonce is refused', async () => {
    process.env.KANBAN_SESSION_CHALLENGE_TTL_MS = '20';
    const { challenge } = createSessionChallenge();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(consumeSessionChallenge(challenge), false);
    assert.ok(sessionChallengeTtlMs() === 20);
  });

  it('the nonce is bound to the server secret', () => {
    const { challenge } = createSessionChallenge();
    process.env.KANBAN_AUTH_SECRET = 'a-different-secret';
    assert.equal(consumeSessionChallenge(challenge), false);
    process.env.KANBAN_AUTH_SECRET = SECRET;
    assert.equal(consumeSessionChallenge(challenge), true);
  });
});
