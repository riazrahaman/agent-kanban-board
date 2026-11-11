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
import { parseProjectTokens } from '../middleware/auth.js';
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

  it('A7: counts an identity-only credential as bound', () => {
    // A credential that binds `agent_id` (with or without a role) no longer lets
    // the caller self-declare who it is, so it must not be reported as unbound.
    const parsed = parseProjectTokens(JSON.stringify({
      alpha: { token: 'tok-identity-only', agent_id: 'agent-7' },
      beta: {
        credentials: [
          { token: 'tok-role', role: 'builder' },
          { token: 'tok-both', role: 'tester', agent_id: 'agent-8' },
          { token: 'tok-unbound' },
        ],
      },
    }));
    const r = checkCredentialCoverage(['alpha', 'beta'], parsed);
    assert.equal(r.status, 'ok');
    assert.equal(r.credentials_total, 4);
    assert.equal(r.credentials_bound, 3, 'role and/or agent_id both count');
    assert.equal(r.credentials_unbound, 1);
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

  it('does not claim every credential is unbound when only identities are bound', () => {
    const log = fakeLog();
    const parsed = parseProjectTokens(JSON.stringify({
      alpha: { token: 'tok-identity-only', agent_id: 'agent-7' },
    }));
    const r = reportCredentialCoverage(['alpha'], parsed, null, log);
    assert.equal(r.status, 'ok');
    assert.equal(r.credentials_bound, 1);
    assert.equal(log.warn.mock.callCount(), 0, 'identity-bound is bound — the all-unbound warning must not fire');
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
  const BOARD_TOKEN = 'test-board-token';

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-cred-health-'));
    store.setStorage(null);
    process.env.KANBAN_AUTH_TOKEN = BOARD_TOKEN;
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
    delete process.env.KANBAN_AUTH_TOKEN;
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
  });

  const auth = { headers: { 'x-api-token': BOARD_TOKEN } };

  it('exposes credential_map reflecting configuration over HTTP', async () => {
    // 1. Unset
    delete process.env.KANBAN_PROJECT_TOKENS;
    let res = await fetch(`${baseUrl}/api/health`, auth);
    let data = await res.json();
    assert.equal(data.credential_map.status, 'unset');
    assert.equal(data.credential_map.covered, 0);

    // 2. Undercovered (missing alpha)
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ beta: 'tok-beta' });
    res = await fetch(`${baseUrl}/api/health`, auth);
    data = await res.json();
    assert.equal(data.credential_map.status, 'undercovered');
    assert.deepEqual(data.credential_map.missing, ['alpha']);
    assert.deepEqual(data.credential_map.extra, ['beta']);

    // 3. OK
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ alpha: 'tok-alpha' });
    res = await fetch(`${baseUrl}/api/health`, auth);
    data = await res.json();
    assert.equal(data.credential_map.status, 'ok');
    assert.equal(data.credential_map.covered, 1);
    assert.deepEqual(data.credential_map.missing, []);

    // 4. Malformed
    process.env.KANBAN_PROJECT_TOKENS = '{malformed json';
    res = await fetch(`${baseUrl}/api/health`, auth);
    data = await res.json();
    assert.equal(data.credential_map.status, 'malformed');
  });

  // --- §2.10 name disclosure ---------------------------------------------
  // /api/health is exempt from read auth so the platform healthcheck can reach
  // it. That exemption is also what an anonymous visitor gets, so the names it
  // used to return were public on any hosted board. Counts stay public; names
  // require a credential.

  it('withholds project NAMES from an anonymous caller but still reports counts', async () => {
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ ghost: 'tok-ghost' });
    const res = await fetch(`${baseUrl}/api/health`);
    const data = await res.json();

    // The signal a probe needs survives.
    assert.equal(data.credential_map.status, 'undercovered');
    assert.equal(data.credential_map.covered, 1);
    assert.equal(data.credential_map.missing_count, 1);
    assert.equal(data.credential_map.extra_count, 1);

    // The names do not.
    assert.equal('missing' in data.credential_map, false);
    assert.equal('extra' in data.credential_map, false);

    const body = JSON.stringify(data);
    assert.equal(body.includes('ghost'), false, 'anonymous response leaked a token-map name');
    assert.equal(body.includes('"alpha"'), false, 'anonymous response leaked a store project');
  });

  it('withholds names from a caller presenting an INVALID token', async () => {
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ ghost: 'tok-ghost' });
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { 'x-api-token': 'definitely-not-the-token' },
    });
    const data = await res.json();
    assert.equal(res.status, 200, 'health must stay reachable — it is the platform probe');
    assert.equal('missing' in data.credential_map, false);
    assert.equal('extra' in data.credential_map, false);
    assert.equal(data.credential_map.extra_count, 1, 'counts still reported for an invalid token');
  });

  it('releases the names to a caller holding a valid token', async () => {
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ ghost: 'tok-ghost' });
    const res = await fetch(`${baseUrl}/api/health`, auth);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(data.credential_map.missing, ['alpha']);
    assert.deepEqual(data.credential_map.extra, ['ghost']);
  });

  it('never discloses a token VALUE, identified or not', async () => {
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ ghost: 'tok-super-secret' });
    for (const opts of [undefined, auth]) {
      const res = await fetch(`${baseUrl}/api/health`, opts);
      const body = await res.text();
      assert.equal(body.includes('tok-super-secret'), false);
    }
  });
});

// B4 (v3.12.2): parseProjectTokens memoizes its parse keyed on the RAW env
// string. These cases pin the contract: an unchanged string returns the SAME
// result object (including the malformed sentinel — error semantics unchanged),
// and a changed string re-parses, so env changes invalidate the cache without
// any explicit reset. The HTTP test above ("exposes credential_map reflecting
// configuration over HTTP") is the end-to-end proof that a changed env string
// takes effect between requests.
describe('parseProjectTokens memoization (v3.12.2 B4)', () => {
  it('returns the SAME result object for an identical raw string', () => {
    const raw = JSON.stringify({ alpha: 't-a', beta: 't-b' });
    const first = parseProjectTokens(raw);
    const second = parseProjectTokens(raw);
    assert.equal(second, first, 'identical raw reuses the cached parse');
    assert.equal(first.map.get('alpha')[0].token, 't-a');
  });

  it('memoizes the malformed sentinel with identical error semantics', () => {
    const bad = '{not valid json';
    const first = parseProjectTokens(bad);
    assert.equal(first.malformed, true);
    assert.equal(parseProjectTokens(bad), first, 'malformed sentinel is cached too');
    assert.equal(parseProjectTokens(bad).map, undefined, 'sentinel keeps its shape');
  });

  it('re-parses when the raw string changes (a new project appears)', () => {
    const first = parseProjectTokens(JSON.stringify({ alpha: 't-a' }));
    assert.equal(first.map.size, 1);

    const second = parseProjectTokens(JSON.stringify({ alpha: 't-a2', beta: 't-b' }));
    assert.equal(second.map.get('alpha')[0].token, 't-a2', 'changed value picked up');
    assert.ok(second.map.has('beta'), 'added project picked up');
    assert.notEqual(second, first);
  });

  it('treats unset and previously-unset raw as the same cached null result', () => {
    assert.equal(parseProjectTokens(undefined), null);
    const again = parseProjectTokens(undefined);
    assert.equal(again, null, 'unset env stays a null result');
  });
});
