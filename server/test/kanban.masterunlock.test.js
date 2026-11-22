/**
 * Master password (KANBAN_MASTER_PASSWORD): card details are served only to a
 * caller with a board credential or the master unlock, on EVERY read surface;
 * the unlock is read-only apart from saving column colours.
 */
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, startupAuthErrors } from '../server.js';
import * as store from '../store.js';
import { createStreamTicket, resetProcessTicketKey, resetStreamTickets, verifyStreamTicket } from '../streamTicket.js';
import { resetAuthLimits, authFailuresExceeded } from '../middleware/rateLimit.js';
import {
  MASTER_PASSWORD_MIN_LENGTH,
  SUMMARY_TASK_FIELDS,
  UNLOCK_TTL_MS,
  UNLOCK_SECRET_DIR,
  UNLOCK_SECRET_FILE,
  createUnlockToken,
  masterUnlockKey,
  redactTaskDetails,
  resetUnlockFailures,
  resetUnlockKeyMaterial,
  setUnlockFailureCapacity,
  unlockLockedOut,
  recordUnlockFailure,
  unlockSecretPersisted,
  unlockFailureLimit,
  verifyUnlockToken,
} from '../masterUnlock.js';

const MASTER = 'correct-horse-battery';
const ADMIN = 'admin-token-for-master-tests';
const ALPHA = 'alpha-project-token';
const SECRETS = ['SECRET-DESC', 'SECRET-LOG', 'SECRET-COMMENT', 'SECRET-META'];

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function req(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { response, body, text };
}

const json = (extra = {}) => ({ 'Content-Type': 'application/json', ...extra });
const admin = () => json({ Authorization: `Bearer ${ADMIN}` });
const alpha = () => json({ Authorization: `Bearer ${ALPHA}`, 'X-Agent-Id': 'builder-a' });
const leaks = (text) => SECRETS.filter((s) => text.includes(s));

