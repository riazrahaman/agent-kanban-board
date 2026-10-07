/**
 * Review-round-1 fix (v2.16.0): express.json() runs globally, on every
 * route, BEFORE auth/routing — a malformed-JSON or oversized body throws a
 * body-parser error that used to fall through untranslated to the generic
 * 500 branch in server.js's global error handler. That misreports a client
 * mistake as a server failure and (worse) risks leaking internals in a 500.
 * This guards the translation: `entity.parse.failed` -> 400 `invalid_json`,
 * `entity.too.large` -> 413 `payload_too_large`, no stack/internal detail in
 * either body, and every OTHER error path (and every normal request) is
 * unaffected.
 *
 * Covers both the new, unauthenticated POST /api/bug-reports AND an existing
 * authenticated route (POST /api/tasks) to prove the translation is global
 * — it runs ahead of auth entirely, since express.json() throws before the
 * auth middleware ever sees the request.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

const TOKEN = 'bodyparser-test-token';
const ENV_KEYS = [
  'KANBAN_AUTH_TOKEN',
  'KANBAN_REPORT_GITHUB_TOKEN',
  'KANBAN_REPORT_REPO',
  'TURNSTILE_SECRET',
  'TURNSTILE_SITE_KEY',
];

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

// Default express.json() limit is 100kb; comfortably over it either way.
const OVERSIZED_BODY = JSON.stringify({ padding: 'x'.repeat(200 * 1024) });

describe('global body-parser error translation', () => {
  let saved = {};
  let server;
  let baseUrl;

  before(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    // Enable the bug-reports route too, so its branch of this guard exercises
    // the real feature rather than a 404-gated stub.
    process.env.KANBAN_REPORT_GITHUB_TOKEN = 'ghp_test_token';
    process.env.KANBAN_REPORT_REPO = 'owner/repo';
    process.env.TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
    process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
    const app = createApp({ bugReports: { fetch: async () => { throw new Error('unused in this suite'); } } });
    ({ server, baseUrl } = await startTestServer(app));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('POST /api/bug-reports with malformed JSON -> 400 invalid_json', async () => {
    const { res, body } = await jsonRequest(baseUrl, '/api/bug-reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ this is not valid json',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(body, { error: 'invalid_json' });
  });

  it('POST /api/bug-reports with a >100KB body -> 413 payload_too_large', async () => {
    const { res, body } = await jsonRequest(baseUrl, '/api/bug-reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: OVERSIZED_BODY,
    });
    assert.equal(res.status, 413);
    assert.deepEqual(body, { error: 'payload_too_large' });
  });

  it('POST /api/tasks with malformed JSON -> 400 invalid_json (no token needed — body-parser runs before auth)', async () => {
    const { res, body } = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ broken',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(body, { error: 'invalid_json' });
  });

  it('POST /api/tasks with a >100KB body -> 413 payload_too_large, even WITH a valid token', async () => {
    const { res, body } = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: OVERSIZED_BODY,
    });
    assert.equal(res.status, 413);
    assert.deepEqual(body, { error: 'payload_too_large' });
  });

  it('neither error body leaks a stack trace, file path, or the raw body-parser message', async () => {
    const malformed = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ broken',
    });
    const raw = JSON.stringify(malformed.body);
    assert.doesNotMatch(raw, /at [A-Za-z]/); // stack-frame shape ("at Object.<anonymous> ...")
    assert.doesNotMatch(raw, /\.js:\d+:\d+/); // file:line:col
    assert.deepEqual(Object.keys(malformed.body), ['error']);

    const oversized = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: OVERSIZED_BODY,
    });
    assert.deepEqual(Object.keys(oversized.body), ['error']);
  });

  it('a normal, valid request is completely unaffected (translation is additive, not a behavior change)', async () => {
    const { res } = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
        'X-Agent-Role': 'admin',
      },
      body: JSON.stringify({
        id: 'bodyparser-sanity-task',
        project: 'default',
        title: 'sanity check',
        round: 1,
        status: 'BACKLOG',
      }),
    });
    assert.equal(res.status, 201);
  });

  it('a well-formed, under-limit bug report still reaches route logic (not swallowed by the translation)', async () => {
    // No turnstileToken supplied -> the route's own validation runs (proving
    // the request body WAS parsed and handed to the handler, not short-
    // circuited), returning its own 400 rather than falling through to the
    // body-parser branch.
    const { res, body } = await jsonRequest(baseUrl, '/api/bug-reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ok title', description: 'a description long enough', website: '' }),
    });
    assert.equal(res.status, 400);
    assert.equal(body.error, 'invalid_payload');
  });
});
