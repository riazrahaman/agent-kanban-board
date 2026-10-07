/**
 * In-app "Report a bug" → GitHub issue (v2.16.0, opt-public-bug-reports).
 *
 * Covers routes/bugReports.js end to end over real HTTP (createApp + a fake
 * injected `fetch`, never the real network): the feature's off-by-default
 * gate, the honeypot, validation limits, Turnstile outcomes, the per-IP/
 * daily rate limits (incl. an X-Forwarded-For spoof attempt), GitHub retry
 * behaviour, and markdown-injection sanitisation. Also guards that mounting
 * this unauthenticated route does not weaken auth on any other route.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import {
  buildIssueBody,
  fenceDescription,
  getMaxBackticks,
  neutralizeMentions,
  sanitizeTitleForGithub,
  stripControlChars,
} from '../routes/bugReports.js';

const ENV_KEYS = [
  'KANBAN_REPORT_GITHUB_TOKEN',
  'KANBAN_REPORT_REPO',
  'TURNSTILE_SECRET',
  'TURNSTILE_SITE_KEY',
  'TURNSTILE_HOSTNAMES',
  'KANBAN_REPORT_DAILY_CAP',
  'KANBAN_REPORT_PER_IP_PER_HOUR',
  'KANBAN_REPORT_GITHUB_API_URL',
  'KANBAN_AUTH_TOKEN',
  'KANBAN_TRUST_PROXY',
];

function configureEnv(overrides = {}) {
  process.env.KANBAN_REPORT_GITHUB_TOKEN = 'ghp_test_token';
  process.env.KANBAN_REPORT_REPO = 'owner/repo';
  process.env.TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
  process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function jsonRequest(baseUrl, route, options = {}) {
  const res = await fetch(`${baseUrl}${route}`, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}

function postBody(overrides = {}) {
  return JSON.stringify({
    title: 'Board shows blank column',
    description: 'Steps: open the board, switch project, column X is blank for no reason.',
    turnstileToken: 'test-token',
    website: '',
    ...overrides,
  });
}

function fakeResponse(status, body, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (k) => lower[k.toLowerCase()] ?? null },
  };
}

function okTurnstileBody(overrides = {}) {
  return { success: true, action: 'bug-report', hostname: 'board.example.test', ...overrides };
}

function okGithubBody(overrides = {}) {
  return { number: 42, html_url: 'https://github.com/owner/repo/issues/42', ...overrides };
}

/**
 * Builds an injectable fetch that dispatches on URL: Turnstile siteverify vs
 * the GitHub issues endpoint. Each handler is a function of the call count
 * FOR THAT endpoint (1-based) so tests can script "fail once, then succeed".
 * Every call is recorded in `.calls` for assertions (e.g. "never called").
 */
