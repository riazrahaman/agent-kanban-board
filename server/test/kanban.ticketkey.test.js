/**
 * 3.18.1 — stream tickets are never signed with the shared KANBAN_AUTH_TOKEN.
 * A project-token holder can mint tickets; if their MAC were keyed with the
 * shared token, each ticket would be an offline oracle for guesses of it.
 * Key: KANBAN_AUTH_SECRET when set, else a random per-process key.
 */
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';
import { createStreamTicket, resetProcessTicketKey, resetStreamTickets, verifyStreamTicket } from '../streamTicket.js';
import { resetAuthLimits } from '../middleware/rateLimit.js';

const TOKEN = 'ticket-key-global-token';
const ALPHA = 'ticket-key-alpha-token';
const SECRET = 'ticket-key-session-secret';
const ENV = [
  'KANBAN_STORAGE_BACKEND', 'KANBAN_DEFAULT_PROJECT', 'KANBAN_AUTH_TOKEN', 'KANBAN_AUTH_SECRET', 'KANBAN_ADMIN_TOKEN',
  'KANBAN_PROJECT_TOKENS', 'KANBAN_READ_AUTH', 'KANBAN_MASTER_PASSWORD', 'KANBAN_DATA_DIR', 'KANBAN_DATA_FILE',
];
const macWith = (key, payload) => crypto.createHmac('sha256', key).update(payload).digest('hex');

describe('stream-ticket signing key (3.18.1)', () => {
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    resetProcessTicketKey();
    resetStreamTickets();
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetProcessTicketKey();
    resetStreamTickets();
  });

  it('a ticket cannot be verified, or re-signed, with KANBAN_AUTH_TOKEN', () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    const { ticket } = createStreamTicket({ role: 'builder', project: 'alpha', credentialId: 'alpha-cred' });
    const [payload, mac] = ticket.split('.');
    assert.notEqual(mac, macWith(TOKEN, payload), 'the ticket MAC is HMAC(KANBAN_AUTH_TOKEN, payload): an offline oracle');
    // Same payload (live jti) re-MACed with the shared token: rejected. Checked
    // first because a MAC failure does not consume the ticket.
    assert.equal(verifyStreamTicket(`${payload}.${macWith(TOKEN, payload)}`), null);
    assert.ok(verifyStreamTicket(ticket), 'the genuine ticket still verifies');
  });

  it('KANBAN_AUTH_SECRET, when set, is the key (unchanged)', () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    process.env.KANBAN_AUTH_SECRET = SECRET;
    const { ticket } = createStreamTicket({ role: 'builder', project: 'alpha' });
    const [payload, mac] = ticket.split('.');
    assert.equal(mac, macWith(SECRET, payload));
    assert.notEqual(mac, macWith(TOKEN, payload));
    assert.ok(verifyStreamTicket(ticket));
  });

  it('without KANBAN_AUTH_SECRET the per-process key is stable for the run and gone after a restart', () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    const a = createStreamTicket({ role: 'builder', project: 'alpha' });
    const b = createStreamTicket({ role: 'builder', project: 'alpha' });
    assert.ok(verifyStreamTicket(a.ticket));
    resetProcessTicketKey(); // a restart
    assert.equal(verifyStreamTicket(b.ticket), null);
  });

  describe('over HTTP: a project token mints a ticket that is not keyed with the shared token', () => {
    let tmpDir;
    let server;
    let baseUrl;
    before(async () => {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-ticketkey-'));
    });
    beforeEach(async () => {
      store.setStorage(null);
      process.env.KANBAN_DATA_DIR = tmpDir;
      process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
      process.env.KANBAN_AUTH_TOKEN = TOKEN;
      process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ alpha: { token: ALPHA, role: 'builder' } });
      process.env.KANBAN_READ_AUTH = 'token';
      resetAuthLimits();
      await store.loadStore();
      await new Promise((resolve) => {
        server = createApp().listen(0, '127.0.0.1', () => {
          baseUrl = `http://127.0.0.1:${server.address().port}`;
          resolve();
        });
      });
    });
    afterEach(async () => {
      await new Promise((r) => server.close(r));
      store.setStorage(null);
    });
    after(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('mints, does not verify under KANBAN_AUTH_TOKEN, and still opens the stream', async () => {
      const res = await fetch(`${baseUrl}/api/auth/stream-ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ALPHA}` },
        body: JSON.stringify({ project: 'alpha' }),
      });
      assert.equal(res.status, 200);
      const { ticket } = await res.json();
      const [payload, mac] = ticket.split('.');
      assert.notEqual(mac, macWith(TOKEN, payload));
      const forged = await fetch(`${baseUrl}/api/events?project=alpha&ticket=${encodeURIComponent(`${payload}.${macWith(TOKEN, payload)}`)}`);
      assert.equal(forged.status, 401);
      await forged.body?.cancel();
      const controller = new AbortController();
      const ok = await fetch(`${baseUrl}/api/events?project=alpha&ticket=${encodeURIComponent(ticket)}`, {
        signal: controller.signal, headers: { 'Accept-Encoding': 'identity' },
      });
      assert.equal(ok.status, 200);
      controller.abort();
      await ok.body?.cancel().catch(() => {});
    });
  });
});
