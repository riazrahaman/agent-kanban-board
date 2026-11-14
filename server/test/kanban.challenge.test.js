/**
 * A5 (v3.12.2) — replayable-proof fix: single-use, short-TTL session
 * handshake challenges. Each test here failed (or describes new behaviour)
 * against the pre-fix code, which accepted a proof over a client-chosen nonce
 * with no freshness or single-use check.
 *
 * Two modes are covered:
 *   - required: KANBAN_SESSION_NONCE_MODE='required' rejects proofs without a
 *     valid, live, unconsumed challenge (POST /api/auth/challenge).
 *   - legacy (explicit opt-out; 'required' is the default since v3.13.1): the
 *     historical challenge-less proof still mints.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { proofInput, challengeProofInput } from '../routes/auth.js';
import { verifySessionToken } from '../sessionAuth.js';
import {
  resetSessionChallenges,
  consumedSessionChallengeCount,
} from '../sessionChallenge.js';
import * as store from '../store.js';

const SECRET = 'test-session-secret';

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

const hmac = (input) => crypto.createHmac('sha256', SECRET).update(input).digest('hex');

describe('session handshake challenge (A5, v3.12.2)', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-challenge-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  afterEach(() => {
    resetSessionChallenges();
    delete process.env.KANBAN_AUTH_SECRET;
    delete process.env.KANBAN_SESSION_NONCE_MODE;
    delete process.env.KANBAN_SESSION_CHALLENGE_TTL_MS;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
  });

  async function fetchChallenge() {
    const r = await jsonRequest(baseUrl, '/api/auth/challenge', { method: 'POST' });
    assert.equal(r.response.status, 200, 'challenge minted');
    assert.ok(r.body.challenge, 'a challenge is returned');
    assert.ok(r.body.expires_at > Date.now(), 'expires in the future');
    return r.body;
  }

  async function session({ clientNonce = 'cn', proof, role = 'builder', project = 'alpha', server_nonce } = {}) {
    return jsonRequest(baseUrl, '/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_nonce: clientNonce,
        proof,
        role,
        project,
        ...(server_nonce !== undefined ? { server_nonce } : {}),
      }),
    });
  }

  // --- required mode -------------------------------------------------------

  it('(1) required mode: a proof without a challenge is rejected with 401', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    process.env.KANBAN_SESSION_NONCE_MODE = 'required';
    const legacyProof = hmac(proofInput('cn-1', 'builder', 'alpha'));
    const r = await session({ clientNonce: 'cn-1', proof: legacyProof });
    assert.equal(r.response.status, 401);
    assert.equal(r.body.nonce_mode, 'required');
  });

  it('(2) required mode: the full two-step flow mints a token verifySessionToken accepts', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    process.env.KANBAN_SESSION_NONCE_MODE = 'required';
    const { challenge } = await fetchChallenge();

    const proof = hmac(challengeProofInput(challenge, 'cn-2', 'builder', 'alpha'));
    const r = await session({ clientNonce: 'cn-2', proof, server_nonce: challenge });
    assert.equal(r.response.status, 200);
    assert.ok(r.body.token, 'a token is returned');
    assert.ok(r.body.server_nonce, 'the token still carries its own server_nonce');
    assert.equal(r.body.role, 'builder');
    assert.equal(r.body.project, 'alpha');
    assert.equal(consumedSessionChallengeCount(), 1, 'the challenge was recorded as consumed');

    const recovered = verifySessionToken(r.body.token);
    assert.ok(recovered, 'the minted token passes verifySessionToken');
    assert.equal(recovered.role, 'builder');
    assert.equal(recovered.project, 'alpha');
  });

  it('(3) required mode: replaying the same proof after consumption is rejected', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    process.env.KANBAN_SESSION_NONCE_MODE = 'required';
    const { challenge } = await fetchChallenge();
    const body = {
      clientNonce: 'cn-3',
      proof: hmac(challengeProofInput(challenge, 'cn-3', 'builder', 'alpha')),
      server_nonce: challenge,
    };
    const first = await session(body);
    assert.equal(first.response.status, 200);

    const replay = await session(body);
    assert.equal(replay.response.status, 401, 'the consumed challenge is single-use');
    assert.equal(consumedSessionChallengeCount(), 1);
  });

  it('(4) required mode: an expired challenge is rejected', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    process.env.KANBAN_SESSION_NONCE_MODE = 'required';
    process.env.KANBAN_SESSION_CHALLENGE_TTL_MS = '1';
    // Inline (not fetchChallenge): the 1ms TTL would race the helper's
    // "expires in the future" assertion by design.
    const minted = await jsonRequest(baseUrl, '/api/auth/challenge', { method: 'POST' });
    assert.equal(minted.response.status, 200);
    const challenge = minted.body.challenge;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const r = await session({
      clientNonce: 'cn-4',
      proof: hmac(challengeProofInput(challenge, 'cn-4', 'builder', 'alpha')),
      server_nonce: challenge,
    });
    assert.equal(r.response.status, 401);
    assert.match(r.body.error, /expired or already used/);
  });

  it('(5) a proof bound to the WRONG challenge fails the MAC check', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    process.env.KANBAN_SESSION_NONCE_MODE = 'required';
    const { challenge } = await fetchChallenge();
    const other = 'f'.repeat(64);
    const r = await session({
      clientNonce: 'cn-5',
      proof: hmac(challengeProofInput(other, 'cn-5', 'builder', 'alpha')),
      server_nonce: challenge,
    });
    assert.equal(r.response.status, 401);
    assert.match(r.body.error, /invalid proof/);
  });

  it('(6) an unknown server_nonce fails even with a syntactically valid proof', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    process.env.KANBAN_SESSION_NONCE_MODE = 'required';
    const neverIssued = 'a'.repeat(64);
    const r = await session({
      clientNonce: 'cn-6',
      proof: hmac(challengeProofInput(neverIssued, 'cn-6', 'builder', 'alpha')),
      server_nonce: neverIssued,
    });
    assert.equal(r.response.status, 401, 'an unknown challenge cannot be consumed');
  });

  // --- legacy mode (explicit opt-out since 'required' became the default) ---

  it('(7) legacy mode: the historical challenge-less proof still works', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    process.env.KANBAN_SESSION_NONCE_MODE = 'legacy';
    const r = await session({ clientNonce: 'cn-7', proof: hmac(proofInput('cn-7', 'builder', 'alpha')) });
    assert.equal(r.response.status, 200);
    assert.ok(verifySessionToken(r.body.token), 'the legacy flow still mints a valid token');
    assert.equal(consumedSessionChallengeCount(), 0, 'legacy flow consumes no challenge');
  });

  it('(8) legacy mode: a caller MAY still opt into the challenge flow, and it is enforced', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    process.env.KANBAN_SESSION_NONCE_MODE = 'legacy';
    const { challenge } = await fetchChallenge();
    const body = {
      clientNonce: 'cn-8',
      proof: hmac(challengeProofInput(challenge, 'cn-8', 'builder', 'alpha')),
      server_nonce: challenge,
    };
    assert.equal((await session(body)).response.status, 200);
    assert.equal((await session(body)).response.status, 401, 'consumed even in legacy mode');
  });

  it('(9) required mode: the legacy format is NOT accepted even with a live challenge presented', async () => {
    process.env.KANBAN_AUTH_SECRET = SECRET;
    process.env.KANBAN_SESSION_NONCE_MODE = 'required';
    const { challenge } = await fetchChallenge();
    // A caller presents a challenge but signs the OLD input: the MAC cannot
    // match the challenge-bound expectation.
    const r = await session({
      clientNonce: 'cn-9',
      proof: hmac(proofInput('cn-9', 'builder', 'alpha')),
      server_nonce: challenge,
    });
    assert.equal(r.response.status, 401);
    assert.match(r.body.error, /invalid proof/);
  });

  it('(10) 503 from /challenge when no secret is configured', async () => {
    delete process.env.KANBAN_AUTH_SECRET;
    const r = await jsonRequest(baseUrl, '/api/auth/challenge', { method: 'POST' });
    assert.equal(r.response.status, 503);
  });
});
