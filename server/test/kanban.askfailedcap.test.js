/** Ask wrong-password tracking is bounded, and still locks out tracked addresses. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

const PASS = 'ask-pass-for-test';
const post = (baseUrl, ip, pass = 'wrong') =>
  fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ask-pass': pass, 'X-Forwarded-For': ip },
    body: JSON.stringify({ question: 'q' }),
  });

describe('ask failed-auth map bound', () => {
  it('locks out a tracked address, and a flood of distinct addresses cannot grow it past the cap', async () => {
    delete process.env.KANBAN_TRUST_PROXY;
    const app = createApp({
      ask: {
        env: { KANBAN_ASK_OPENROUTER_API_KEY: 'sk-or-v1-x', KANBAN_ASK_PASSWORD: PASS, KANBAN_AUTH_RATE_LIMIT_PER_MIN: '2' },
        fetch: async () => { throw new Error('no network'); },
        commitsFetch: async () => ({ ok: false, status: 403 }),
      },
    });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await post(baseUrl, '198.51.100.1')).status, 401);
      assert.equal((await post(baseUrl, '198.51.100.1')).status, 401);
      assert.equal((await post(baseUrl, '198.51.100.1')).status, 429, 'tracked address is locked out');
      // Fill past the cap; the oldest tracked entry is evicted rather than the map growing.
      for (let i = 0; i < 10000; i += 1) {
        await post(baseUrl, `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
      }
      assert.equal((await post(baseUrl, '198.51.100.1')).status, 401, 'oldest entry was evicted (map is bounded)');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
