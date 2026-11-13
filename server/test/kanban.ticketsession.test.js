/**
 * Hardening: stream tickets and session tokens are verified as distinct types.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { createSessionToken, verifySessionToken } from '../sessionAuth.js';
import { createStreamTicket, verifyStreamTicket, resetStreamTickets } from '../streamTicket.js';
import * as store from '../store.js';

const SECRET = 'ticket-session-secret';
const TOKEN = 'ticket-global-token';

describe('stream ticket / session token separation', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-ticketsession-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_AUTH_SECRET = SECRET;
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    await store.loadStore();
    server = await new Promise((resolve) => {
      const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => {
    resetStreamTickets();
    delete process.env.KANBAN_PROJECT_TOKENS;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_AUTH_SECRET;
    delete process.env.KANBAN_AUTH_TOKEN;
    store.setStorage(null);
  });

  const mintTicket = async (body = { role: 'builder' }) => {
    const res = await fetch(`${baseUrl}/api/auth/stream-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { res, body: await res.json() };
  };

  it('a minted stream ticket is rejected as a session bearer on a mutation', async () => {
    const { res, body } = await mintTicket();
    assert.equal(res.status, 200);
    const mutate = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${body.ticket}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    assert.ok([401, 403].includes(mutate.status), `got ${mutate.status}`);
  });

  it('verifySessionToken rejects a stream ticket; verifyStreamTicket rejects a session token', () => {
    const t = createStreamTicket({ role: 'builder', project: 'p' });
    assert.equal(verifySessionToken(t.ticket), null);
    const s = createSessionToken({ clientNonce: 'a', serverNonce: 'b', role: 'builder', project: 'p' });
    assert.ok(verifySessionToken(s.token));
    assert.equal(verifyStreamTicket(s.token), null);
    assert.ok(verifyStreamTicket(t.ticket));
  });

  it('a session token presented as ?ticket= is not accepted by the event stream', async () => {
    const s = createSessionToken({ clientNonce: 'a', serverNonce: 'b', role: 'builder', project: 'p' });
    process.env.KANBAN_READ_AUTH = 'token';
    try {
      const res = await fetch(`${baseUrl}/api/events?ticket=${encodeURIComponent(s.token)}`);
      assert.ok([401, 403].includes(res.status), `got ${res.status}`);
      await res.body?.cancel();
    } finally {
      delete process.env.KANBAN_READ_AUTH;
    }
  });

  it('the normal ticket flow and session flow still work', async () => {
    const { body } = await mintTicket();
    assert.deepEqual(
      (({ role, project }) => ({ role, project }))(verifyStreamTicket(body.ticket) ?? {}),
      { role: 'builder', project: body.project }
    );
    const s = createSessionToken({ clientNonce: 'a', serverNonce: 'b', role: 'builder', project: 'p' });
    const ok = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'session ok', project: 'p' }),
    });
    assert.notEqual(ok.status, 401);
  });

  it('a ticket carries the credential-bound agent id', async () => {
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({
      p: { token: 'tok-bound', role: 'builder', agent_id: 'agent-7' },
    });
    const res = await fetch(`${baseUrl}/api/auth/stream-ticket`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-bound', 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'p' }),
    });
    assert.equal(res.status, 200);
    const { ticket } = await res.json();
    assert.equal(verifyStreamTicket(ticket)?.agent_id, 'agent-7');
  });

  it('the legacy global token cannot mint privileged tickets once project tokens are configured', async () => {
    const before = await mintTicket({ role: 'admin' });
    assert.equal(before.res.status, 200, 'single-token mode keeps current behaviour');
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ p: { token: 'tok-x', role: 'builder' } });
    for (const role of ['admin', 'runner', 'system', 'human']) {
      const r = await mintTicket({ role });
      assert.equal(r.res.status, 403, role);
    }
    const worker = await mintTicket({ role: 'builder' });
    assert.equal(worker.res.status, 200);
  });
});
