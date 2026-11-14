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
  MAX_CONSUMED_SESSION_CHALLENGES,
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

describe('consumed-nonce pruning is independent of consumption order', () => {
  it('an older expired entry behind a live newer one is pruned', () => {
    process.env.KANBAN_AUTH_SECRET = 'cap-secret';
    process.env.KANBAN_SESSION_CHALLENGE_TTL_MS = '10000';
    resetSessionChallenges();
    const realNow = Date.now;
    const t0 = realNow();
    try {
      Date.now = () => t0;
      const older = createSessionChallenge().challenge;
      Date.now = () => t0 + 5000;
      const newer = createSessionChallenge().challenge;
      // Consume the NEWER challenge first, then the older one.
      Date.now = () => t0 + 6000;
      assert.equal(consumeSessionChallenge(newer), true);
      assert.equal(consumeSessionChallenge(older), true);
      assert.equal(consumedSessionChallengeCount(), 2);
      // older expired (t0+10000), newer live until t0+15000.
      Date.now = () => t0 + 12500;
      assert.equal(consumedSessionChallengeCount(), 1, 'only the unexpired entry is retained');
      assert.equal(consumeSessionChallenge(newer), false, 'live entry still blocks replay');
      Date.now = () => t0 + 20000;
      assert.equal(consumedSessionChallengeCount(), 0);
    } finally {
      Date.now = realNow;
      delete process.env.KANBAN_SESSION_CHALLENGE_TTL_MS;
      resetSessionChallenges();
    }
  });
});

describe('consumed-nonce pruning survives a wall-clock rollback', () => {
  it('rebases after the clock moves backward, so expired entries never fill the replay set', () => {
    process.env.KANBAN_AUTH_SECRET = 'cap-secret';
    process.env.KANBAN_SESSION_CHALLENGE_TTL_MS = '10000';
    resetSessionChallenges();
    const realNow = Date.now;
    const t0 = realNow();
    try {
      // The sweep cursor is pushed far ahead by a forward clock jump...
      Date.now = () => t0 + 86_400_000;
      consumedSessionChallengeCount();
      // ...then the clock rolls back and the replay set is filled.
      Date.now = () => t0;
      for (let i = 0; i < MAX_CONSUMED_SESSION_CHALLENGES; i += 1) {
        assert.equal(consumeSessionChallenge(createSessionChallenge().challenge), true);
      }
      assert.equal(consumedSessionChallengeCount(), MAX_CONSUMED_SESSION_CHALLENGES);
      // Once they have expired, pruning must drop them (cursor sits a day ahead).
      Date.now = () => t0 + 20_000;
      assert.equal(consumedSessionChallengeCount(), 0, 'expired entries pruned despite the stale cursor');
      assert.equal(consumeSessionChallenge(createSessionChallenge().challenge), true, 'fresh consume succeeds');
      // A further rollback across expiry boundaries also prunes.
      Date.now = () => t0 - 3_600_000;
      consumedSessionChallengeCount();
      Date.now = () => t0 + 40_000;
      assert.equal(consumedSessionChallengeCount(), 0);
      assert.equal(consumeSessionChallenge(createSessionChallenge().challenge), true);
    } finally {
      Date.now = realNow;
      delete process.env.KANBAN_SESSION_CHALLENGE_TTL_MS;
      resetSessionChallenges();
    }
  });
});
