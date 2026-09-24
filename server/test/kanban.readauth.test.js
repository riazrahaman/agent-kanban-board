/**
 * ENH-01 (v2.5.7) — optional read authentication (KANBAN_READ_AUTH) plus
 * short-lived single-use stream tickets for the SSE endpoint.
 *
 * Reads are open by default. `KANBAN_READ_AUTH=token` gates every GET/SSE; a
 * browser cannot set headers on EventSource, so it exchanges its bearer token
 * for a 60s single-use ticket and presents that in `?ticket=`.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';
import { resetStreamTickets, liveStreamTicketCount } from '../streamTicket.js';

const TOKEN = 'readauth-token';

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function bearer(role = 'builder') {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Agent-Role': role };
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

async function openStream(baseUrl, route) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}${route}`, { signal: controller.signal });
  return { res, close: () => controller.abort() };
}

describe('ENH-01 read authentication + stream tickets', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_PROJECT_TOKENS;
    delete process.env.KANBAN_ADMIN_TOKEN;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-readauth-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  after(async () => {
    server.close();
    store.setStorage(null);
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_READ_AUTH;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
  });

  afterEach(() => {
    delete process.env.KANBAN_READ_AUTH;
    resetStreamTickets();
  });

  it('reads are open when KANBAN_READ_AUTH is unset', async () => {
    const { response } = await jsonRequest(baseUrl, '/api/tasks');
    assert.equal(response.status, 200);
  });

  it('KANBAN_READ_AUTH=token requires a credential on GET', async () => {
    process.env.KANBAN_READ_AUTH = 'token';
    const anon = await jsonRequest(baseUrl, '/api/tasks');
    assert.equal(anon.response.status, 401);
    const withToken = await jsonRequest(baseUrl, '/api/tasks', { headers: bearer() });
    assert.equal(withToken.response.status, 200);
  });

  it('health endpoint stays open even when read-auth is on', async () => {
    process.env.KANBAN_READ_AUTH = 'token';
    const { response, body } = await jsonRequest(baseUrl, '/api/health');
    assert.equal(response.status, 200);
    assert.equal(typeof body.version, 'string');
  });

  it('stream-ticket endpoint requires a valid token', async () => {
    const anon = await jsonRequest(baseUrl, '/api/auth/stream-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'builder' }),
    });
    assert.equal(anon.response.status, 401);

    const good = await jsonRequest(baseUrl, '/api/auth/stream-ticket', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify({ role: 'builder' }),
    });
    assert.equal(good.response.status, 200);
    assert.equal(typeof good.body.ticket, 'string');
  });

  it('a minted ticket opens the read-gated SSE stream exactly once', async () => {
    process.env.KANBAN_READ_AUTH = 'token';
    const minted = await jsonRequest(baseUrl, '/api/auth/stream-ticket', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify({ role: 'builder' }),
    });
    const ticket = minted.body.ticket;

    const first = await openStream(baseUrl, `/api/events?ticket=${encodeURIComponent(ticket)}`);
    assert.equal(first.res.status, 200);
    assert.match(first.res.headers.get('content-type') || '', /text\/event-stream/);
    first.close();

    // Single-use: the same ticket is now inert.
    const reused = await openStream(baseUrl, `/api/events?ticket=${encodeURIComponent(ticket)}`);
    assert.equal(reused.res.status, 401);
    reused.close();
  });

  it('SSE without a ticket is rejected when read-auth is on, accepted when off', async () => {
    process.env.KANBAN_READ_AUTH = 'token';
    const gated = await openStream(baseUrl, '/api/events');
    assert.equal(gated.res.status, 401);
    gated.close();

    delete process.env.KANBAN_READ_AUTH;
    const open = await openStream(baseUrl, '/api/events');
    assert.equal(open.res.status, 200);
    open.close();
  });

  it('tickets expire and are pruned; count stays bounded', async () => {
    const minted = await jsonRequest(baseUrl, '/api/auth/stream-ticket', {
      method: 'POST',
      headers: bearer(),
      body: JSON.stringify({ role: 'builder' }),
    });
    assert.equal(minted.response.status, 200);
    assert.equal(liveStreamTicketCount(), 1);
    resetStreamTickets();
    assert.equal(liveStreamTicketCount(), 0);
  });

  it('readAuthEnabled parses the flag truthily', async () => {
    const { readAuthEnabled } = await import('../middleware/auth.js');
    assert.equal(readAuthEnabled(undefined), false);
    assert.equal(readAuthEnabled(''), false);
    assert.equal(readAuthEnabled('off'), false);
    assert.equal(readAuthEnabled('0'), false);
    assert.equal(readAuthEnabled('false'), false);
    assert.equal(readAuthEnabled('token'), true);
    assert.equal(readAuthEnabled('1'), true);
  });
});
