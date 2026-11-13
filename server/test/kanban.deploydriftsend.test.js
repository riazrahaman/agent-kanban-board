import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runDeployDriftCheck, deployDriftStatus, resetDeployDriftState } from '../deployDrift.js';

function feed(tag, telegramOk) {
  const calls = [];
  const impl = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('api.telegram.org')) return { ok: telegramOk.value, status: telegramOk.value ? 200 : 500, json: async () => ({}) };
    if (href.includes('/tags')) return { ok: true, status: 200, json: async () => [{ name: tag }] };
    return { ok: true, status: 200, json: async () => ({ tag_name: tag }) };
  };
  impl.calls = calls;
  return impl;
}

describe('deploy-drift alert retry', () => {
  beforeEach(() => resetDeployDriftState());
  it('a failed Telegram send is retried on the next tick', async () => {
    const env = { KANBAN_TELEGRAM_BOT_TOKEN: 'tok', KANBAN_TELEGRAM_CHAT_ID: '42' };
    const ok = { value: false };
    const f = feed('v99.9.9', ok);
    const origErr = console.error; console.error = () => {};
    try {
      await runDeployDriftCheck({ fetchImpl: f, env, now: 0, graceMs: 0 });
      assert.equal(deployDriftStatus().status, 'drift');
      await runDeployDriftCheck({ fetchImpl: f, env, now: 1, graceMs: 0 });
      assert.equal(f.calls.filter((u) => u.includes('telegram')).length, 2, 'retried');
      ok.value = true;
      await runDeployDriftCheck({ fetchImpl: f, env, now: 2, graceMs: 0 });
      await runDeployDriftCheck({ fetchImpl: f, env, now: 3, graceMs: 0 });
      assert.equal(f.calls.filter((u) => u.includes('telegram')).length, 3, 'no resend after success');
    } finally { console.error = origErr; }
  });
});
