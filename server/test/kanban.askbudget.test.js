import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import crypto from 'node:crypto';
import { redactSecrets, gatherTaskDetails, buildSystemPrompt } from '../askKnowledge.js';
import { resetRecentCommits } from '../askKnowledge.js';

const PASS = 'budget-test-password';

async function withApp(env, fetchImpl, fn) {
  resetRecentCommits();
  const app = createApp({ ask: { env, fetch: fetchImpl, commitsFetch: async () => ({ ok: false, status: 403 }) } });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((r) => server.close(r)); }
}

const post = (base) => fetch(`${base}/api/ask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-ask-pass': PASS },
  body: JSON.stringify({ question: 'How does the reaper reclaim a card?' }),
});

const okBody = { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: 'ans' } }] }) };

describe('ask budget reservation', () => {
  it('concurrent requests never exceed the per-IP cap in upstream calls', async () => {
    let calls = 0;
    const f = async () => { calls += 1; await new Promise((r) => setTimeout(r, 40)); return okBody; };
    await withApp({ KANBAN_ASK_OPENROUTER_API_KEY: 'sk-or-v1-x', KANBAN_ASK_PASSWORD: PASS, KANBAN_ASK_PER_IP_PER_HOUR: '3', KANBAN_ASK_DAILY_CAP: '5' }, f, async (base) => {
      const rs = await Promise.all(Array.from({ length: 20 }, () => post(base)));
      assert.equal(rs.filter((r) => r.status === 200).length, 3);
      assert.equal(calls, 3);
    });
  });

  it('concurrent requests never exceed the daily cap', async () => {
    let calls = 0;
    const f = async () => { calls += 1; await new Promise((r) => setTimeout(r, 40)); return okBody; };
    await withApp({ KANBAN_ASK_OPENROUTER_API_KEY: 'sk-or-v1-x', KANBAN_ASK_PASSWORD: PASS, KANBAN_ASK_PER_IP_PER_HOUR: '50', KANBAN_ASK_DAILY_CAP: '5' }, f, async (base) => {
      await Promise.all(Array.from({ length: 20 }, () => post(base)));
      assert.equal(calls, 5);
    });
  });

  const lim = { KANBAN_ASK_OPENROUTER_API_KEY: 'sk-or-v1-x', KANBAN_ASK_PASSWORD: PASS, KANBAN_ASK_PER_IP_PER_HOUR: '2', KANBAN_ASK_DAILY_CAP: '5' };
  const status = (n) => async () => ({ ok: false, status: n, headers: { get: () => null }, json: async () => ({}) });

  it('a provider 5xx is charged', async () => {
    let calls = 0;
    const f = async (...a) => { calls += 1; return status(500)(...a); };
    await withApp(lim, f, async (base) => {
      assert.equal((await post(base)).status, 502);
      assert.equal((await post(base)).status, 502);
      assert.equal((await post(base)).status, 429);
      assert.equal(calls, 2);
    });
  });

  it('a provider 401 is refunded', async () => {
    let calls = 0;
    const f = async (...a) => { calls += 1; return status(401)(...a); };
    await withApp(lim, f, async (base) => {
      for (let i = 0; i < 4; i += 1) assert.equal((await post(base)).status, 502);
      assert.equal(calls, 4);
    });
  });

  it('a refused connection is refunded', async () => {
    let calls = 0;
    const f = async () => {
      calls += 1;
      const e = new TypeError('fetch failed');
      e.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      throw e;
    };
    await withApp(lim, f, async (base) => {
      for (let i = 0; i < 4; i += 1) assert.equal((await post(base)).status, 502);
      assert.equal(calls, 4);
    });
  });

  it('an empty 2xx answer is charged', async () => {
    const f = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [] }) });
    await withApp(lim, f, async (base) => {
      await post(base); await post(base);
      assert.equal((await post(base)).status, 429);
    });
  });
});

describe('ask budget held until the handler finishes', () => {
  const env = { KANBAN_ASK_OPENROUTER_API_KEY: 'sk-or-v1-x', KANBAN_ASK_PASSWORD: PASS, KANBAN_ASK_PER_IP_PER_HOUR: '3', KANBAN_ASK_DAILY_CAP: '5' };

  // Fake that rejects on signal abort, like undici does.
  const signalHonouring = (counter, ms = 300) => (url, opts) => new Promise((resolve, reject) => {
    counter.n += 1;
    const t = setTimeout(() => resolve(okBody), ms);
    opts.signal.addEventListener('abort', () => { clearTimeout(t); reject(opts.signal.reason); });
  });
  const abortedPost = (base, ms = 15) => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), ms);
    return fetch(`${base}/api/ask`, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'x-ask-pass': PASS },
      body: JSON.stringify({ question: 'How does the reaper reclaim a card?' }),
    }).catch(() => {});
  };

  it('aborted requests never exceed the cap in upstream calls (signal-honouring upstream)', async () => {
    const c = { n: 0 };
    await withApp(env, signalHonouring(c), async (base) => {
      await Promise.all(Array.from({ length: 20 }, () => abortedPost(base)));
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(c.n <= 3, `upstream calls ${c.n} exceeded cap`);
      assert.equal((await post(base)).status, 429, 'sent calls were charged');
    });
  });

  it('the OpenRouter path does not pass the client abort signal', async () => {
    let aborted = null;
    const f = async (url, opts) => { await new Promise((r) => setTimeout(r, 200)); aborted = opts.signal.aborted; return okBody; };
    await withApp(env, f, async (base) => {
      await abortedPost(base, 40);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(aborted, false);
    });
  });

  it('an Ollama client disconnect aborts the upstream signal and is still charged', async () => {
    const c = { n: 0 };
    const oenv = { KANBAN_ASK_PROVIDER: 'ollama', KANBAN_ASK_OLLAMA_HOST: 'http://127.0.0.1:1', KANBAN_ASK_PASSWORD: PASS, KANBAN_ASK_PER_IP_PER_HOUR: '1' };
    await withApp(oenv, signalHonouring(c, 2000), async (base) => {
      await abortedPost(base, 60);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(c.n, 1, 'no retry after the client left');
      assert.equal((await post(base)).status, 429);
    });
  });

  it('a timeout after the fetch was sent is charged', async () => {
    const c = { n: 0 };
    await withApp({ ...env, KANBAN_ASK_TIMEOUT_MS: '50', KANBAN_ASK_PER_IP_PER_HOUR: '1' }, signalHonouring(c, 2000), async (base) => {
      assert.equal((await post(base)).status, 503);
      assert.equal((await post(base)).status, 429);
      assert.equal(c.n, 1);
    });
  });

  it('a client gone before the fetch starts is neither sent nor charged', async () => {
    let calls = 0;
    const f = async () => { calls += 1; return okBody; };
    // Slow prompt building: the client leaves during the commit-history await.
    resetRecentCommits();
    const app = createApp({ ask: { env: { ...env, KANBAN_ASK_PER_IP_PER_HOUR: '1' }, fetch: f, commitsFetch: async () => { await new Promise((r) => setTimeout(r, 200)); return { ok: false, status: 403 }; } } });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      await abortedPost(base, 40);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(calls, 0);
      assert.equal((await post(base)).status, 200, 'slot was not charged');
    } finally { await new Promise((r) => server.close(r)); }
  });

  it('an exception while building the prompt still releases the slot', async () => {
    let calls = 0;
    const f = async () => { calls += 1; return okBody; };
    let boom = true;
    // Read after the slot is reserved (prompt building), throws once.
    const throwingEnv = { ...env, KANBAN_ASK_PER_IP_PER_HOUR: '1' };
    Object.defineProperty(throwingEnv, 'KANBAN_ASK_INCLUDE_LOGS', {
      get() { if (boom) { boom = false; throw new Error('boom'); } return undefined; },
    });
    resetRecentCommits();
    const app = createApp({ ask: { env: throwingEnv, fetch: f, commitsFetch: async () => ({ ok: false, status: 403 }) } });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const first = await post(base);
      const second = await post(base);
      assert.equal(first.status, 500);
      assert.equal(second.status, 200, 'slot must be released after a thrown error');
    } finally { await new Promise((r) => server.close(r)); }
  });
});

describe('ask log redaction cost', () => {
  it('a long adversarial string redacts quickly', () => {
    const evil = 'a.'.repeat(20000) + '://';
    const t = process.hrtime.bigint();
    redactSecrets(evil);
    assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 100);
  });

  it('log entries are clipped before redaction', async () => {
    const huge = 'a.'.repeat(1_500_000) + '://';
    const store = {
      getTasks: () => [{ id: 'T-1', title: 'Reaper card', project: 'default', agent_logs: [{ timestamp: '1', message: huge }] }],
      getTaskLogs: async () => ({ entries: [] }),
    };
    const t = process.hrtime.bigint();
    await gatherTaskDetails(store, 'T-1', {});
    assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 500);
  });
});

describe('ask redaction of clipped private keys', () => {
  it('an unterminated PEM block is redacted to the end', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 4096, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const clipped = `note ${privateKey}`.slice(0, 1856);
    const out = redactSecrets(clipped);
    assert.match(out, /\[redacted-private-key\]/);
    assert.doesNotMatch(out, /BEGIN/);
    assert.equal(out.includes(privateKey.split('\n')[1]), false);
  });

  it('a 4096-bit key in a log entry never reaches the prompt', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 4096, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const store = {
      getTasks: () => [{ id: 'T-9', title: 'Key card', project: 'default', agent_logs: [{ timestamp: '1', message: privateKey }] }],
      getTaskLogs: async () => ({ entries: [] }),
    };
    const taskDetails = await gatherTaskDetails(store, 'T-9', {});
    const prompt = buildSystemPrompt({ snapshot: { available: false }, taskDetails, boardFacts: null, retrieved: [], recentCommits: null, maxTokens: 100000 });
    assert.match(prompt, /redacted-private-key/);
    assert.doesNotMatch(prompt, /BEGIN [A-Z ]*PRIVATE KEY/);
    assert.equal(prompt.includes(privateKey.split('\n')[2]), false);
  });
});
