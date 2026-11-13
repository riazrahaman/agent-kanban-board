/**
 * Admin credential configuration checks.
 * - The server refuses to start when KANBAN_ADMIN_TOKEN equals KANBAN_AUTH_TOKEN
 *   or any credential token in KANBAN_PROJECT_TOKENS (the message names the
 *   variables, never the value).
 * - The admin token in single-token mode emits the admin_write audit entry.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, startServer, startupAuthErrors } from '../server.js';
import { resetAuthLimits } from '../middleware/rateLimit.js';
import * as store from '../store.js';

describe('startupAuthErrors', () => {
  it('no admin token, or a distinct one: no errors', () => {
    assert.deepEqual(startupAuthErrors({}), []);
    assert.deepEqual(startupAuthErrors({ KANBAN_AUTH_TOKEN: 's' }), []);
    assert.deepEqual(startupAuthErrors({ KANBAN_AUTH_TOKEN: 's', KANBAN_ADMIN_TOKEN: 'a' }), []);
    assert.deepEqual(startupAuthErrors({
      KANBAN_ADMIN_TOKEN: 'a',
      KANBAN_PROJECT_TOKENS: JSON.stringify({ p: { credentials: [{ token: 'b', role: 'builder' }] } }),
    }), []);
  });

  it('admin token equal to the shared token is an error that does not reveal the value', () => {
    const errs = startupAuthErrors({ KANBAN_AUTH_TOKEN: 'same-secret-value', KANBAN_ADMIN_TOKEN: 'same-secret-value' });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /KANBAN_ADMIN_TOKEN must differ from KANBAN_AUTH_TOKEN/);
    assert.doesNotMatch(errs[0], /same-secret-value/);
  });

  it('admin token equal to any project credential token is an error (string and object forms)', () => {
    for (const map of [
      { p: 'dup-value' },
      { p: { token: 'dup-value', role: 'builder' } },
      { p: { credentials: [{ token: 'other' }, { token: 'dup-value', role: 'tester' }] }, q: 'x' },
    ]) {
      const errs = startupAuthErrors({ KANBAN_ADMIN_TOKEN: 'dup-value', KANBAN_PROJECT_TOKENS: JSON.stringify(map) });
      assert.equal(errs.length, 1, JSON.stringify(map));
      assert.match(errs[0], /KANBAN_PROJECT_TOKENS/);
      assert.doesNotMatch(errs[0], /dup-value/);
    }
  });

  it('the .env.example placeholders are distinct', async () => {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');
    const val = (k) => text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1];
    assert.ok(val('KANBAN_AUTH_TOKEN') && val('KANBAN_ADMIN_TOKEN'));
    assert.notEqual(val('KANBAN_AUTH_TOKEN'), val('KANBAN_ADMIN_TOKEN'));
    assert.deepEqual(startupAuthErrors({ KANBAN_AUTH_TOKEN: val('KANBAN_AUTH_TOKEN'), KANBAN_ADMIN_TOKEN: val('KANBAN_ADMIN_TOKEN') }), []);
  });

  it('startServer refuses to start (and createApp is unaffected)', async () => {
    const prev = { a: process.env.KANBAN_AUTH_TOKEN, b: process.env.KANBAN_ADMIN_TOKEN };
    process.env.KANBAN_AUTH_TOKEN = 'identical';
    process.env.KANBAN_ADMIN_TOKEN = 'identical';
    const realError = console.error;
    console.error = () => {};
    try {
      await assert.rejects(startServer(0, '127.0.0.1'), /Refusing to start: KANBAN_ADMIN_TOKEN must differ/);
      assert.ok(createApp(), 'building the app (as tests do) does not run the startup check');
    } finally {
      console.error = realError;
      if (prev.a === undefined) delete process.env.KANBAN_AUTH_TOKEN; else process.env.KANBAN_AUTH_TOKEN = prev.a;
      if (prev.b === undefined) delete process.env.KANBAN_ADMIN_TOKEN; else process.env.KANBAN_ADMIN_TOKEN = prev.b;
    }
  });
});

describe('admin token in single-token mode', () => {
  let tmpDir;
  let server;
  let baseUrl;
  const audits = [];
  let unsub;

  before(async () => {
    for (const k of ['KANBAN_STORAGE_BACKEND', 'KANBAN_DEFAULT_PROJECT', 'KANBAN_ARCHIVE_AFTER_DAYS', 'KANBAN_PROJECT_TOKENS']) delete process.env[k];
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-adminstartup-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_AUTH_TOKEN = 'single-shared';
    process.env.KANBAN_ADMIN_TOKEN = 'single-admin';
    resetAuthLimits();
    await store.loadStore();
    unsub = store.onAudit((e) => audits.push(e));
    server = createApp().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    unsub();
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    for (const k of ['KANBAN_AUTH_TOKEN', 'KANBAN_ADMIN_TOKEN', 'KANBAN_DATA_DIR', 'KANBAN_DATA_FILE']) delete process.env[k];
    store.setStorage(null);
  });

  it('emits admin_write for the admin token, and not for the shared token', async () => {
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      const post = (token, id) => fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Agent-Role': 'builder', 'X-Agent-Id': 'op' },
        body: JSON.stringify({ id, title: id, status: 'BACKLOG', round: 1 }),
      });
      audits.length = 0;
      assert.equal((await post('single-shared', 'aw-1')).status, 201);
      assert.equal(audits.filter((e) => e.kind === 'admin_write').length, 0);
      assert.equal((await post('single-admin', 'aw-2')).status, 201);
      const writes = audits.filter((e) => e.kind === 'admin_write');
      assert.equal(writes.length, 1);
      assert.equal(writes[0].reason, 'admin_token');
      assert.equal(writes[0].actor, 'op');
    } finally {
      console.warn = realWarn;
    }
  });
});