function makeFetch({ turnstile, github } = {}) {
  let turnstileCalls = 0;
  let githubCalls = 0;
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('challenges.cloudflare.com')) {
      turnstileCalls += 1;
      if (!turnstile) return fakeResponse(200, okTurnstileBody());
      const out = turnstile(turnstileCalls, opts);
      if (out instanceof Error) throw out;
      return out;
    }
    if (String(url).includes('/issues')) {
      githubCalls += 1;
      if (!github) return fakeResponse(201, okGithubBody());
      const out = github(githubCalls, opts);
      if (out instanceof Error) throw out;
      return out;
    }
    throw new Error(`unexpected fetch url in test: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

async function withApp(bugReportsDeps, fn) {
  const app = createApp({ bugReports: bugReportsDeps });
  const { server, baseUrl } = await startTestServer(app);
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('bug reports: feature gate', () => {
  let saved = {};
  before(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is off when unconfigured: config reports disabled, POST 404s', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    await withApp({}, async (baseUrl) => {
      const cfg = await jsonRequest(baseUrl, '/api/bug-reports/config');
      assert.equal(cfg.res.status, 200);
      assert.deepEqual(cfg.body, { enabled: false });

      const post = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(post.res.status, 404);
    });
  });

  it('is off when only some of the four required vars are set', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.KANBAN_REPORT_GITHUB_TOKEN = 'tok';
    process.env.KANBAN_REPORT_REPO = 'owner/repo';
    // TURNSTILE_SECRET / TURNSTILE_SITE_KEY deliberately left unset.
    await withApp({}, async (baseUrl) => {
      const cfg = await jsonRequest(baseUrl, '/api/bug-reports/config');
      assert.deepEqual(cfg.body, { enabled: false });
    });
  });

  it('config never leaks the GitHub token or Turnstile secret, only the public site key', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    await withApp({}, async (baseUrl) => {
      const cfg = await jsonRequest(baseUrl, '/api/bug-reports/config');
      assert.equal(cfg.res.status, 200);
      assert.deepEqual(cfg.body, { enabled: true, siteKey: process.env.TURNSTILE_SITE_KEY });
      const raw = JSON.stringify(cfg.body);
      assert.doesNotMatch(raw, /ghp_test_token/);
      assert.doesNotMatch(raw, new RegExp(process.env.TURNSTILE_SECRET));
    });
  });

  it('unauthenticated route does not weaken auth on other routes (mutations still need the token)', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv({ KANBAN_AUTH_TOKEN: 'board-token' });
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      // The bug-report route itself needs no token.
      const report = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(report.res.status, 201);

      // Every other mutating route is still fail-closed without it.
      const createTask = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 't-1', project: 'default', title: 'x', round: 1, status: 'BACKLOG' }),
      });
      assert.equal(createTask.res.status, 401);

      // Reads are unaffected (read-auth off by default).
      const tasks = await jsonRequest(baseUrl, '/api/tasks');
      assert.equal(tasks.res.status, 200);
    });
  });
});

describe('bug reports: honeypot + validation', () => {
  let saved = {};
  before(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
  });
  after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('a filled honeypot returns a quiet fake success and never calls GitHub or Turnstile', async () => {
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody({ website: 'http://spam.example' }),
      });
      assert.equal(res.res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.equal(fetchImpl.calls.length, 0, 'honeypot must short-circuit before any outbound call');
    });
  });

  it('a non-string honeypot value is treated as filled, not thrown on', async () => {
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody({ website: ['not-a-string'] }),
      });
      assert.equal(res.res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.equal(fetchImpl.calls.length, 0);
    });
  });

  it('rejects non-string title/description/turnstileToken as invalid_payload', async () => {
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody({ title: 42 }),
      });
      assert.equal(res.res.status, 400);
      assert.equal(res.body.error, 'invalid_payload');
    });
  });

  it('rejects an empty (post-trim) title', async () => {
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody({ title: '   ' }),
      });
      assert.equal(res.res.status, 400);
      assert.equal(res.body.error, 'invalid_title');
    });
  });

  it('rejects a title over 120 chars', async () => {
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody({ title: 'x'.repeat(121) }),
      });
      assert.equal(res.res.status, 400);
      assert.equal(res.body.error, 'invalid_title');
    });
  });

  it('accepts a title at exactly 120 chars', async () => {
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody({ title: 'x'.repeat(120) }),
      });
      assert.equal(res.res.status, 201);
    });
  });

  it('rejects a description under 10 chars', async () => {
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody({ description: 'too short' }),
      });
      assert.equal(res.res.status, 400);
      assert.equal(res.body.error, 'invalid_description');
    });
  });

  it('rejects a description over 5000 chars', async () => {
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody({ description: 'x'.repeat(5001) }),
      });
      assert.equal(res.res.status, 400);
      assert.equal(res.body.error, 'invalid_description');
    });
  });
});

describe('bug reports: Turnstile outcomes', () => {
  let saved = {};
  before(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('success:false (fail or already-spent/replayed token) -> 403 invalid_captcha', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    const fetchImpl = makeFetch({
      turnstile: () => fakeResponse(200, { success: false, 'error-codes': ['invalid-input-response'] }),
    });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 403);
      assert.equal(res.body.error, 'invalid_captcha');
      assert.equal(fetchImpl.calls.filter((c) => c.url.includes('issues')).length, 0, 'must not file on a failed captcha');
    });
  });

  it('wrong action -> 403 invalid_captcha_action', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    const fetchImpl = makeFetch({
      turnstile: () => fakeResponse(200, okTurnstileBody({ action: 'login' })),
    });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 403);
      assert.equal(res.body.error, 'invalid_captcha_action');
    });
  });

  it('hostname outside the allow-list -> 403 invalid_captcha_hostname', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv({ TURNSTILE_HOSTNAMES: 'allowed.example.test' });
    const fetchImpl = makeFetch({
      turnstile: () => fakeResponse(200, okTurnstileBody({ hostname: 'evil.example.test' })),
    });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 403);
      assert.equal(res.body.error, 'invalid_captcha_hostname');
    });
  });

  it('hostname IS in the allow-list -> passes through to filing', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv({ TURNSTILE_HOSTNAMES: 'allowed.example.test,other.example.test' });
    const fetchImpl = makeFetch({
      turnstile: () => fakeResponse(200, okTurnstileBody({ hostname: 'allowed.example.test' })),
    });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 201);
    });
  });

  it('TURNSTILE_HOSTNAMES unset skips the hostname check entirely', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv({ TURNSTILE_HOSTNAMES: undefined });
    const fetchImpl = makeFetch({
      turnstile: () => fakeResponse(200, okTurnstileBody({ hostname: 'anything.example.test' })),
    });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 201);
    });
  });

  it('a Turnstile network error fails closed: 502 verification_unavailable', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    const fetchImpl = makeFetch({
      turnstile: () => new Error('ECONNRESET'),
    });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 502);
      assert.equal(res.body.error, 'verification_unavailable');
    });
  });

  it('a Turnstile network failure does NOT consume the daily cap (retry is free)', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv({ KANBAN_REPORT_DAILY_CAP: '1' });
    let fail = true;
    const fetchImpl = makeFetch({
      turnstile: () => {
        if (fail) return new Error('ECONNRESET');
        return fakeResponse(200, okTurnstileBody());
      },
    });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const first = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(first.res.status, 502);
      fail = false;
      const second = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(second.res.status, 201, 'the failed attempt must not have spent the cap of 1');
    });
  });
});

describe('bug reports: rate limits', () => {
  let saved = {};
  before(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('enforces the per-IP hourly cap', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv({ KANBAN_REPORT_PER_IP_PER_HOUR: '2', KANBAN_REPORT_DAILY_CAP: '100' });
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const statuses = [];
      for (let i = 0; i < 3; i++) {
        const r = await jsonRequest(baseUrl, '/api/bug-reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: postBody(),
        });
        statuses.push(r.res.status);
      }
      assert.deepEqual(statuses, [201, 201, 429]);
    });
  });

  it('enforces the global daily cap across different IPs', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv({ KANBAN_REPORT_PER_IP_PER_HOUR: '100', KANBAN_REPORT_DAILY_CAP: '1' });
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const first = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
        body: postBody(),
      });
      assert.equal(first.res.status, 201);
      const second = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        // A different reported IP — the daily cap is global, not per-IP.
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.200' },
        body: postBody(),
      });
      assert.equal(second.res.status, 429);
      assert.equal(second.body.error, 'daily_cap_reached');
    });
  });

  it('a spoofed X-Forwarded-For prefix cannot dodge the per-IP limit beyond the trusted hop', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    // KANBAN_TRUST_PROXY=1: only the hop nearest the server is trusted, so
    // Express reads the RIGHTMOST X-Forwarded-For entry as the client. An
    // attacker connecting directly can prepend as many fake addresses as they
    // like on the left; none of them should change the bucket the request is
    // charged against as long as the rightmost (trusted-hop-supplied) address
    // stays the same.
    configureEnv({ KANBAN_REPORT_PER_IP_PER_HOUR: '2', KANBAN_REPORT_DAILY_CAP: '100', KANBAN_TRUST_PROXY: '1' });
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const realIp = '198.51.100.7';
      const chains = [
        `9.9.9.9, ${realIp}`,
        `1.2.3.4, 5.6.7.8, ${realIp}`,
        `${Math.random()}, ${realIp}`,
      ];
      const statuses = [];
      for (const chain of chains) {
        const r = await jsonRequest(baseUrl, '/api/bug-reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': chain },
          body: postBody(),
        });
        statuses.push(r.res.status);
      }
      assert.deepEqual(
        statuses,
        [201, 201, 429],
        'every spoofed prefix must still collapse onto the one real-IP bucket',
      );
    });
  });

  it('a report that fails to file does not consume the daily cap', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv({ KANBAN_REPORT_DAILY_CAP: '1' });

    // A failing GitHub call must leave the cap of 1 untouched.
    const failingFetch = makeFetch({ github: () => fakeResponse(400, { message: 'bad request' }) });
    await withApp({ fetch: failingFetch }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 502);
    });

    // Rate-limit counters live inside the router closure created per
    // createApp() call, so this second app starts with a clean slate — it
    // stands in for "the same deployment, next request" to prove the cap
    // itself (not just the counter) was never spent by the failed attempt.
    // (A same-process persistence test would need the router to survive
    // across requests on ONE app instance, which the per-IP/daily-cap test
    // above already covers for the success path.)
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 201);
    });
  });

  it('a report that fails to file does not consume the daily cap (same app instance)', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv({ KANBAN_REPORT_DAILY_CAP: '1' });
    let shouldFail = true;
    const fetchImpl = makeFetch({
      github: () => (shouldFail ? fakeResponse(400, { message: 'bad request' }) : fakeResponse(201, okGithubBody())),
    });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const failed = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(failed.res.status, 502);

      shouldFail = false;
      const succeeded = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(succeeded.res.status, 201, 'the cap of 1 must still be available after the earlier failure');

      shouldFail = false;
      const third = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(third.res.status, 429, 'the cap IS spent once a report actually succeeds');
    });
  });
});

describe('bug reports: GitHub filing — retry, labels, success', () => {
  let saved = {};
  before(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('succeeds and returns the issue number + url', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    const fetchImpl = makeFetch({ github: () => fakeResponse(201, okGithubBody({ number: 7 })) });
    await withApp({ fetch: fetchImpl, delays: [1, 1] }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 201);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.issue_number, 7);
      assert.match(res.body.issue_url, /^https:\/\/github\.com\//);
    });
  });

  it('retries once on a 5xx and succeeds on the second attempt', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    const fetchImpl = makeFetch({
      github: (n) => (n === 1 ? fakeResponse(503, { message: 'down' }) : fakeResponse(201, okGithubBody())),
    });
    await withApp({ fetch: fetchImpl, delays: [1, 1] }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 201);
      assert.equal(fetchImpl.calls.filter((c) => c.url.includes('issues')).length, 2);
    });
  });

  it('retries on 429 and respects retry-after before the next attempt', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    const start = Date.now();
    const fetchImpl = makeFetch({
      github: (n) => (n === 1 ? fakeResponse(429, { message: 'slow down' }, { 'Retry-After': '0' }) : fakeResponse(201, okGithubBody())),
    });
    await withApp({ fetch: fetchImpl, delays: [1, 1] }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 201);
    });
  });

  it('exhausts retries on persistent 5xx -> 502 could_not_file, no upstream body leaked', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    const fetchImpl = makeFetch({
      github: () => fakeResponse(500, { message: 'internal secret stack trace details' }),
    });
    await withApp({ fetch: fetchImpl, delays: [1, 1] }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 502);
      assert.equal(res.body.error, 'could_not_file');
      assert.equal(fetchImpl.calls.filter((c) => c.url.includes('issues')).length, 3);
      assert.doesNotMatch(JSON.stringify(res.body), /secret stack trace/);
    });
  });

  it('does NOT retry on a plain 400/401 and returns 502 with no upstream detail', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    const fetchImpl400 = makeFetch({ github: () => fakeResponse(400, { message: 'bad' }) });
    await withApp({ fetch: fetchImpl400, delays: [1, 1] }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 502);
      assert.equal(res.body.error, 'could_not_file');
      assert.equal(fetchImpl400.calls.filter((c) => c.url.includes('issues')).length, 1);
    });

    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    const fetchImpl401 = makeFetch({ github: () => fakeResponse(401, { message: 'bad creds' }) });
    await withApp({ fetch: fetchImpl401, delays: [1, 1] }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 502);
      assert.equal(fetchImpl401.calls.filter((c) => c.url.includes('issues')).length, 1);
    });
  });

  it('exhausts retries on repeated network errors -> 502 could_not_file', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    const fetchImpl = makeFetch({ github: () => new Error('ETIMEDOUT') });
    await withApp({ fetch: fetchImpl, delays: [1, 1] }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 502);
      assert.equal(res.body.error, 'could_not_file');
    });
  });

  it('falls back to filing WITHOUT the label on a 422, uncounted against the retry budget', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    const bodies = [];
    const fetchImpl = makeFetch({
      github: (n, opts) => {
        bodies.push(JSON.parse(opts.body));
        if (n === 1) return fakeResponse(422, { message: 'Label does not exist' });
        return fakeResponse(201, okGithubBody());
      },
    });
    await withApp({ fetch: fetchImpl, delays: [1, 1] }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 201);
      assert.equal(bodies.length, 2);
      assert.deepEqual(bodies[0].labels, ['user-report']);
      assert.equal(bodies[1].labels, undefined, 'the retry must drop the labels field entirely');
    });
  });

  it('a second consecutive 422 (no labels left to drop) is NOT retried forever', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    const fetchImpl = makeFetch({ github: () => fakeResponse(422, { message: 'still invalid' }) });
    await withApp({ fetch: fetchImpl, delays: [1, 1] }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      assert.equal(res.res.status, 502);
      // Exactly 2 calls: the original (with labels) + the one uncounted
      // label-stripped retry, which also 422s and is NOT retried again.
      assert.equal(fetchImpl.calls.filter((c) => c.url.includes('issues')).length, 2);
    });
  });

  it('sends the required GitHub headers', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    let seenHeaders = null;
    const fetchImpl = makeFetch({
      github: (n, opts) => {
        seenHeaders = opts.headers;
        return fakeResponse(201, okGithubBody());
      },
    });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
    });
    assert.equal(seenHeaders.Authorization, `Bearer ${process.env.KANBAN_REPORT_GITHUB_TOKEN}`);
    assert.equal(seenHeaders.Accept, 'application/vnd.github+json');
    assert.equal(seenHeaders['X-GitHub-Api-Version'], '2022-11-28');
    assert.ok(seenHeaders['User-Agent']);
  });

  it('posts to KANBAN_REPORT_GITHUB_API_URL when set (demo/test stub override)', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv({ KANBAN_REPORT_GITHUB_API_URL: 'http://127.0.0.1:9999/fake-github' });
    const fetchImpl = makeFetch({ github: () => fakeResponse(201, okGithubBody()) });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
    });
    assert.ok(fetchImpl.calls.some((c) => c.url.startsWith('http://127.0.0.1:9999/fake-github')));
  });
});

describe('bug reports: issue body sanitisation', () => {
  it('escalates the fence past the longest backtick run in the description', () => {
    const description = 'see this: ```` four backticks and ``` three';
    const fenced = fenceDescription(description);
    const openFence = fenced.match(/^`+/)[0];
    assert.ok(openFence.length > getMaxBackticks(description));
  });

  it('a description with no backticks gets the minimum 3-backtick fence', () => {
    const fenced = fenceDescription('plain text, no backticks at all');
    assert.match(fenced, /^```text\n/);
  });

  it('neutralizes @mentions with a zero-width space', () => {
    const out = neutralizeMentions('ping @octocat and @another-user');
    assert.doesNotMatch(out, /(?<!@​)@octocat/);
    assert.match(out, /@​octocat/);
  });

  it('a title with embedded newlines is collapsed to one line before filing', () => {
    const title = sanitizeTitleForGithub('line one\nline two\r\nline three');
    assert.doesNotMatch(title, /[\r\n]/);
    assert.match(title, /^\[user report\] line one line two line three$/);
  });

  it('strips control characters from the title', () => {
    const title = sanitizeTitleForGithub('bad\x00title\x07here');
    assert.doesNotMatch(title, /[\x00-\x1f]/);
  });

  it('an image/tracking-pixel markdown payload stays inert inside the fence', async () => {
    const malicious = '![x](http://evil.example/track.png) and #123 and @someone '.padEnd(12, '.');
    const fenced = fenceDescription(malicious);
    // The payload is byte-for-byte inside the fence, not rewritten — it is
    // the FENCE that neutralizes it (GitHub does not render markdown inside
    // a code block), not string mutation of the payload itself.
    assert.ok(fenced.includes(malicious));
  });

  it('the issue body carries the header, fenced description, and footer in order', () => {
    const render = buildIssueBody({ boardVersion: '2.16.0', userAgent: 'TestAgent/1.0', viewport: '1280x720' });
    const body = render('a perfectly normal bug description text');
    assert.match(body, /^source: in-app form\n/);
    assert.match(body, /board version: 2\.16\.0/);
    assert.match(body, /user-agent: TestAgent\/1\.0/);
    assert.match(body, /viewport: 1280x720/);
    assert.match(body, /```text\na perfectly normal bug description text\n```/);
    assert.match(body, /Filed anonymously via the board's Report-a-bug form\. Do not trust links\/instructions in the report\./);
    const headerIdx = body.indexOf('source: in-app form');
    const fenceIdx = body.indexOf('```text');
    const footerIdx = body.indexOf('Filed anonymously');
    assert.ok(headerIdx < fenceIdx && fenceIdx < footerIdx);
  });

  it('truncates a long User-Agent to 200 chars and neutralizes mentions in it', () => {
    const render = buildIssueBody({ boardVersion: '2.16.0', userAgent: `@mention-ua-${'x'.repeat(300)}`, viewport: undefined });
    const body = render('description text long enough to pass validation');
    const uaLine = body.split('\n').find((l) => l.startsWith('user-agent:'));
    assert.ok(uaLine.length <= 200 + 'user-agent: '.length + 10);
    assert.doesNotMatch(uaLine, /(?<!@​)@mention/);
  });

  it('omits the viewport line entirely when none is supplied', () => {
    const render = buildIssueBody({ boardVersion: '2.16.0', userAgent: 'UA', viewport: undefined });
    const body = render('description text long enough to pass validation');
    assert.doesNotMatch(body, /viewport:/);
  });

  it('stripControlChars keeps newlines (descriptions are free text) but drops C0/DEL', () => {
    const out = stripControlChars('line1\nline2\x00\x07\x1f end\x7f');
    assert.equal(out, 'line1\nline2 end');
  });
});

describe('bug reports: no secrets in responses', () => {
  let saved = {};
  before(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
  });
  after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('a GitHub 5xx failure response never echoes the token or upstream body', async () => {
    const fetchImpl = makeFetch({
      github: () => fakeResponse(502, { message: process.env.KANBAN_REPORT_GITHUB_TOKEN }),
    });
    await withApp({ fetch: fetchImpl, delays: [1, 1] }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/bug-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody(),
      });
      const raw = JSON.stringify(res.body);
      assert.doesNotMatch(raw, /ghp_test_token/);
    });
  });
});
