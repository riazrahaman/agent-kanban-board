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
  resetSessionChallenges,
  liveSessionChallengeCount,
  MAX_LIVE_SESSION_CHALLENGES,
} from '../sessionChallenge.js';
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

  it('refuses new challenges with 503 when full, without evicting pending ones', async () => {
    const first = createSessionChallenge();
    for (let i = 1; i < MAX_LIVE_SESSION_CHALLENGES; i += 1) createSessionChallenge();
    assert.equal(liveSessionChallengeCount(), MAX_LIVE_SESSION_CHALLENGES);
    assert.equal(createSessionChallenge(), null);
    const res = await fetch(`${baseUrl}/api/auth/challenge`, { method: 'POST' });
    assert.equal(res.status, 503);
    assert.equal(liveSessionChallengeCount(), MAX_LIVE_SESSION_CHALLENGES);
    const { consumeSessionChallenge } = await import('../sessionChallenge.js');
    assert.equal(consumeSessionChallenge(first.challenge), true, 'oldest pending challenge survives');
  });

  it('still drops expired entries so capacity frees up', async () => {
    process.env.KANBAN_SESSION_CHALLENGE_TTL_MS = '20';
    for (let i = 0; i < 50; i += 1) createSessionChallenge();
    await new Promise((r) => setTimeout(r, 40));
    process.env.KANBAN_SESSION_CHALLENGE_TTL_MS = '60000';
    const fresh = createSessionChallenge();
    assert.ok(fresh);
    assert.equal(liveSessionChallengeCount(), 1);
  });
});