/** Reads an SSE stream until `count` frames arrived (or it times out). */
async function readFrames(baseUrl, route, { count = 2, headers = {}, timeoutMs = 2000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text = '';
  let status = 0;
  try {
    const res = await fetch(`${baseUrl}${route}`, { signal: controller.signal, headers: { 'Accept-Encoding': 'identity', ...headers } });
    status = res.status;
    if (res.status !== 200) return { status, text: await res.text() };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while ((text.match(/\n\n/g) || []).length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // aborted on timeout: return what arrived
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { status, text };
}

async function unlock(baseUrl, password = MASTER) {
  return req(baseUrl, '/api/auth/unlock', { method: 'POST', headers: json(), body: JSON.stringify({ password }) });
}

describe('master password: startup refusal', () => {
  it('unset, or a distinct long value: no errors', () => {
    assert.deepEqual(startupAuthErrors({}), []);
    assert.deepEqual(startupAuthErrors({ KANBAN_MASTER_PASSWORD: '' }), []);
    assert.deepEqual(startupAuthErrors({
      KANBAN_MASTER_PASSWORD: MASTER, KANBAN_AUTH_TOKEN: 'shared', KANBAN_ADMIN_TOKEN: 'adm',
      KANBAN_PROJECT_TOKENS: JSON.stringify({ alpha: 'tok-a' }),
    }), []);
  });

  it('a whitespace-only master password is refused instead of silently meaning "off"', () => {
    for (const blank of [' ', '   ', '\t', ' \n ']) {
      const errs = startupAuthErrors({ KANBAN_MASTER_PASSWORD: blank });
      assert.equal(errs.length, 1, JSON.stringify(blank));
      assert.match(errs[0], /KANBAN_MASTER_PASSWORD is set but blank/);
    }
  });

  it('a short master password is refused', () => {
    const errs = startupAuthErrors({ KANBAN_MASTER_PASSWORD: 'x'.repeat(MASTER_PASSWORD_MIN_LENGTH - 1) });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /KANBAN_MASTER_PASSWORD must be at least 12 characters/);
  });

  it('equal to the admin token, the shared token, a project credential or the session secret is refused, without echoing the value', () => {
    const value = 'collision-value-123456';
    const cases = [
      [{ KANBAN_ADMIN_TOKEN: value }, /KANBAN_ADMIN_TOKEN/],
      [{ KANBAN_AUTH_TOKEN: value }, /KANBAN_AUTH_TOKEN/],
      [{ KANBAN_PROJECT_TOKENS: JSON.stringify({ alpha: value }) }, /KANBAN_PROJECT_TOKENS/],
      [{ KANBAN_PROJECT_TOKENS: JSON.stringify({ alpha: { credentials: [{ token: 'other-tok' }, { token: value, role: 'builder' }] } }) }, /KANBAN_PROJECT_TOKENS/],
      [{ KANBAN_AUTH_SECRET: value }, /KANBAN_AUTH_SECRET/],
    ];
    for (const [env, pattern] of cases) {
      const errs = startupAuthErrors({ KANBAN_MASTER_PASSWORD: value, ...env });
      assert.equal(errs.length, 1, JSON.stringify(env));
      assert.match(errs[0], /KANBAN_MASTER_PASSWORD must differ/);
      assert.match(errs[0], pattern);
      assert.ok(!errs[0].includes(value), 'the secret value must not appear in the message');
    }
  });
});

describe('master password: redaction shape', () => {
  it('redactTaskDetails keeps only summary fields and drops every long-form one', () => {
    const task = {
      id: 't', project: 'p', title: 'Title', status: 'READY', priority: 'high', assigned_agent: 'a1',
      version: 4, milestone: 'm1', issues: ['#1'], depends_on: ['x'], branch: 'feat/secret-branch',
      description: 'SECRET-DESC', comments: [{ timestamp: '2026-01-01T00:00:00Z', agent_id: 'a', message: 'SECRET-COMMENT' }],
      agent_logs: [
        { timestamp: '2026-01-02T00:00:00Z', agent_id: 'a1', message: 'SECRET-LOG' },
        { timestamp: '2026-01-03T00:00:00Z', agent_id: 'a2', message: 'SECRET-LOG 2' },
      ],
      metadata: { estimate: 5, size: 'L', note: 'SECRET-META', points: { nested: 'SECRET-META' }, estimate_long: 'x' },
      some_future_field: 'SECRET-DESC future',
    };
    const out = redactTaskDetails(task);
    assert.deepEqual(leaks(JSON.stringify(out)), []);
    assert.equal(out.details_locked, true);
    assert.equal(out.description, '');
    assert.deepEqual(out.agent_logs, []);
    assert.deepEqual(out.comments, []);
    assert.deepEqual(out.metadata, { estimate: 5, size: 'L' });
    assert.deepEqual(out.activity, [
      { timestamp: '2026-01-03T00:00:00Z', agent_id: 'a2' },
      { timestamp: '2026-01-02T00:00:00Z', agent_id: 'a1' },
    ]);
    assert.equal(out.branch, undefined, 'branch is not a card-face field');
    assert.equal(out.some_future_field, undefined, 'an unknown field is withheld by default (allow-list)');
    for (const field of ['id', 'project', 'title', 'status', 'priority', 'assigned_agent', 'version', 'milestone', 'issues', 'depends_on']) {
      assert.deepEqual(out[field], task[field], field);
      assert.ok(SUMMARY_TASK_FIELDS.includes(field));
    }
    assert.equal(task.description, 'SECRET-DESC', 'the stored task is not mutated');
  });

  it('a long string in a summary metadata key is not passed through', () => {
    const out = redactTaskDetails({ id: 't', metadata: { estimate: 'SECRET-META '.repeat(10) } });
    assert.deepEqual(out.metadata, {});
  });
});

/** Every way the pre-fix build (or a guesser) could turn a password into a key. */
function guessableKeys(password, publicValues = []) {
  const keys = [Buffer.from(password, 'utf8'), crypto.createHash('sha256').update(password).digest()];
  for (const extra of ['', ...publicValues]) {
    keys.push(crypto.createHmac('sha256', password).update(`kanban-master-unlock-v1\u0000${extra}`).digest());
    keys.push(crypto.createHmac('sha256', password).update(`kanban-unlock-v2\u0000${extra}`).digest());
    keys.push(crypto.createHmac('sha256', password).update(extra).digest());
    keys.push(crypto.scryptSync(password, extra, 32));
  }
  return keys;
}
const macWith = (key, payload) => crypto.createHmac('sha256', key).update(payload).digest('hex');

describe('master password: unlock tokens and signing keys (B1)', () => {
  let dirA;
  let dirB;

  before(async () => {
    dirA = await mkdtemp(path.join(os.tmpdir(), 'kanban-unlockkey-a-'));
    dirB = await mkdtemp(path.join(os.tmpdir(), 'kanban-unlockkey-b-'));
  });

  beforeEach(() => {
    for (const k of ['KANBAN_AUTH_SECRET', 'KANBAN_AUTH_TOKEN', 'KANBAN_GIT_DIR']) delete process.env[k];
    process.env.KANBAN_DATA_DIR = dirA;
    resetUnlockKeyMaterial();
    resetProcessTicketKey();
    resetStreamTickets();
  });

  afterEach(() => {
    delete process.env.KANBAN_MASTER_PASSWORD;
    delete process.env.KANBAN_AUTH_SECRET;
    delete process.env.KANBAN_DATA_DIR;
    resetUnlockKeyMaterial();
    resetProcessTicketKey();
    resetStreamTickets();
  });

  after(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it('no password configured: nothing mints, nothing verifies, no secret file is created', async () => {
    assert.equal(createUnlockToken(), null);
    assert.equal(verifyUnlockToken('abc.def'), null);
    await assert.rejects(stat(path.join(dirA, UNLOCK_SECRET_DIR, UNLOCK_SECRET_FILE)));
  });

  it('a minted token verifies until it expires, and dies when the password changes', () => {
    process.env.KANBAN_MASTER_PASSWORD = MASTER;
    const now = 1_000_000;
    const minted = createUnlockToken(now);
    assert.equal(minted.expiresAt, now + UNLOCK_TTL_MS);
    assert.ok(!minted.token.includes(MASTER));
    assert.equal(verifyUnlockToken(minted.token, now + 1).exp, minted.expiresAt);
    assert.equal(verifyUnlockToken(minted.token, minted.expiresAt), null, 'expired');
    assert.equal(verifyUnlockToken(`${minted.token}0`, now + 1), null, 'tampered MAC');
    process.env.KANBAN_MASTER_PASSWORD = 'a-different-master-pw';
    assert.equal(verifyUnlockToken(minted.token, now + 1), null, 'rotating the password revokes every unlock');
    process.env.KANBAN_MASTER_PASSWORD = MASTER;
    assert.equal(verifyUnlockToken(minted.token, now + 1).exp, minted.expiresAt, 'same password + same server secret: still valid');
  });

  it('a too-short password fails closed: it can never mint', () => {
    process.env.KANBAN_MASTER_PASSWORD = 'short';
    assert.equal(createUnlockToken(), null);
  });

  it('the unlock key cannot be recomputed from the password plus public values (offline-guess oracle)', async () => {
    process.env.KANBAN_MASTER_PASSWORD = MASTER;
    const minted = createUnlockToken();
    const [payload, mac] = minted.token.split('.');
    const publicValues = [payload, Buffer.from(payload, 'base64url').toString('utf8'), JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).jti];
    // The reviewer's exploit: knowing the RIGHT password, try every derivation
    // an attacker could run offline. None reproduces the MAC, so a captured
    // token confirms nothing about a password guess.
    for (const key of guessableKeys(MASTER, publicValues)) {
      assert.notEqual(macWith(key, payload), mac, 'the unlock MAC was reproduced from the password alone');
    }
    // The key really does depend on a server-only random secret: another data
    // directory (another server) with the SAME password rejects the token.
    const keyA = Buffer.from(masterUnlockKey());
    process.env.KANBAN_DATA_DIR = dirB;
    resetUnlockKeyMaterial();
    assert.equal(verifyUnlockToken(minted.token), null, 'a token must not verify under a different server secret');
    assert.ok(!keyA.equals(masterUnlockKey()), 'same password, different server secret: different key');
    // ...and a forged token signed with any guessable key is rejected.
    const forgedPayload = Buffer.from(JSON.stringify({ typ: 'unlock', jti: 'f'.repeat(32), exp: Date.now() + 60000 })).toString('base64url');
    for (const key of guessableKeys(MASTER)) {
      assert.equal(verifyUnlockToken(`${forgedPayload}.${macWith(key, forgedPayload)}`), null);
    }
  });

  it('the server secret is random, stored 0600 under the data dir, and survives a restart', async () => {
    process.env.KANBAN_MASTER_PASSWORD = MASTER;
    const minted = createUnlockToken();
    assert.equal(unlockSecretPersisted(), true);
    const file = path.join(dirA, UNLOCK_SECRET_DIR, UNLOCK_SECRET_FILE);
    const info = await stat(file);
    assert.equal(info.mode & 0o777, 0o600, 'secret file must be owner-only');
    assert.equal((await stat(path.join(dirA, UNLOCK_SECRET_DIR))).mode & 0o777, 0o700, 'secret directory must be owner-only');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.match(stored.secret, /^[0-9a-f]{64}$/);
    assert.match(stored.salt, /^[0-9a-f]{32}$/);
    assert.ok(!JSON.stringify(stored).includes(MASTER), 'the password is never written to disk');
    // A data dir that is a git repository must not pick the secret up via `git add -A`.
    assert.equal(await readFile(path.join(dirA, UNLOCK_SECRET_DIR, '.gitignore'), 'utf8'), '*\n');
    // "Restart": forget everything in memory; the same file gives the same key.
    resetUnlockKeyMaterial();
    assert.ok(verifyUnlockToken(minted.token), 'an unlock survives a restart');
    // A loosened file is tightened again on load.
    await chmod(file, 0o644);
    resetUnlockKeyMaterial();
    assert.ok(verifyUnlockToken(minted.token));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    // A corrupt file is replaced by fresh random material (old unlocks die).
    await writeFile(file, '{"secret":"nope"}');
    resetUnlockKeyMaterial();
    assert.equal(verifyUnlockToken(minted.token), null);
    assert.match(JSON.parse(await readFile(file, 'utf8')).secret, /^[0-9a-f]{64}$/);
  });

  it('an unwritable data dir falls back to a per-process secret, says so once, and still works', async () => {
    process.env.KANBAN_MASTER_PASSWORD = MASTER;
    const blocker = path.join(dirB, 'not-a-directory');
    await writeFile(blocker, 'x');
    process.env.KANBAN_DATA_DIR = blocker; // a FILE: nothing can be created under it
    resetUnlockKeyMaterial();
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    let minted;
    try {
      minted = createUnlockToken();
      createUnlockToken();
    } finally {
      console.warn = original;
    }
    assert.ok(verifyUnlockToken(minted.token));
    assert.equal(unlockSecretPersisted(), false);
    assert.equal(warnings.filter((w) => w.includes('per-process secret')).length, 1);
    assert.ok(!warnings.join('\n').includes(MASTER));
    resetUnlockKeyMaterial(); // a "restart" forgets the per-process secret
    console.warn = () => {};
    try {
      assert.equal(verifyUnlockToken(minted.token), null);
    } finally {
      console.warn = original;
    }
  });

  it('fallback stream tickets are signed with a random per-process key, never a password-derived one', () => {
    process.env.KANBAN_MASTER_PASSWORD = MASTER;
    // No KANBAN_AUTH_SECRET and no KANBAN_AUTH_TOKEN: the configuration the
    // reviewer brute-forced. Any ticket (here a project-token style one and a
    // master one) must not be checkable against a password guess.
    for (const opts of [{ role: 'builder', project: 'alpha', credentialId: 'abc' }, { role: null, project: null, masterUntil: Date.now() + 60000 }]) {
      const { ticket } = createStreamTicket(opts);
      const [payload, mac] = ticket.split('.');
      const publicValues = [payload, Buffer.from(payload, 'base64url').toString('utf8')];
      const candidates = [...guessableKeys(MASTER, publicValues), Buffer.from(masterUnlockKey())];
      for (const key of candidates) {
        assert.notEqual(macWith(key, payload), mac, 'a stream-ticket MAC was reproduced from the password or the unlock key');
      }
      // A ticket forged with a guessable key is rejected even if its jti were live.
      for (const key of candidates) {
        assert.equal(verifyStreamTicket(`${payload}.${macWith(key, payload)}`), null);
      }
      assert.ok(verifyStreamTicket(ticket), 'the genuine ticket still verifies');
    }
    // Per-process: a "restart" changes the key, so an outstanding ticket dies.
    const { ticket } = createStreamTicket({ role: 'builder', project: 'alpha' });
    resetProcessTicketKey();
    assert.equal(verifyStreamTicket(ticket), null);
  });

  it('without a master password the ticket fallback does not exist (unchanged: no signing secret, no tickets)', () => {
    assert.equal(createStreamTicket({ role: 'builder', project: 'alpha' }), null);
  });
});

describe('master password: every read surface', () => {
  let tmpDir;
  let server;
  let baseUrl;
  let unlockToken;

  before(async () => {
    for (const k of ['KANBAN_STORAGE_BACKEND', 'KANBAN_DEFAULT_PROJECT', 'KANBAN_AUTH_TOKEN', 'KANBAN_AUTH_SECRET', 'KANBAN_READ_AUTH', 'KANBAN_AUTH_RATE_LIMIT_PER_MIN']) {
      delete process.env[k];
    }
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-master-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_ADMIN_TOKEN = ADMIN;
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ alpha: { token: ALPHA, role: 'builder' } });
    process.env.KANBAN_MASTER_PASSWORD = MASTER;
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));

    const seed = async (id, project, extra = {}) => {
      const r = await req(baseUrl, '/api/tasks', {
        method: 'POST', headers: admin(),
        body: JSON.stringify({
          id, project, title: `Card ${id}`, description: `SECRET-DESC ${id}`, status: 'READY', round: 1,
          priority: 'high', metadata: { estimate: 3, note: 'SECRET-META' }, ...extra,
        }),
      });
      assert.equal(r.response.status, 201, r.text);
    };
    await seed('a1', 'alpha');
    await seed('a2', 'alpha');
    await seed('b1', 'beta');
    await seed('gone', 'alpha');
    for (const [route, message] of [['logs', 'SECRET-LOG one'], ['comments', 'SECRET-COMMENT one']]) {
      const r = await req(baseUrl, `/api/tasks/a1/${route}?project=alpha`, { method: 'POST', headers: alpha(), body: JSON.stringify({ message }) });
      assert.equal(r.response.status, 200, r.text);
    }
    const del = await req(baseUrl, '/api/tasks/gone?project=alpha', { method: 'DELETE', headers: admin() });
    assert.equal(del.response.status, 200, del.text);
  });

  beforeEach(async () => {
    resetUnlockFailures();
    resetAuthLimits();
    resetStreamTickets();
    const u = await unlock(baseUrl);
    unlockToken = u.body.token;
  });

  after(async () => {
    server.close();
    store.setStorage(null);
    await rm(tmpDir, { recursive: true, force: true });
    for (const k of ['KANBAN_ADMIN_TOKEN', 'KANBAN_PROJECT_TOKENS', 'KANBAN_MASTER_PASSWORD', 'KANBAN_DATA_DIR', 'KANBAN_DATA_FILE', 'KANBAN_READ_AUTH', 'KANBAN_AUTH_RATE_LIMIT_PER_MIN']) {
      delete process.env[k];
    }
    resetUnlockFailures();
    resetAuthLimits();
    resetStreamTickets();
  });

  const master = () => ({ 'X-Kanban-Unlock': unlockToken });

  // Every GET that can return task content, and what an anonymous caller gets.
  const TASK_READS = [
    '/api/tasks',
    '/api/tasks?project=alpha',
    '/api/tasks/a1?project=alpha',
    '/api/tasks/archive',
    '/api/tasks/trash',
    '/api/tasks/trash?project=alpha',
  ];
  // Every other GET surface: none of them may carry task text for anyone.
  const OTHER_READS = [
    '/api/tasks/a1/issues?project=alpha',
    '/api/metrics',
    '/api/metrics?project=alpha',
    '/api/milestones',
    '/api/projects',
    '/api/audit',
    '/api/health',
    '/api/settings',
    '/api/bug-reports/config',
    '/api/ask/config',
  ];

  it('anonymous: no detail content on any read surface, summary fields intact', async () => {
    for (const route of [...TASK_READS, ...OTHER_READS]) {
      const r = await req(baseUrl, route);
      assert.equal(r.response.status, 200, route);
      assert.deepEqual(leaks(r.text), [], `${route} leaked detail content to an anonymous caller`);
    }
    const list = (await req(baseUrl, '/api/tasks')).body;
    assert.equal(list.length, 3);
    const a1 = list.find((t) => t.id === 'a1');
    assert.equal(a1.details_locked, true);
    assert.equal(a1.title, 'Card a1');
    assert.equal(a1.status, 'READY');
    assert.equal(a1.priority, 'high');
    assert.equal(a1.project, 'alpha');
    assert.equal(typeof a1.version, 'number');
    assert.deepEqual(a1.metadata, { estimate: 3 });
    assert.equal(a1.activity.length, 1);
    assert.equal(a1.activity[0].agent_id, 'builder-a');
    assert.deepEqual(Object.keys(a1.activity[0]).sort(), ['agent_id', 'timestamp']);
    const trash = (await req(baseUrl, '/api/tasks/trash')).body;
    assert.equal(trash.length, 1);
    assert.equal(trash[0].details_locked, true);
  });

  it('anonymous: the log history endpoint is refused outright and is not a failed-auth strike', async () => {
    const r = await req(baseUrl, '/api/tasks/a1/logs?project=alpha&include_spilled=1');
    assert.equal(r.response.status, 403);
    assert.equal(r.body.error, 'details_locked');
    assert.deepEqual(leaks(r.text), []);
    process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN = '1';
    await req(baseUrl, '/api/tasks/a1/logs?project=alpha');
    await req(baseUrl, '/api/tasks/a1/logs?project=alpha');
    const ok = await req(baseUrl, '/api/tasks/a1?project=alpha', { method: 'PATCH', headers: alpha(), body: JSON.stringify({ title: 'Card a1' }) });
    assert.notEqual(ok.response.status, 429);
    delete process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN;
  });

  it('an invalid token or an invalid/forged unlock is treated as anonymous', async () => {
    for (const headers of [
      { Authorization: 'Bearer not-a-real-token' },
      { 'X-Kanban-Unlock': 'not.a.token' },
      { 'X-Kanban-Unlock': `${unlockToken}ff` },
      { 'X-Kanban-Unlock': MASTER },
    ]) {
      const r = await req(baseUrl, '/api/tasks', { headers });
      assert.equal(r.response.status, 200);
      assert.deepEqual(leaks(r.text), [], JSON.stringify(Object.keys(headers)));
      assert.ok(r.body.every((t) => t.details_locked === true));
    }
  });

  it('master unlock: full details on every task read, including the log history', async () => {
    const list = await req(baseUrl, '/api/tasks', { headers: master() });
    assert.equal(list.body.length, 3);
    const a1 = list.body.find((t) => t.id === 'a1');
    assert.equal(a1.details_locked, undefined);
    assert.equal(a1.description, 'SECRET-DESC a1');
    assert.equal(a1.agent_logs[0].message, 'SECRET-LOG one');
    assert.equal(a1.comments[0].message, 'SECRET-COMMENT one');
    assert.equal(a1.metadata.note, 'SECRET-META');
    const one = await req(baseUrl, '/api/tasks/a1?project=alpha', { headers: master() });
    assert.equal(one.body.description, 'SECRET-DESC a1');
    const logs = await req(baseUrl, '/api/tasks/a1/logs?project=alpha', { headers: master() });
    assert.equal(logs.response.status, 200);
    assert.equal(logs.body.inline[0].message, 'SECRET-LOG one');
    const trash = await req(baseUrl, '/api/tasks/trash', { headers: master() });
    assert.equal(trash.body[0].description, 'SECRET-DESC gone');
  });

  it('a board token sees full data exactly as before (scoped to its project)', async () => {
    const list = await req(baseUrl, '/api/tasks', { headers: alpha() });
    assert.deepEqual(list.body.map((t) => t.id).sort(), ['a1', 'a2']);
    const a1 = list.body.find((t) => t.id === 'a1');
    assert.equal(a1.details_locked, undefined);
    assert.equal(a1.description, 'SECRET-DESC a1');
    assert.equal(a1.agent_logs.length, 1);
    assert.equal(a1.activity, undefined);
    const logs = await req(baseUrl, '/api/tasks/a1/logs?project=alpha', { headers: alpha() });
    assert.equal(logs.response.status, 200);
    const everything = await req(baseUrl, '/api/tasks', { headers: admin() });
    assert.equal(everything.body.length, 3);
    assert.ok(everything.body.every((t) => t.details_locked === undefined && t.description.startsWith('SECRET-DESC')));
  });

  it('SSE: an anonymous stream is redacted in the prime, in snapshot mode and in diff frames', async () => {
    const prime = await readFrames(baseUrl, '/api/events?prime=1', { count: 2 });
    assert.equal(prime.status, 200);
    assert.match(prime.text, /event: tasks/);
    assert.match(prime.text, /"details_locked":true/);
    assert.deepEqual(leaks(prime.text), []);
    const snapshot = await readFrames(baseUrl, '/api/events?mode=snapshot', { count: 2 });
    assert.match(snapshot.text, /"details_locked":true/);
    assert.deepEqual(leaks(snapshot.text), []);

    // Diff frame: open the stream, then mutate.
    const pending = readFrames(baseUrl, '/api/events', { count: 2, timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 150));
    const w = await req(baseUrl, '/api/tasks/a2/logs?project=alpha', { method: 'POST', headers: alpha(), body: JSON.stringify({ message: 'SECRET-LOG diff' }) });
    assert.equal(w.response.status, 200);
    const diff = await pending;
    assert.match(diff.text, /event: task\.updated/);
    assert.match(diff.text, /"details_locked":true/);
    assert.deepEqual(leaks(diff.text), []);
  });

  it('SSE: a master stream ticket gets full frames, is single-use, and never appears as a board credential', async () => {
    const mint = await req(baseUrl, '/api/auth/stream-ticket', { method: 'POST', headers: json(master()), body: '{}' });
    assert.equal(mint.response.status, 200, mint.text);
    assert.equal(mint.body.role, null);
    assert.equal(mint.body.project, null);
    assert.equal(mint.body.scope, 'details');
    const ticket = encodeURIComponent(mint.body.ticket);
    const pending = readFrames(baseUrl, `/api/events?prime=1&ticket=${ticket}`, { count: 3, timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 150));
    await req(baseUrl, '/api/tasks/a2/logs?project=alpha', { method: 'POST', headers: alpha(), body: JSON.stringify({ message: 'SECRET-LOG diff two' }) });
    const full = await pending;
    assert.match(full.text, /SECRET-DESC a1/);
    assert.match(full.text, /event: task\.updated/);
    assert.match(full.text, /SECRET-LOG diff two/);
    assert.doesNotMatch(full.text, /details_locked/);
    // Replayed ticket: anonymous again.
    const replay = await readFrames(baseUrl, `/api/events?prime=1&ticket=${ticket}`, { count: 2 });
    assert.deepEqual(leaks(replay.text), []);
    // A master ticket is ignored outside /api/events.
    const other = await req(baseUrl, `/api/tasks?ticket=${ticket}`);
    assert.deepEqual(leaks(other.text), []);
  });

  it('SSE: a token-minted ticket still gets full frames', async () => {
    const mint = await req(baseUrl, '/api/auth/stream-ticket', { method: 'POST', headers: alpha(), body: JSON.stringify({ project: 'alpha' }) });
    assert.equal(mint.response.status, 200, mint.text);
    const full = await readFrames(baseUrl, `/api/events?prime=1&project=alpha&ticket=${encodeURIComponent(mint.body.ticket)}`, { count: 2 });
    assert.match(full.text, /SECRET-DESC a1/);
    assert.doesNotMatch(full.text, /details_locked/);
  });

  it('unlock endpoint: right password mints, anything else answers the same quiet body', async () => {
    const good = await unlock(baseUrl);
    assert.equal(good.response.status, 200);
    assert.equal(good.body.unlocked, true);
    assert.equal(typeof good.body.token, 'string');
    assert.ok(good.body.expires_at > Date.now());
    assert.ok(!good.text.includes(MASTER));
    const wrong = await unlock(baseUrl, 'definitely-wrong-guess');
    assert.equal(wrong.response.status, 200);
    assert.deepEqual(wrong.body, { unlocked: false, credential: false }, 'unrecognised: the browser must store nothing');
    const typo = await unlock(baseUrl, `${MASTER.slice(0, -1)}X`);
    assert.deepEqual(typo.body, { unlocked: false, credential: false }, 'a one-character-off password is "unrecognised", never "a token"');
    for (const known of [ALPHA, ADMIN]) {
      const token = await unlock(baseUrl, known);
      assert.deepEqual(token.body, { unlocked: false, credential: true }, 'a valid board credential is recognised as one');
    }
    assert.equal(good.response.headers.get('cache-control'), 'no-store');
    const empty = await req(baseUrl, '/api/auth/unlock', { method: 'POST', headers: json(), body: '{}' });
    assert.equal(empty.response.status, 400);
    // The password is only accepted in the body: a query string does nothing.
    const viaUrl = await req(baseUrl, `/api/auth/unlock?password=${MASTER}`, { method: 'POST', headers: json(), body: '{}' });
    assert.equal(viaUrl.response.status, 400);
  });

  it('unlock endpoint: wrong guesses lock the address out, before any comparison, even for the right password', async () => {
    const limit = unlockFailureLimit();
    assert.equal(limit, 10);
    for (let i = 0; i < limit; i += 1) {
      const r = await unlock(baseUrl, `wrong-guess-${i}`);
      assert.equal(r.response.status, 200, `attempt ${i + 1}`);
    }
    const locked = await unlock(baseUrl, 'wrong-guess-final');
    assert.equal(locked.response.status, 429);
    assert.equal(locked.body.error, 'too_many_attempts');
    assert.ok(locked.body.retry_after_ms > 0 && locked.body.retry_after_ms <= 60000);
    assert.ok(Number(locked.response.headers.get('retry-after')) >= 1);
    const right = await unlock(baseUrl);
    assert.equal(right.response.status, 429, 'the lockout holds whatever is supplied');
    // An already-issued unlock keeps working: the lockout is on the password gate only.
    const read = await req(baseUrl, '/api/tasks', { headers: master() });
    assert.equal(read.body[0].details_locked, undefined);
  });

  it('checking API tokens against the unlock endpoint is never a strike, and never touches the failed-auth limiter', async () => {
    process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN = '3';
    for (let i = 0; i < 12; i += 1) {
      const r = await unlock(baseUrl, i % 2 ? ALPHA : ADMIN);
      assert.equal(r.response.status, 200);
      assert.deepEqual(r.body, { unlocked: false, credential: true });
    }
    assert.equal((await unlock(baseUrl)).body.unlocked, true, 'twelve token checks did not lock the address out');
    // Wrong master guesses do not consume the board's failed-auth budget either.
    await unlock(baseUrl, 'wrong-guess-a');
    await unlock(baseUrl, 'wrong-guess-b');
    await unlock(baseUrl, 'wrong-guess-c');
    assert.equal(authFailuresExceeded({ ip: '127.0.0.1' }), null);
    assert.equal(authFailuresExceeded({ ip: '::ffff:127.0.0.1' }), null);
    const write = await req(baseUrl, '/api/tasks/a1/logs?project=alpha', { method: 'POST', headers: alpha(), body: JSON.stringify({ message: 'still fine' }) });
    assert.equal(write.response.status, 200);
    delete process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN;
  });

  it('the master unlock cannot mutate, claim, delete, purge or administer', async () => {
    const h = json({ ...master(), 'X-Agent-Role': 'admin', 'X-Agent-Id': 'intruder' });
    const attempts = [
      ['POST', '/api/tasks', { id: 'evil', project: 'alpha', title: 'x', status: 'READY', round: 1 }],
      ['PATCH', '/api/tasks/a1?project=alpha', { title: 'changed' }],
      ['POST', '/api/tasks/a1/claim?project=alpha', { lease_ms: 60000 }],
      ['POST', '/api/tasks/next-claim?project=alpha', {}],
      ['POST', '/api/tasks/a1/assign?project=alpha', { agent_id: 'intruder' }],
      ['POST', '/api/tasks/a1/heartbeat?project=alpha', {}],
      ['POST', '/api/tasks/a1/logs?project=alpha', { message: 'x' }],
      ['POST', '/api/tasks/a1/comments?project=alpha', { message: 'x' }],
      ['POST', '/api/tasks/a1/issues?project=alpha', { issue_id: '#9' }],
      ['DELETE', '/api/tasks/a1?project=alpha', undefined],
      ['POST', '/api/tasks/purge?project=alpha', { ids: ['a1'] }],
      ['POST', '/api/tasks/archive/sweep', {}],
      ['POST', '/api/tasks/trash/gone/restore?project=alpha', {}],
      ['DELETE', '/api/tasks/trash/gone?project=alpha', undefined],
      ['POST', '/api/agents/intruder/heartbeat?project=alpha', {}],
      ['PUT', '/api/settings/extra', { column_colors: {} }],
      ['POST', '/api/settings', { column_colors: {} }],
      ['PATCH', '/api/settings', { column_colors: {} }],
    ];
    for (const [method, route, body] of attempts) {
      const r = await req(baseUrl, route, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.ok([401, 404].includes(r.response.status), `${method} ${route} -> ${r.response.status}`);
    }
    const a1 = (await req(baseUrl, '/api/tasks/a1?project=alpha', { headers: admin() })).body;
    assert.equal(a1.title, 'Card a1');
    assert.equal(a1.assigned_agent, null);
    assert.equal((await req(baseUrl, '/api/tasks', { headers: admin() })).body.length, 3);
  });

  it('settings: the master unlock saves the board-wide palette and a project palette; it is validated', async () => {
    const put = (route, body, headers) => req(baseUrl, route, { method: 'PUT', headers: json(headers), body: JSON.stringify(body) });
    const wide = await put('/api/settings', { column_colors: { READY: 'fail' } }, master());
    assert.equal(wide.response.status, 200, wide.text);
    assert.equal(wide.body.project, 'default');
    // Board-wide: an anonymous, unscoped read gets it back (a fresh browser).
    const anon = await req(baseUrl, '/api/settings');
    assert.equal(anon.body.project, null);
    assert.equal(anon.body.column_colors.READY, 'fail');
    // ...and every project inherits it until it sets its own.
    assert.equal((await req(baseUrl, '/api/settings?project=beta')).body.column_colors.READY, 'fail');
    const own = await put('/api/settings?project=beta', { column_colors: { READY: 'test' } }, master());
    assert.equal(own.response.status, 200, own.text);
    assert.equal((await req(baseUrl, '/api/settings?project=beta')).body.column_colors.READY, 'test');
    assert.equal((await req(baseUrl, '/api/settings')).body.column_colors.READY, 'fail');
    // Route casing / trailing slash reach the same handler and the same rule.
    assert.equal((await put('/API/Settings/', { column_colors: { DONE: 'live' } }, master())).response.status, 200);
    // Still validated by the store's colour validation.
    assert.equal((await put('/api/settings', { column_colors: { READY: '#ff0000' } }, master())).response.status, 400);
    assert.equal((await put('/api/settings', { column_colors: { NOPE: 'fail' } }, master())).response.status, 400);
    assert.equal((await put('/api/settings', { column_colors: 'red' }, master())).response.status, 400);
  });

  it('settings: existing token rules are unchanged, and no credential means no save', async () => {
    const put = (route, body, headers) => req(baseUrl, route, { method: 'PUT', headers: json(headers), body: JSON.stringify(body) });
    const colours = { column_colors: { BLOCKED: 'warn' } };
    assert.equal((await put('/api/settings', colours, {})).response.status, 401, 'anonymous');
    assert.equal((await put('/api/settings', colours, { 'X-Kanban-Unlock': 'forged.token' })).response.status, 401, 'forged unlock');
    assert.equal((await put('/api/settings?project=alpha', colours, { Authorization: `Bearer ${ALPHA}` })).response.status, 200, 'project token, own project');
    assert.equal((await put('/api/settings', colours, { Authorization: `Bearer ${ALPHA}` })).response.status, 403, 'project token, board-wide');
    assert.equal((await put('/api/settings?project=beta', colours, { Authorization: `Bearer ${ALPHA}` })).response.status, 403, 'project token, other project');
    assert.equal((await put('/api/settings', colours, { Authorization: `Bearer ${ADMIN}` })).response.status, 200, 'admin token, board-wide');
    // A project-token browser that is also unlocked may save board-wide.
    assert.equal((await put('/api/settings', colours, { Authorization: `Bearer ${ALPHA}`, ...master() })).response.status, 200);
  });

  it('settings: a board-wide save reaches an open unscoped stream live', async () => {
    const pending = readFrames(baseUrl, '/api/events', { count: 2, timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 150));
    const saved = await req(baseUrl, '/api/settings', { method: 'PUT', headers: json(master()), body: JSON.stringify({ column_colors: { PLANNING: 'pass' } }) });
    assert.equal(saved.response.status, 200);
    const frames = await pending;
    const settings = frames.text.split('\n\n').filter((f) => f.startsWith('event: settings'));
    assert.equal(settings.length, 2, 'one on connect, one for the save');
    assert.match(settings[1], /"PLANNING":"pass"/);
  });

  it('KANBAN_READ_AUTH=token: the master unlock is a read credential (details included); anonymous stays out', async () => {
    process.env.KANBAN_READ_AUTH = 'token';
    try {
      assert.equal((await req(baseUrl, '/api/tasks')).response.status, 401);
      const r = await req(baseUrl, '/api/tasks', { headers: master() });
      assert.equal(r.response.status, 200);
      assert.equal(r.body.find((t) => t.id === 'a1').description, 'SECRET-DESC a1');
      const mint = await req(baseUrl, '/api/auth/stream-ticket', { method: 'POST', headers: json(master()), body: '{}' });
      const stream = await readFrames(baseUrl, `/api/events?prime=1&ticket=${encodeURIComponent(mint.body.ticket)}`, { count: 2 });
      assert.equal(stream.status, 200);
      assert.match(stream.text, /SECRET-DESC a1/);
      assert.equal((await readFrames(baseUrl, '/api/events?prime=1', { count: 1 })).status, 401);
    } finally {
      delete process.env.KANBAN_READ_AUTH;
    }
  });

  it('S1: an address pushed into the overflow bucket is locked out too, and the lockout is logged without the value', async () => {
    // Fill the per-address table so the next NEW address has no counter of its own.
    setUnlockFailureCapacity(2);
    try {
      recordUnlockFailure('198.51.100.1');
      recordUnlockFailure('198.51.100.2');
      const limit = unlockFailureLimit();
      for (let i = 0; i < limit; i += 1) recordUnlockFailure(`203.0.113.${i}`); // all land in overflow
      assert.equal(unlockLockedOut('203.0.113.250'), true, 'a fresh overflow address must not start with a clean slate');
      assert.equal(unlockLockedOut('198.51.100.1'), false, 'a tracked address is still judged on its own counter');
    } finally {
      setUnlockFailureCapacity();
      resetUnlockFailures();
    }

    process.env.KANBAN_AUTH_LOG = '1';
    const lines = [];
    const original = { log: console.log, warn: console.warn };
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    const audits = [];
    const off = store.onAudit((e) => audits.push(e));
    try {
      for (let i = 0; i < unlockFailureLimit(); i += 1) await unlock(baseUrl, `logged-guess-${i}-zzz`);
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      off();
      delete process.env.KANBAN_AUTH_LOG;
    }
    const failures = lines.filter((l) => l.includes('unlock attempt not recognised'));
    assert.equal(failures.length, unlockFailureLimit());
    assert.match(failures[0], /address: 127\.0\.0\.1, 1 of 10 in window/);
    assert.equal(lines.filter((l) => l.includes('unlock lockout for address 127.0.0.1')).length, 1);
    const lockouts = audits.filter((e) => e.kind === 'unlock_lockout');
    assert.equal(lockouts.length, 1);
    assert.ok(!JSON.stringify(lockouts).includes('127.0.0.1'), 'the audit entry carries no address');
    assert.ok(!lines.join('\n').includes('logged-guess'), 'the guessed value is never logged');
    assert.ok(!JSON.stringify(audits).includes('logged-guess'));
  });

  it('task reads are private and uncacheable while the feature is on, and vary on the credential headers', async () => {
    for (const route of ['/api/tasks', '/api/tasks/a1?project=alpha', '/api/tasks/archive', '/api/tasks/trash', '/api/tasks/a1/logs?project=alpha', '/api/tasks/a1/issues?project=alpha']) {
      for (const headers of [{}, master(), { Authorization: `Bearer ${ALPHA}` }]) {
        const r = await req(baseUrl, route, { headers });
        assert.equal(r.response.headers.get('cache-control'), 'private, no-store', route);
        const vary = (r.response.headers.get('vary') || '').toLowerCase();
        for (const h of ['authorization', 'x-api-token', 'x-kanban-unlock']) assert.ok(vary.includes(h), `${route} must vary on ${h} (got "${vary}")`);
      }
    }
    // A conditional request can never turn an anonymous read into a cached unlocked body.
    const full = await req(baseUrl, '/api/tasks', { headers: master() });
    const etag = full.response.headers.get('etag');
    const anon = await req(baseUrl, '/api/tasks', { headers: etag ? { 'If-None-Match': etag } : {} });
    assert.equal(anon.response.status, 200);
    assert.deepEqual(leaks(anon.text), []);
  });

  it('GET /api/auth/details tells a browser what the server will serve it', async () => {
    assert.deepEqual((await req(baseUrl, '/api/auth/details')).body, { details: false, unlock: false });
    const viaUnlock = await req(baseUrl, '/api/auth/details', { headers: master() });
    assert.equal(viaUnlock.body.details, true);
    assert.equal(viaUnlock.body.unlock, true);
    assert.ok(viaUnlock.body.expires_at > Date.now());
    assert.deepEqual((await req(baseUrl, '/api/auth/details', { headers: { Authorization: `Bearer ${ALPHA}` } })).body, { details: true, unlock: false });
    assert.deepEqual((await req(baseUrl, '/api/auth/details', { headers: { 'X-Kanban-Unlock': 'stale.token' } })).body, { details: false, unlock: false });
    assert.equal(viaUnlock.response.headers.get('cache-control'), 'private, no-store');
  });

  it('settings: the unlock cannot create a palette for a project that does not exist, through any channel', async () => {
    const put = (route, body, extra = {}) => req(baseUrl, route, { method: 'PUT', headers: json({ ...master(), ...extra }), body: JSON.stringify(body) });
    const colours = { column_colors: { READY: 'warn' } };
    assert.equal((await put('/api/settings?project=beta-new', colours)).response.status, 401, 'query');
    assert.equal((await put('/api/settings?workspace=beta-new', colours)).response.status, 401, 'workspace alias');
    assert.equal((await put('/api/settings', { ...colours, project: 'beta-new' })).response.status, 401, 'body project');
    assert.equal((await put('/api/settings', { ...colours, workspace_id: 'beta-new' })).response.status, 401, 'body workspace_id');
    assert.equal((await put('/api/settings', colours, { 'X-Kanban-Project': 'beta-new' })).response.status, 401, 'header');
    // Nothing was created: the unknown project still resolves to the board-wide palette only.
    const after = await req(baseUrl, '/api/settings?project=beta-new');
    assert.deepEqual(after.body.column_colors, (await req(baseUrl, '/api/settings')).body.column_colors);
    // Existing projects and the board-wide palette still work.
    assert.equal((await put('/api/settings?project=alpha', colours)).response.status, 200);
    assert.equal((await put('/api/settings', colours)).response.status, 200);
  });

  it('the password and the unlock token never reach a log line or an audit entry', async () => {
    const lines = [];
    const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of Object.keys(original)) console[k] = (...args) => { lines.push(args.map(String).join(' ')); };
    const audits = [];
    const off = store.onAudit((entry) => audits.push(JSON.stringify(entry)));
    try {
      await unlock(baseUrl);
      await unlock(baseUrl, 'wrong-guess-logged?');
      await req(baseUrl, '/api/tasks', { headers: master() });
      await req(baseUrl, '/api/settings', { method: 'PUT', headers: json(master()), body: JSON.stringify({ column_colors: { DONE: 'pass' } }) });
      await req(baseUrl, '/api/tasks/a1?project=alpha', { method: 'PATCH', headers: json(master()), body: JSON.stringify({ title: 'x' }) });
    } finally {
      for (const k of Object.keys(original)) console[k] = original[k];
      off();
    }
    const all = [...lines, ...audits].join('\n');
    assert.ok(!all.includes(MASTER), 'master password in a log/audit line');
    assert.ok(!all.includes('wrong-guess-logged'), 'a guessed value in a log/audit line');
    assert.ok(!all.includes(unlockToken), 'unlock token in a log/audit line');
  });
});

