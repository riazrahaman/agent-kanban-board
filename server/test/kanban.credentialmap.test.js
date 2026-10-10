/**
 * §2.10 credential-map coverage: the boot check that would have caught the
 * 2026-10-08 kanbann outage the same night instead of hours later.
 *
 * The regression this guards is specific: a map that is valid JSON but covers
 * FEWER projects than the store has. `parseProjectTokens` accepts it; the board
 * boots and looks healthy; every uncovered project silently 403s.
 */
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';
import { checkCredentialCoverage, reportCredentialCoverage } from '../utils/credentialMap.js';

const STORE_PROJECTS = ['TG', 'SFG', 'aov', 'chess'];

describe('credential map coverage', () => {
  it('reports ok when every store project has a token', () => {
    const map = { TG: 't1', SFG: 't2', aov: 't3', chess: 't4' };
    const r = checkCredentialCoverage(STORE_PROJECTS, map);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.missing, []);
    assert.equal(r.covered.length, 4);
  });

  it('REGRESSION: a valid but truncated map is reported as undercovered', () => {
    // Exactly the 2026-10-08 shape: valid JSON, one entry, nine projects gone.
    const map = { SData: 'only-one' };
    const r = checkCredentialCoverage(STORE_PROJECTS, map);
    assert.equal(r.status, 'undercovered');
    assert.deepEqual(r.missing, ['SFG', 'TG', 'aov', 'chess']);  // sorted by the guard
    assert.match(r.summary, /4 of 4/);
  });

  it('lists only the uncovered projects, not all of them', () => {
    const map = { TG: 't1', aov: 't3' };
    const r = checkCredentialCoverage(STORE_PROJECTS, map);
    assert.equal(r.status, 'undercovered');
    assert.deepEqual(r.missing, ['SFG', 'chess']);
    assert.deepEqual(r.covered, ['TG', 'aov']);  // sorted alphabetically
  });

  it('flags map entries with no store file as overcovered, not as an error', () => {
    const map = { TG: 't1', SFG: 't2', aov: 't3', chess: 't4', ghost: 't5' };
    const r = checkCredentialCoverage(STORE_PROJECTS, map);
    assert.equal(r.status, 'overcovered');
    assert.deepEqual(r.extra, ['ghost']);
    assert.deepEqual(r.missing, []);
  });

  it('reports unset when no map is configured', () => {
    const r = checkCredentialCoverage(STORE_PROJECTS, null);
    assert.equal(r.status, 'unset');
  });

  it('defers to the auth layer on malformed maps', () => {
    const r = checkCredentialCoverage(STORE_PROJECTS, null, { malformed: true });
    assert.equal(r.status, 'malformed');
  });

  it('is not confused by an empty store', () => {
    const r = checkCredentialCoverage([], { TG: 't1' });
    assert.equal(r.status, 'overcovered');
  });

  it('accepts a Map instance or parseProjectTokens result directly', () => {
    const map = new Map([['TG', 't1'], ['SFG', 't2'], ['aov', 't3'], ['chess', 't4']]);
    const r1 = checkCredentialCoverage(STORE_PROJECTS, map);
    assert.equal(r1.status, 'ok');

    const r2 = checkCredentialCoverage(STORE_PROJECTS, { map });
    assert.equal(r2.status, 'ok');
  });

  it('safely deduplicates store projects and handles non-array inputs', () => {
    const r1 = checkCredentialCoverage(['TG', 'TG', 'SFG', null, ''], { TG: 't1' });
    assert.equal(r1.status, 'undercovered');
    assert.deepEqual(r1.missing, ['SFG']);
    assert.match(r1.summary, /1 of 2/);

    const r2 = checkCredentialCoverage(null, { TG: 't1' });
    assert.equal(r2.status, 'overcovered');
  });
});

describe('credential map boot reporting', () => {
  const fakeLog = () => ({ info: mock.fn(), warn: mock.fn(), error: mock.fn() });

  it('logs one info line when coverage is complete', () => {
    const log = fakeLog();
    reportCredentialCoverage(['TG'], { TG: 't1' }, null, log);
    assert.equal(log.info.mock.callCount(), 1);
    assert.equal(log.error.mock.callCount(), 0);
  });

  it('logs an error naming the uncovered projects when the map is short', () => {
    const log = fakeLog();
    const r = reportCredentialCoverage(STORE_PROJECTS, { SData: 'x' }, null, log);
    assert.equal(r.status, 'undercovered');
    assert.equal(log.error.mock.callCount(), 1);
    const msg = log.error.mock.calls[0].arguments[0];
    for (const p of STORE_PROJECTS) assert.match(msg, new RegExp(p));
  });

  it('never logs a token value', () => {
    const log = fakeLog();
    const secret = 'super-secret-token-value';
    reportCredentialCoverage(STORE_PROJECTS, { SData: secret }, null, log);
    const all = [...log.warn.mock.calls, ...log.error.mock.calls, ...log.info.mock.calls]
      .map((c) => c.arguments.join(' ')).join('\n');
    assert.ok(!all.includes(secret), 'a token value leaked into the boot log');
  });

  it('does not throw on a malformed map — a signal, never a crash', () => {
    const log = fakeLog();
    assert.doesNotThrow(() =>
      reportCredentialCoverage(STORE_PROJECTS, null, { malformed: true }, log));
    assert.equal(log.error.mock.callCount(), 1);
  });

  it('accepts a logger directly as third parameter', () => {
    const log = fakeLog();
    const r = reportCredentialCoverage(STORE_PROJECTS, { TG: 't1' }, log);
    assert.equal(r.status, 'undercovered');
    assert.equal(log.error.mock.callCount(), 1);
  });
});

describe('GET /api/health credential_map integration', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-cred-health-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    await store.createTask({ id: 't-alpha', title: 'Alpha task', status: 'BACKLOG', project: 'alpha', round: 1 });
    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    delete process.env.KANBAN_PROJECT_TOKENS;
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
  });

  it('exposes credential_map reflecting configuration over HTTP', async () => {
    // 1. Unset
    delete process.env.KANBAN_PROJECT_TOKENS;
    let res = await fetch(`${baseUrl}/api/health`);
    let data = await res.json();
    assert.equal(data.credential_map.status, 'unset');
    assert.equal(data.credential_map.covered, 0);

    // 2. Undercovered (missing alpha)
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ beta: 'tok-beta' });
    res = await fetch(`${baseUrl}/api/health`);
    data = await res.json();
    assert.equal(data.credential_map.status, 'undercovered');
    assert.deepEqual(data.credential_map.missing, ['alpha']);
    assert.deepEqual(data.credential_map.extra, ['beta']);

    // 3. OK
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ alpha: 'tok-alpha' });
    res = await fetch(`${baseUrl}/api/health`);
    data = await res.json();
    assert.equal(data.credential_map.status, 'ok');
    assert.equal(data.credential_map.covered, 1);
    assert.deepEqual(data.credential_map.missing, []);

    // 4. Malformed
    process.env.KANBAN_PROJECT_TOKENS = '{malformed json';
    res = await fetch(`${baseUrl}/api/health`);
    data = await res.json();
    assert.equal(data.credential_map.status, 'malformed');
  });
});
