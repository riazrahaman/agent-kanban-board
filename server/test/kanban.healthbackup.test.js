/**
 * Hardening: the health probe withholds the absolute backup path from
 * non-admin callers.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

describe('health backup path disclosure', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-healthbackup-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_ADMIN_TOKEN = 'health-admin-token';
    process.env.KANBAN_AUTH_TOKEN = 'health-global-token';
    await store.loadStore();
    server = await new Promise((resolve) => {
      const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    for (const k of ['KANBAN_DATA_DIR', 'KANBAN_DATA_FILE', 'KANBAN_ADMIN_TOKEN', 'KANBAN_AUTH_TOKEN']) {
      delete process.env[k];
    }
    store.setStorage(null);
  });

  it('omits backup_root for anonymous callers but keeps the rest of the block', async () => {
    const body = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.ok(body.backup);
    assert.equal('backup_root' in body.backup, false);
    assert.equal(typeof body.backup.enabled, 'boolean');
  });

  it('includes backup_root for the admin token', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { authorization: 'Bearer health-admin-token' },
    });
    const body = await res.json();
    assert.equal(typeof body.backup.backup_root, 'string');
  });
});
