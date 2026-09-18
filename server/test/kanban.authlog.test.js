/**
 * §2.x token-rotation observability: redacted auth-failure logging behind
 * KANBAN_AUTH_LOG. Asserts a wrong token emits a warn that never contains the
 * token value, and that the flag defaults to silent.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'super-secret-token-value';

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

describe('token-rotation auth-failure observability', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-authlog-'));
    store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_AUTH_LOG;
  });

  it('with KANBAN_AUTH_LOG enabled, a wrong token warns but never logs the token', async () => {
    process.env.KANBAN_AUTH_LOG = '1';
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const r = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST',
        headers: { Authorization: 'Bearer definitely-wrong', 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'x', title: 'X', status: 'BACKLOG', round: 1 }),
      });
      assert.equal(r.response.status, 401);
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(warnings.some((w) => /\[kanban auth failure\] 401/.test(w)), 'a 401 warn was emitted');
    const output = warnings.join('\n');
    assert.ok(!output.includes(TOKEN), 'must not log the real token');
    assert.ok(!output.includes('definitely-wrong'), 'must not log the wrong token');
    assert.ok(!output.includes('Bearer'), 'must not log the Authorization header');
  });

  it('with KANBAN_AUTH_LOG unset, a wrong token stays silent', async () => {
    delete process.env.KANBAN_AUTH_LOG;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const r = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST',
        headers: { Authorization: 'Bearer definitely-wrong', 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'y', title: 'Y', status: 'BACKLOG', round: 1 }),
      });
      assert.equal(r.response.status, 401);
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(!warnings.some((w) => /\[kanban auth failure\] 401/.test(w)), 'no 401 warn when flag unset');
  });
});
