/**
 * §2.3 — per-project auth isolation and rate limiting.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { parseProjectTokens } from '../middleware/auth.js';
import { resetRateLimits, trackedProjectCount } from '../middleware/rateLimit.js';
import * as store from '../store.js';

const ALPHA_TOKEN = 'tok-alpha';
const BETA_TOKEN = 'tok-beta';
const ADMIN_TOKEN = 'tok-admin';

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
     });
   });
}

function headers(token, role = 'builder') {
  return {
    Authorization: `Bearer ${token}`,
     'Content-Type': 'application/json',
     ...(role ? { 'X-Agent-Role': role } : {}),
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

describe('§2.3 per-project auth + rate limiting', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-pauth-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
   });

  afterEach(() => {
    delete process.env.KANBAN_PROJECT_TOKENS;
    delete process.env.KANBAN_ADMIN_TOKEN;
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_RATE_LIMIT_PER_MIN;
    delete process.env.KANBAN_RATE_LIMIT_WINDOW_MS;
    resetRateLimits();
   });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
   });

  const enableProjectTokens = () => {
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({
      alpha: ALPHA_TOKEN, beta: BETA_TOKEN,
      });
    };

  it('1. a project token authorizes its own project', async () => {
    enableProjectTokens();
    const r = await jsonRequest(baseUrl, '/api/tasks?project=alpha', {
      method: 'POST', headers: headers(ALPHA_TOKEN),
      body: JSON.stringify({ id: 'ok-1', title: 'Fine', status: 'BACKLOG', round: 1 }),
      });
    assert.equal(r.response.status, 201);
    assert.equal(r.body.project, 'alpha');
    });

  it('2. a project token is refused for another project', async () => {
    enableProjectTokens();
    const r = await jsonRequest(baseUrl, '/api/tasks?project=beta', {
      method: 'POST', headers: headers(ALPHA_TOKEN),
      body: JSON.stringify({ id: 'x-1', title: 'Nope', status: 'BACKLOG', round: 1 }),
      });
    assert.equal(r.response.status, 403);
    assert.match(r.body.error, /not authorized for project 'beta'/);
    assert.equal(store.getTask('x-1', 'beta'), null, 'nothing was written');
    });

  it("3. a body `project` cannot smuggle a write past a query-scoped token", async () => {
    // store.createTask resolves `data.project ?? data.workspace_id ?? queryArg`,
    // so the BODY outranks the query. A check against ?project= alone would
    // authorize alpha here and then create the task in beta.
    enableProjectTokens();
    const r = await jsonRequest(baseUrl, '/api/tasks?project=alpha', {
      method: 'POST', headers: headers(ALPHA_TOKEN),
      body: JSON.stringify({
        id: 'smuggle-1', title: 'Smuggled', status: 'BACKLOG', round: 1, project: 'beta',
        }),
      });
    assert.equal(r.response.status, 403, 'the referenced beta scope is authorized too');
    assert.match(r.body.error, /project 'beta'/);
    assert.equal(store.getTask('smuggle-1', 'beta'), null, 'nothing landed in beta');
    assert.equal(store.getTask('smuggle-1', 'alpha'), null, 'and nothing landed in alpha');
    });

  it('4. the workspace_id alias is covered by the same check', async () => {
    enableProjectTokens();
    const r = await jsonRequest(baseUrl, '/api/tasks?project=alpha', {
      method: 'POST', headers: headers(ALPHA_TOKEN),
      body: JSON.stringify({
        id: 'alias-1', title: 'Alias', status: 'BACKLOG', round: 1, workspace_id: 'beta',
        }),
      });
    assert.equal(r.response.status, 403);
    assert.equal(store.getTask('alias-1', 'beta'), null);
    });

  it('4b. the ?workspace= query alias is covered too', async () => {
    // The fifth naming channel. Same resolution as ?project=, but it is the one
    // input without its own test in a feature that was bypassable once already.
    enableProjectTokens();
    const r = await jsonRequest(baseUrl, '/api/tasks?workspace=beta', {
      method: 'POST', headers: headers(ALPHA_TOKEN),
      body: JSON.stringify({ id: 'ws-1', title: 'Workspace', status: 'BACKLOG', round: 1 }),
      });
    assert.equal(r.response.status, 403);
    assert.match(r.body.error, /project 'beta'/);
    assert.equal(store.getTask('ws-1', 'beta'), null, 'nothing landed in beta');
    });

  it('5. the X-Kanban-Project header is covered too', async () => {
    enableProjectTokens();
    const r = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST',
      headers: { ...headers(ALPHA_TOKEN), 'X-Kanban-Project': 'beta' },
      body: JSON.stringify({ id: 'hdr-1', title: 'Header', status: 'BACKLOG', round: 1 }),
      });
    assert.equal(r.response.status, 403);
    });

  it('6. a token for an unconfigured project is refused', async () => {
    enableProjectTokens();
    const r = await jsonRequest(baseUrl, '/api/tasks?project=gamma', {
      method: 'POST', headers: headers(ALPHA_TOKEN),
      body: JSON.stringify({ id: 'g-1', title: 'Gamma', status: 'BACKLOG', round: 1 }),
      });
    assert.equal(r.response.status, 403, 'an unknown project has no valid token, so nothing opens it');
    });

  it('7. an admin token spans every project when configured', async () => {
    enableProjectTokens();
    process.env.KANBAN_ADMIN_TOKEN = ADMIN_TOKEN;
    for (const project of ['alpha', 'beta']) {
      const r = await jsonRequest(baseUrl, `/api/tasks?project=${project}`, {
        method: 'POST', headers: headers(ADMIN_TOKEN),
        body: JSON.stringify({ id: `adm-${project}`, title: 'Admin', status: 'BACKLOG', round: 1 }),
        });
      assert.equal(r.response.status, 201, `admin may write ${project}`);
      }
    });

  it('7b. an admin write is auditable with an admin marker', async () => {
    enableProjectTokens();
    process.env.KANBAN_ADMIN_TOKEN = ADMIN_TOKEN;
    const seen = [];
    const off = store.onAudit((entry) => seen.push(entry));
    try {
      const r = await jsonRequest(baseUrl, '/api/tasks?project=alpha', {
        method: 'POST', headers: headers(ADMIN_TOKEN),
        body: JSON.stringify({ id: 'adm-audit', title: 'Admin', status: 'BACKLOG', round: 1 }),
        });
      assert.equal(r.response.status, 201);
      const adminEntry = seen.find((e) => e.kind === 'admin_write');
      assert.ok(adminEntry, 'an admin_write audit entry was emitted');
      assert.equal(adminEntry.reason, 'admin_token', 'the entry is marked as admin_token');
      assert.equal(adminEntry.project, 'alpha');
      } finally {
      off();
      }
    });

  it('7c. an ordinary per-project write is NOT marked admin', async () => {
    enableProjectTokens();
    const seen = [];
    const off = store.onAudit((entry) => seen.push(entry));
    try {
      const r = await jsonRequest(baseUrl, '/api/tasks?project=alpha', {
        method: 'POST', headers: headers(ALPHA_TOKEN),
        body: JSON.stringify({ id: 'adm-ordinary', title: 'Ordinary', status: 'BACKLOG', round: 1 }),
        });
      assert.equal(r.response.status, 201);
      assert.ok(
        !seen.some((e) => e.kind === 'admin_write'),
        'a per-project token must not emit an admin marker',
        );
      } finally {
      off();
      }
    });

  it('8. reads are never gated by the project token', async () => {
    enableProjectTokens();
    const r = await jsonRequest(baseUrl, '/api/tasks?project=beta');
    assert.equal(r.response.status, 200, 'GET stays open, as before §2.3');
    });

  it('9. with no per-project config the legacy global token still works', async () => {
    process.env.KANBAN_AUTH_TOKEN = 'legacy-token';
    const ok = await jsonRequest(baseUrl, '/api/tasks?project=anyproject', {
      method: 'POST', headers: headers('legacy-token'),
      body: JSON.stringify({ id: 'legacy-1', title: 'Legacy', status: 'BACKLOG', round: 1 }),
      });
    assert.equal(ok.response.status, 201, 'one token still opens every project');

    const bad = await jsonRequest(baseUrl, '/api/tasks?project=anyproject', {
      method: 'POST', headers: headers('wrong-token'),
      body: JSON.stringify({ id: 'legacy-2', title: 'Legacy', status: 'BACKLOG', round: 1 }),
      });
    assert.equal(bad.response.status, 401, 'and a wrong token is still a 401');
    });

  it('10. malformed KANBAN_PROJECT_TOKENS fails closed, never back to a global token', async () => {
    process.env.KANBAN_AUTH_TOKEN = 'legacy-token';
    process.env.KANBAN_PROJECT_TOKENS = '{not valid json';
    const r = await jsonRequest(baseUrl, '/api/tasks?project=alpha', {
      method: 'POST', headers: headers('legacy-token'),
      body: JSON.stringify({ id: 'mal-1', title: 'Malformed', status: 'BACKLOG', round: 1 }),
      });
    assert.equal(r.response.status, 503, 'a broken isolation config disables writes');
    assert.equal(store.getTask('mal-1', 'alpha'), null);
    });

  it('11. parseProjectTokens rejects unusable shapes', () => {
    assert.equal(parseProjectTokens(undefined), null, 'unset selects the legacy path');
    assert.equal(parseProjectTokens('   '), null);
    assert.ok(parseProjectTokens('[]').malformed, 'an array is not a project map');
    assert.ok(parseProjectTokens('{}').malformed, 'an empty map would authorize nothing');
    assert.ok(parseProjectTokens('{"alpha":""}').malformed, 'an empty token is not a secret');
    assert.ok(parseProjectTokens('{"alpha":1}').malformed, 'a non-string token');
    assert.ok(parseProjectTokens('{"bad project":"t"}').malformed, 'an invalid project id');
    assert.equal(parseProjectTokens('{"alpha":"t"}').map.get('alpha'), 't');
    });

  it('12. rate limiting is per project, and one project cannot starve another', async () => {
    process.env.KANBAN_AUTH_TOKEN = 'rl-token';
    process.env.KANBAN_RATE_LIMIT_PER_MIN = '3';
    resetRateLimits();

    const post = (project, id) => jsonRequest(baseUrl, `/api/tasks?project=${project}`, {
      method: 'POST', headers: headers('rl-token'),
      body: JSON.stringify({ id, title: id, status: 'BACKLOG', round: 1 }),
      });

    for (let i = 0; i < 3; i += 1) {
      const r = await post('rlx', `rlx-${i}`);
      assert.equal(r.response.status, 201, `request ${i} is within budget`);
      }
    const blocked = await post('rlx', 'rlx-over');
    assert.equal(blocked.response.status, 429, 'the fourth exceeds the window');
    assert.match(blocked.body.error, /Rate limit exceeded for project 'rlx'/);
    assert.ok(blocked.response.headers.get('retry-after'), 'carries Retry-After');
    assert.equal(blocked.response.headers.get('x-ratelimit-limit'), '3', '429 carries the budget');
    assert.equal(blocked.response.headers.get('x-ratelimit-remaining'), '0', '429 carries remaining after charge');

    // A different project has its own budget.
    const other = await post('rly', 'rly-0');
    assert.equal(other.response.status, 201, 'one project flooding does not starve another');
    });

  it('13. rate limiting never applies to reads, and is off by default', async () => {
    process.env.KANBAN_AUTH_TOKEN = 'rl-token';
    process.env.KANBAN_RATE_LIMIT_PER_MIN = '1';
    resetRateLimits();
    for (let i = 0; i < 5; i += 1) {
      const r = await jsonRequest(baseUrl, '/api/tasks?project=rlread');
      assert.equal(r.response.status, 200, 'GETs are never limited');
      }

    delete process.env.KANBAN_RATE_LIMIT_PER_MIN;
    resetRateLimits();
    for (let i = 0; i < 5; i += 1) {
      const r = await jsonRequest(baseUrl, '/api/tasks?project=rloff', {
        method: 'POST', headers: headers('rl-token'),
        body: JSON.stringify({ id: `off-${i}`, title: 'Off', status: 'BACKLOG', round: 1 }),
        });
      assert.equal(r.response.status, 201, 'unset means disabled, so existing deploys are unaffected');
      }
    });
  it('14. a composite `project:id` in the URL path cannot smuggle a write', async () => {
    // store.resolveProjectScope lets a `project:` prefix OVERRIDE ?project=, so
    // PATCH /api/tasks/beta:victim?project=alpha resolves to beta. Authorizing
    // only the query let an alpha token rewrite a beta task on every
    // task-scoped route — claim, heartbeat, patch, logs and issues alike.
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({
      alpha: ALPHA_TOKEN, beta: BETA_TOKEN,
      });
    const created = await jsonRequest(baseUrl, '/api/tasks?project=beta', {
      method: 'POST', headers: headers(BETA_TOKEN),
      body: JSON.stringify({ id: 'victim', title: 'Original', status: 'BACKLOG', round: 1 }),
      });
    assert.equal(created.response.status, 201);

    for (const variant of ['beta:victim', 'beta%3Avictim']) {
      const r = await jsonRequest(baseUrl, `/api/tasks/${variant}?project=alpha`, {
        method: 'PATCH', headers: headers(ALPHA_TOKEN),
        body: JSON.stringify({ title: 'PWNED' }),
        });
      assert.equal(r.response.status, 403, `composite id rejected: ${variant}`);
      }
    // The encoded form matters on its own: req.path is still percent-encoded,
    // so a check that looks for ':' before decoding misses %3A entirely.
    assert.equal(
      store.getTask('victim', 'beta').title, 'Original',
      'the beta task was never modified by an alpha token',
      );

    const claim = await jsonRequest(baseUrl, '/api/tasks/beta%3Avictim/claim', {
      method: 'POST', headers: headers(ALPHA_TOKEN),
      body: JSON.stringify({ agent_id: 'intruder' }),
      });
    assert.equal(claim.response.status, 403, 'the claim route is covered too');
    assert.equal(store.getTask('victim', 'beta').assigned_agent, null);
    });

  it("15. a composite id still works for the project's own token", async () => {
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({
      alpha: ALPHA_TOKEN, beta: BETA_TOKEN,
      });
    const r = await jsonRequest(baseUrl, '/api/tasks/beta:victim', {
      method: 'PATCH', headers: headers(BETA_TOKEN),
      body: JSON.stringify({ title: 'Legitimate' }),
      });
    assert.equal(r.response.status, 200, 'composite ids are a supported feature, not blocked');
    assert.equal(store.getTask('victim', 'beta').title, 'Legitimate');
    });

  it('16. rate limiting charges the project named by a composite id', async () => {
    process.env.KANBAN_AUTH_TOKEN = 'rl-token';
    process.env.KANBAN_RATE_LIMIT_PER_MIN = '2';
    resetRateLimits();
    await jsonRequest(baseUrl, '/api/tasks?project=rlc', {
      method: 'POST', headers: headers('rl-token'),
      body: JSON.stringify({ id: 'c-1', title: 'C', status: 'BACKLOG', round: 1 }),
      });

    // Without the path channel these would be charged to `default`, letting a
    // flood against one project evade that project's budget entirely.
    for (let i = 0; i < 2; i += 1) {
      await jsonRequest(baseUrl, '/api/tasks/rlc:c-1', {
        method: 'PATCH', headers: headers('rl-token'),
        body: JSON.stringify({ title: `t${i}` }),
        });
      }
    const blocked = await jsonRequest(baseUrl, '/api/tasks/rlc:c-1', {
      method: 'PATCH', headers: headers('rl-token'),
      body: JSON.stringify({ title: 'over' }),
      });
    assert.equal(blocked.response.status, 429);
    assert.match(blocked.body.error, /project 'rlc'/, 'charged to rlc, not default');
    });

  it('17. the rate-limit bucket map does not grow on invalid project names', async () => {
    process.env.KANBAN_AUTH_TOKEN = 'rl-token';
    process.env.KANBAN_RATE_LIMIT_PER_MIN = '100';
    resetRateLimits();
    for (let i = 0; i < 20; i += 1) {
      await jsonRequest(baseUrl, `/api/tasks?project=not%20valid%20${i}`, {
        method: 'POST', headers: headers('rl-token'),
        body: JSON.stringify({ id: `bad-${i}`, title: 'Bad', status: 'BACKLOG', round: 1 }),
        });
      }
    assert.ok(
      trackedProjectCount() <= 1,
      `an unvalidated caller-supplied name must not become a permanent bucket, got ${trackedProjectCount()}`,
      );
    });
});
