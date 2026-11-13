import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { gatherRecentCommits, resetRecentCommits } from '../askKnowledge.js';

const PASS = 'config-test-password';
const env = { KANBAN_ASK_OPENROUTER_API_KEY: 'sk-or-v1-x', KANBAN_ASK_PASSWORD: PASS, KANBAN_AUTH_RATE_LIMIT_PER_MIN: '2' };

async function withApp(fn) {
  resetRecentCommits();
  const app = createApp({ ask: { env: { ...env }, commitsFetch: async () => ({ ok: false, status: 403 }) } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((r) => server.close(r)); }
}
const get = async (base, pass) => {
  const res = await fetch(`${base}/api/ask/config`, pass === undefined ? {} : { headers: { 'x-ask-pass': pass } });
  return res.json();
};

describe('ask config visibility', () => {
  it('callers without the password get only enabled/gated', async () => {
    await withApp(async (base) => {
      assert.deepEqual(await get(base), { enabled: true, gated: true });
      assert.deepEqual(await get(base, 'wrong'), { enabled: true, gated: true });
    });
  });

  it('a valid password gets the full object', async () => {
    await withApp(async (base) => {
      const body = await get(base, PASS);
      assert.equal(body.provider, 'openrouter');
      assert.ok(body.model);
      assert.equal(body.scope, 'all');
    });
  });

  it('wrong passwords count toward the lockout, which then also stops the valid one', async () => {
    await withApp(async (base) => {
      for (let i = 0; i < 3; i += 1) await get(base, 'wrong');
      assert.deepEqual(await get(base, PASS), { enabled: true, gated: true }, 'locked out: no compare');
      const post = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ask-pass': PASS }, body: JSON.stringify({ question: 'How does the reaper work?' }) });
      assert.equal(post.status, 429, 'shared limiter');
    });
  });

  it('header-less calls are never counted', async () => {
    await withApp(async (base) => {
      for (let i = 0; i < 10; i += 1) await get(base);
      assert.equal((await get(base, PASS)).provider, 'openrouter');
    });
  });
});

describe('ask commit lookup token', () => {
  const saved = { ask: process.env.KANBAN_ASK_GITHUB_TOKEN, report: process.env.KANBAN_REPORT_GITHUB_TOKEN };
  beforeEach(() => { resetRecentCommits(); delete process.env.KANBAN_ASK_GITHUB_TOKEN; delete process.env.KANBAN_REPORT_GITHUB_TOKEN; });
  const restore = () => { for (const [k, v] of [['KANBAN_ASK_GITHUB_TOKEN', saved.ask], ['KANBAN_REPORT_GITHUB_TOKEN', saved.report]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  const okFetch = (seen) => async (url, opts) => { seen.push(opts.headers); return { ok: true, status: 200, json: async () => [{ sha: 'abcdef123', commit: { message: 'msg', author: { date: '2026-01-01T00:00:00Z' } } }] }; };

  it('never sends the bug-report token', async () => {
    process.env.KANBAN_REPORT_GITHUB_TOKEN = 'report-token';
    const seen = [];
    try { await gatherRecentCommits({ fetchImpl: okFetch(seen) }); } finally { restore(); }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].Authorization, undefined);
  });

  it('sends the Ask token when set', async () => {
    process.env.KANBAN_ASK_GITHUB_TOKEN = 'ask-token';
    process.env.KANBAN_REPORT_GITHUB_TOKEN = 'report-token';
    const seen = [];
    try { await gatherRecentCommits({ fetchImpl: okFetch(seen) }); } finally { restore(); }
    assert.equal(seen[0].Authorization, 'Bearer ask-token');
  });

  it('a 403/429 degrades to an empty section and is not retried for a while', async () => {
    let calls = 0;
    const f = async () => { calls += 1; return { ok: false, status: calls === 1 ? 403 : 429, json: async () => ({}) }; };
    try {
      assert.equal(await gatherRecentCommits({ fetchImpl: f }), '');
      assert.equal(await gatherRecentCommits({ fetchImpl: f }), '');
    } finally { restore(); }
    assert.equal(calls, 1, 'failure backoff avoids hammering a rate-limited API');
  });
});
