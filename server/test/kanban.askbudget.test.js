import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { redactSecrets, gatherTaskDetails } from '../askKnowledge.js';
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
