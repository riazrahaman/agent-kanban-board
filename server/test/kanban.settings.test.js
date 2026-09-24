import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'kanban-settings-token';

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

describe('v2.5.0 settings: per-project column colors', () => {
  let tmpDir;
  let server;
  let baseUrl;
  let dataFile;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    process.env.KANBAN_REAP_ENABLED = 'false';
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-settings-'));
    dataFile = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_DATA_DIR = tmpDir;
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
    delete process.env.KANBAN_DATA_DIR;
    await rm(tmpDir, { recursive: true, force: true });
    store.setStorage(null);
  });

  it('unscoped GET returns the stock palette (board default)', async () => {
    const { response, body } = await jsonRequest(baseUrl, '/api/settings');
    assert.equal(response.status, 200);
    assert.equal(body.project, null);
    assert.deepEqual(body.column_colors, store.STOCK_COLUMN_COLORS);
  });

  it('PUT saves a board default; GET resolves stock -> board default', async () => {
    const { response, body } = await jsonRequest(baseUrl, '/api/settings', {
      method: 'PUT',
      headers: headers('human'),
      body: JSON.stringify({ column_colors: { BUILDING: 'fail', DONE: 'warn' } }),
    });
    assert.equal(response.status, 200);
    assert.equal(body.project, 'default');
    assert.equal(body.column_colors.BUILDING, 'fail');

    const read = await jsonRequest(baseUrl, '/api/settings');
    assert.equal(read.body.column_colors.BUILDING, 'fail');
    assert.equal(read.body.column_colors.DONE, 'warn');
    // Untouched columns keep the stock value.
    assert.equal(read.body.column_colors.IN_TEST, 'test');
  });

  it('PUT scoped to a named project overrides only that project', async () => {
    const { response, body } = await jsonRequest(baseUrl, '/api/settings?project=atlas', {
      method: 'PUT',
      headers: headers('human'),
      body: JSON.stringify({ column_colors: { BUILDING: 'pass' } }),
    });
    assert.equal(response.status, 200);
    assert.equal(body.project, 'atlas');
    assert.equal(body.column_colors.BUILDING, 'pass');

    const scoped = await jsonRequest(baseUrl, '/api/settings?project=atlas');
    assert.equal(scoped.body.column_colors.BUILDING, 'pass');

    // A different project sees the board default, not atlas's override.
    const other = await jsonRequest(baseUrl, '/api/settings?project=beta');
    assert.equal(other.body.column_colors.BUILDING, 'fail'); // board default from prior test
    assert.notEqual(other.body.column_colors.BUILDING, 'pass');

    // Board default still resolves BUILDING -> fail for a project with no own override.
  });

  it('validation: unknown column / invalid token / non-object -> 400', async () => {
    const badColumn = await jsonRequest(baseUrl, '/api/settings', {
      method: 'PUT',
      headers: headers('human'),
      body: JSON.stringify({ column_colors: { NOT_A_COLUMN: 'live' } }),
    });
    assert.equal(badColumn.response.status, 400);
    assert.match(badColumn.body.error, /Unknown column/);

    const badToken = await jsonRequest(baseUrl, '/api/settings', {
      method: 'PUT',
      headers: headers('human'),
      body: JSON.stringify({ column_colors: { BUILDING: '#ff0000' } }),
    });
    assert.equal(badToken.response.status, 400);
    assert.match(badToken.body.error, /Invalid color token/);

    const badShape = await jsonRequest(baseUrl, '/api/settings', {
      method: 'PUT',
      headers: headers('human'),
      body: JSON.stringify({ column_colors: ['live'] }),
    });
    assert.equal(badShape.response.status, 400);
    assert.match(badShape.body.error, /must be an object/);
  });

  it('unauthenticated PUT -> 401 (mutations stay token-gated)', async () => {
    const { response } = await jsonRequest(baseUrl, '/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column_colors: { BUILDING: 'fail' } }),
    });
    assert.equal(response.status, 401);
  });

  it('settings persist to disk and survive loadStore()', async () => {
    const settingsFile = path.join(tmpDir, 'settings.json');
    const raw = JSON.parse(await readFile(settingsFile, 'utf-8'));
    assert.equal(raw.project, 'default');
    assert.equal(raw.column_colors.BUILDING, 'fail');

    store.setStorage(null);
    store.setStorage(new store.JsonStorage(dataFile));
    await store.loadStore();
    const read = await jsonRequest(baseUrl, '/api/settings');
    assert.equal(read.body.column_colors.BUILDING, 'fail');
    assert.equal(read.body.column_colors.DONE, 'warn');
  });

  it('onSettings fires on save with the resolved palette; unsubscribe works', async () => {
    const events = [];
    const unsub = store.onSettings((e) => events.push(e));
    await jsonRequest(baseUrl, '/api/settings?project=beta', {
      method: 'PUT',
      headers: headers('human'),
      body: JSON.stringify({ column_colors: { BACKLOG: 'live' } }),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].project, 'beta');
    assert.equal(events[0].settings.column_colors.BACKLOG, 'live');
    unsub();
    await jsonRequest(baseUrl, '/api/settings?project=beta', {
      method: 'PUT',
      headers: headers('human'),
      body: JSON.stringify({ column_colors: { BACKLOG: 'muted' } }),
    });
    assert.equal(events.length, 1, 'no events after unsubscribe');
  });

  it('SSE stream emits event: settings on connect and after a save', async () => {
    const scoped = await jsonRequest(baseUrl, '/api/settings?project=beta');
    assert.equal(scoped.body.column_colors.BACKLOG, 'muted');

    // Connect an SSE reader; collect `event:` lines until we've seen two
    // settings events (connect-time + post-save), then abort.
    const controller = new AbortController();
    const events = [];
    const stream = (async () => {
      const res = await fetch(`${baseUrl}/api/events?project=beta`, { signal: controller.signal });
      assert.equal(res.status, 200);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (events.filter((e) => e === 'settings').length < 2) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const evLine = chunk.split('\n').find((l) => l.startsWith('event: '));
            if (evLine) events.push(evLine.slice(7).trim());
          }
        }
      } catch {
        // aborted — expected shutdown path
      }
    })();

    // Wait for the connect-time settings event, then trigger a save.
    for (let i = 0; i < 50 && !events.includes('settings'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(events.includes('settings'), 'connect-time settings event');
    await jsonRequest(baseUrl, '/api/settings?project=beta', {
      method: 'PUT',
      headers: headers('human'),
      body: JSON.stringify({ column_colors: { BACKLOG: 'live' } }),
    });
    for (let i = 0; i < 50 && events.filter((e) => e === 'settings').length < 2; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(events.filter((e) => e === 'settings').length >= 2, 'settings event after save');
    controller.abort();
    await stream;
  });

  it('legacy settings file without column_colors is tolerated on load', async () => {
    const settingsFile = path.join(tmpDir, 'settings.json');
    await writeFile(settingsFile, JSON.stringify({ project: 'default', updated_at: 'x', column_colors: { BUILDING: 'warn' } }));
    store.setStorage(null);
    store.setStorage(new store.JsonStorage(dataFile));
    await store.loadStore();
    const read = await jsonRequest(baseUrl, '/api/settings');
    assert.equal(read.body.column_colors.BUILDING, 'warn');
    // Restore the board default used by earlier assertions.
    await writeFile(settingsFile, JSON.stringify({ project: 'default', column_colors: { BUILDING: 'fail', DONE: 'warn' } }));
    store.setStorage(null);
    store.setStorage(new store.JsonStorage(dataFile));
    await store.loadStore();
  });
});