describe('master password not configured: nothing changes', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    for (const k of ['KANBAN_STORAGE_BACKEND', 'KANBAN_DEFAULT_PROJECT', 'KANBAN_PROJECT_TOKENS', 'KANBAN_ADMIN_TOKEN', 'KANBAN_MASTER_PASSWORD', 'KANBAN_READ_AUTH']) {
      delete process.env[k];
    }
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-nomaster-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_AUTH_TOKEN = 'shared-token-nomaster';
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
    const h = json({ Authorization: 'Bearer shared-token-nomaster', 'X-Agent-Role': 'builder', 'X-Agent-Id': 'b' });
    const c = await req(baseUrl, '/api/tasks', { method: 'POST', headers: h, body: JSON.stringify({ id: 'n1', title: 'N', description: 'SECRET-DESC n1', status: 'READY', round: 1 }) });
    assert.equal(c.response.status, 201, c.text);
    await req(baseUrl, '/api/tasks/n1/logs', { method: 'POST', headers: h, body: JSON.stringify({ message: 'SECRET-LOG n1' }) });
  });

  after(async () => {
    server.close();
    store.setStorage(null);
    await rm(tmpDir, { recursive: true, force: true });
    for (const k of ['KANBAN_AUTH_TOKEN', 'KANBAN_DATA_DIR', 'KANBAN_DATA_FILE']) delete process.env[k];
    resetUnlockFailures();
  });

  it('anonymous reads carry full details and no lock marker, on REST and SSE', async () => {
    const list = await req(baseUrl, '/api/tasks');
    assert.equal(list.body[0].description, 'SECRET-DESC n1');
    assert.equal(list.body[0].agent_logs[0].message, 'SECRET-LOG n1');
    assert.equal(list.body[0].details_locked, undefined);
    assert.equal(list.body[0].activity, undefined);
    assert.equal((await req(baseUrl, '/api/tasks/n1/logs')).response.status, 200);
    const stream = await readFrames(baseUrl, '/api/events?prime=1', { count: 2 });
    assert.match(stream.text, /SECRET-DESC n1/);
    assert.doesNotMatch(stream.text, /details_locked/);
  });

  it('the unlock endpoint answers the same quiet body and unlocks nothing', async () => {
    const r = await unlock(baseUrl, 'any-value-at-all-123');
    assert.equal(r.response.status, 200);
    assert.deepEqual(r.body, { unlocked: false, credential: false });
    const known = await unlock(baseUrl, 'shared-token-nomaster');
    assert.deepEqual(known.body, { unlocked: false, credential: true });
    const status = await req(baseUrl, '/api/auth/details');
    assert.deepEqual(status.body, { details: true, unlock: false });
    const list = await req(baseUrl, '/api/tasks');
    assert.equal(list.response.headers.get('cache-control'), null, 'feature off: no cache header is added');
    const put = await req(baseUrl, '/api/settings', { method: 'PUT', headers: json({ 'X-Kanban-Unlock': 'whatever.token' }), body: JSON.stringify({ column_colors: {} }) });
    assert.equal(put.response.status, 401);
  });
});
