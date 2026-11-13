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

  it('a failed upstream call refunds its reserved slot', async () => {
    let calls = 0;
    const f = async () => { calls += 1; return calls <= 2 ? { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) } : okBody; };
    await withApp({ KANBAN_ASK_OPENROUTER_API_KEY: 'sk-or-v1-x', KANBAN_ASK_PASSWORD: PASS, KANBAN_ASK_PER_IP_PER_HOUR: '1', KANBAN_ASK_DAILY_CAP: '5' }, f, async (base) => {
      assert.equal((await post(base)).status, 502);
      assert.equal((await post(base)).status, 502);
      assert.equal((await post(base)).status, 200);
      assert.equal((await post(base)).status, 429);
    });
  });
});

describe('ask budget held until the handler finishes', () => {
  const env = { KANBAN_ASK_OPENROUTER_API_KEY: 'sk-or-v1-x', KANBAN_ASK_PASSWORD: PASS, KANBAN_ASK_PER_IP_PER_HOUR: '3', KANBAN_ASK_DAILY_CAP: '5' };

  it('aborted requests with a slow upstream never exceed the cap in upstream calls', async () => {
    let calls = 0;
    const f = async () => { calls += 1; await new Promise((r) => setTimeout(r, 300)); return okBody; };
    await withApp(env, f, async (base) => {
      await Promise.all(Array.from({ length: 20 }, async () => {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 15);
        try {
          await fetch(`${base}/api/ask`, {
            method: 'POST', signal: ac.signal,
            headers: { 'Content-Type': 'application/json', 'x-ask-pass': PASS },
            body: JSON.stringify({ question: 'How does the reaper reclaim a card?' }),
          });
        } catch { /* aborted */ }
      }));
      // Late arrivals while the first upstream calls are still in flight.
      const late = await post(base);
      assert.equal(late.status, 429);
      assert.ok(calls <= 3, `upstream calls ${calls} exceeded cap`);
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(calls <= 3);
    });
  });

  it('a client disconnect aborts the upstream fetch signal', async () => {
    let sawAbort = false;
    const f = (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => { sawAbort = true; reject(opts.signal.reason); });
    });
    await withApp(env, f, async (base) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 50);
      await fetch(`${base}/api/ask`, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', 'x-ask-pass': PASS }, body: JSON.stringify({ question: 'How does the reaper reclaim a card?' }) }).catch(() => {});
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(sawAbort, true);
    });
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
