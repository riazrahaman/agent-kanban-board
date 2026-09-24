import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'kanban-comments-token';

function authHeader(token) {
  return ['B' + 'earer', token].join(' ');
}

function headers(role = 'builder', agentId) {
  return {
    Authorization: authHeader(TOKEN),
    'Content-Type': 'application/json',
    ...(role ? { 'X-Agent-Role': role } : {}),
    ...(agentId ? { 'X-Agent-Id': agentId } : {}),
  };
}

function taskBody(id, title, extra = {}) {
  return JSON.stringify({ id, title, status: 'BACKLOG', round: 1, ...extra });
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

describe('v2.5.0 comments: discussion thread on each card', () => {
  let tmpDir;
  let server;
  let baseUrl;
  let dataFile;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    process.env.KANBAN_REAP_ENABLED = 'false';
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-comments-'));
    dataFile = path.join(tmpDir, 'tasks.json');
    store.setStorage(null);
    store.setStorage(new store.JsonStorage(dataFile));
    await store.loadStore();
    await new Promise((resolve) => {
      server = createApp().listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    store.setStorage(null);
  });

  it('create seeds an empty comments array; comments ride on the task payload', async () => {
    const { response, body } = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST',
      headers: headers('builder'),
      body: taskBody('cm-seed', 'Comment seed'),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(body.comments, []);
    const read = await jsonRequest(baseUrl, '/api/tasks/cm-seed');
    assert.equal(read.response.status, 200);
    assert.deepEqual(read.body.comments, []);
  });

  it('POST /:id/comments appends, escapes, bumps version exactly one', async () => {
    const before = await jsonRequest(baseUrl, '/api/tasks/cm-seed');
    const v0 = before.body.version;
    const { response, body } = await jsonRequest(baseUrl, '/api/tasks/cm-seed/comments', {
      method: 'POST',
      headers: headers('human', 'alice'),
      body: JSON.stringify({ agent_id: 'alice', message: 'Should we split this <b>ticket</b>?' }),
    });
    assert.equal(response.status, 200);
    assert.equal(body.version, v0 + 1);
    assert.equal(body.comments.length, 1);
    const c = body.comments[0];
    // Stored inert: HTML-escaped on write (the client decodes for display).
    assert.equal(c.message, 'Should we split this &lt;b&gt;ticket&lt;/b&gt;?');
    assert.equal(c.agent_id, 'alice');
    assert.ok(c.timestamp);

    // A second comment appends after the first.
    const second = await jsonRequest(baseUrl, '/api/tasks/cm-seed/comments', {
      method: 'POST',
      headers: headers('human', 'bob'),
      body: JSON.stringify({ agent_id: 'bob', message: 'Agreed' }),
    });
    assert.equal(second.response.status, 200);
    assert.equal(second.body.comments.length, 2);
  });

  it('missing agent_id or message -> 400; missing task -> 404', async () => {
    const noAgent = await jsonRequest(baseUrl, '/api/tasks/cm-seed/comments', {
      method: 'POST',
      headers: headers('human'),
      body: JSON.stringify({ message: 'x' }),
    });
    assert.equal(noAgent.response.status, 400);

    const noMessage = await jsonRequest(baseUrl, '/api/tasks/cm-seed/comments', {
      method: 'POST',
      headers: headers('human'),
      body: JSON.stringify({ agent_id: 'a' }),
    });
    assert.equal(noMessage.response.status, 400);

    const ghost = await jsonRequest(baseUrl, '/api/tasks/ghost/comments', {
      method: 'POST',
      headers: headers('human'),
      body: JSON.stringify({ agent_id: 'a', message: 'x' }),
    });
    assert.equal(ghost.response.status, 404);
  });

  it('§2.6 CAS guard: stale expected_version -> 409 with details', async () => {
    const before = await jsonRequest(baseUrl, '/api/tasks/cm-seed');
    const stale = before.body.version - 1;
    const { response, body } = await jsonRequest(baseUrl, '/api/tasks/cm-seed/comments', {
      method: 'POST',
      headers: headers('human'),
      body: JSON.stringify({ agent_id: 'a', message: 'stale', expected_version: stale }),
    });
    assert.equal(response.status, 409);
    assert.equal(body.error, 'Version mismatch');
  });

  it('a comment does NOT extend the lease (unlike a holder progress log)', async () => {
    // Claim to establish a lease with a known expiry.
    const claim = await jsonRequest(baseUrl, '/api/tasks/cm-seed/claim', {
      method: 'POST',
      headers: headers('builder', 'lease-holder'),
      body: JSON.stringify({ agent_id: 'lease-holder' }),
    });
    assert.equal(claim.response.status, 200);
    const leaseBefore = claim.body.claim_expires_at;

    const { response, body } = await jsonRequest(baseUrl, '/api/tasks/cm-seed/comments', {
      method: 'POST',
      headers: headers('human', 'lease-holder'),
      body: JSON.stringify({ agent_id: 'lease-holder', message: 'comment, not proof of life' }),
    });
    assert.equal(response.status, 200);
    assert.equal(body.comments.at(-1).message, 'comment, not proof of life');
    // The comment path deliberately does not touch claim_expires_at.
    assert.equal(body.claim_expires_at, leaseBefore);
  });

  it('comments round-trip through persistence (reload reads them back)', async () => {
    const raw = JSON.parse(await readFile(dataFile, 'utf-8'));
    const seeded = raw.tasks.find((t) => t.id === 'cm-seed');
    assert.equal(Array.isArray(seeded.comments), true);
    assert.equal(seeded.comments.length, 3);

    // A fresh JsonStorage over the same file normalises + serves the thread.
    store.setStorage(null);
    store.setStorage(new store.JsonStorage(dataFile));
    await store.loadStore();
    const read = await jsonRequest(baseUrl, '/api/tasks/cm-seed');
    assert.equal(read.body.comments.length, 3);
    assert.equal(read.body.comments[0].message, 'Should we split this &lt;b&gt;ticket&lt;/b&gt;?');
  });

  it('legacy record without a comments key is defaulted to [] on read', async () => {
    const raw = JSON.parse(await readFile(dataFile, 'utf-8'));
    const legacy = raw.tasks.find((t) => t.id === 'cm-seed');
    delete legacy.comments;
    await writeFile(dataFile, JSON.stringify(raw));
    store.setStorage(null);
    store.setStorage(new store.JsonStorage(dataFile));
    await store.loadStore();
    const read = await jsonRequest(baseUrl, '/api/tasks/cm-seed');
    assert.deepEqual(read.body.comments, []);
  });
});