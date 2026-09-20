/**
 * §2.11 Telegram reclaim notifier.
 *
 * These tests NEVER hit the network: the transport's `fetchImpl` and `sleep` are
 * injected, so we assert on the exact request bodies the notifier would send.
 * The point of the suite is the two properties that matter operationally:
 *   1. the message carries the full, correctly-escaped task detail; and
 *   2. a failing/absent webhook can never break the reclaim itself.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as store from '../store.js';
import {
  DEFAULT_BOARD_URL,
  DESCRIPTION_LIMIT,
  formatReclaimMessage,
  isNotifierRunning,
  notifierConfig,
  shouldNotify,
  startNotifier,
  stopNotifier,
} from '../notifier.js';

const BASE_ENV = {
  KANBAN_TELEGRAM_BOT_TOKEN: 'BOT-TOKEN-SECRET',
  KANBAN_TELEGRAM_CHAT_ID: '-5349084979',
};

/** A fetch double that records calls and returns a canned response. */
function mockFetch({ status = 200, body = { ok: true } } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  impl.calls = calls;
  return impl;
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe('§2.11 Telegram reclaim notifier', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-notify-'));
    delete process.env.KANBAN_REAP_ENABLED;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_NOTIFY_EVENTS;
    delete process.env.KANBAN_NOTIFY_PROJECTS;
    delete process.env.KANBAN_NOTIFY_INCLUDE_DESC;
    delete process.env.KANBAN_NOTIFY_MIN_INTERVAL_MS;
    delete process.env.KANBAN_BOARD_URL;
    // Named-project data resolves through KANBAN_DATA_DIR (not setStorage), so
    // point it at the temp dir too — otherwise these tests would read and write
    // the real on-disk board and leak state between runs.
    process.env.KANBAN_DATA_DIR = tmpDir;
    store.setStorage(null);
    store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
    await store.loadStore();
  });

  afterEach(async () => {
    stopNotifier();
    store.setStorage(null);
    delete process.env.KANBAN_DATA_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Config
  // --------------------------------------------------------------------------

  it('1. is disabled unless BOTH the bot token and chat id are set', () => {
    assert.equal(notifierConfig({}).enabled, false, 'both missing');
    assert.equal(
      notifierConfig({ KANBAN_TELEGRAM_BOT_TOKEN: 'T' }).enabled,
      false,
      'token alone cannot send'
    );
    assert.equal(
      notifierConfig({ KANBAN_TELEGRAM_CHAT_ID: '1' }).enabled,
      false,
      'chat id alone cannot send'
    );
    assert.equal(notifierConfig(BASE_ENV).enabled, true, 'both set ⇒ enabled');
  });

  it('2. applies the documented defaults, and env overrides', () => {
    const d = notifierConfig(BASE_ENV);
    assert.equal(d.boardUrl, DEFAULT_BOARD_URL);
    assert.deepEqual([...d.events].sort(), ['lease_expired', 'orphan_normalized']);
    assert.equal(d.projects, null, 'no allow-list ⇒ every project');
    assert.equal(d.includeDesc, true, 'full layout by default');
    assert.equal(d.minIntervalMs, 1000);

    const o = notifierConfig({
      ...BASE_ENV,
      KANBAN_NOTIFY_EVENTS: 'lease_expired',
      KANBAN_NOTIFY_PROJECTS: 'kanbann, chess',
      KANBAN_NOTIFY_INCLUDE_DESC: 'false',
      KANBAN_NOTIFY_MIN_INTERVAL_MS: '0',
      KANBAN_BOARD_URL: 'https://example.test/',
    });
    assert.deepEqual([...o.events], ['lease_expired']);
    assert.deepEqual([...o.projects].sort(), ['chess', 'kanbann']);
    assert.equal(o.includeDesc, false);
    assert.equal(o.minIntervalMs, 0);
    assert.equal(o.boardUrl, 'https://example.test', 'trailing slash trimmed');
  });

  // --------------------------------------------------------------------------
  // Event filtering
  // --------------------------------------------------------------------------

  it('3. only fires on reclaims, and honours the event + project allow-lists', () => {
    const cfg = notifierConfig(BASE_ENV);
    const base = { kind: 'reclaimed', reason: 'lease_expired', project: 'kanbann' };
    assert.equal(shouldNotify(base, cfg), true);
    assert.equal(
      shouldNotify({ ...base, reason: 'orphan_normalized' }, cfg),
      true,
      'orphan normalization is an alertable reclaim too'
    );
    assert.equal(shouldNotify({ ...base, kind: 'updated' }, cfg), false, 'edits are silent');
    assert.equal(shouldNotify({ ...base, kind: 'created' }, cfg), false);
    assert.equal(shouldNotify({ ...base, kind: 'claimed' }, cfg), false);
    assert.equal(
      shouldNotify(base, notifierConfig({ ...BASE_ENV, KANBAN_NOTIFY_EVENTS: 'orphan_normalized' })),
      false,
      'event allow-list respected'
    );
    assert.equal(
      shouldNotify(base, notifierConfig({ ...BASE_ENV, KANBAN_NOTIFY_PROJECTS: 'chess' })),
      false,
      'project allow-list respected'
    );
    assert.equal(shouldNotify(base, notifierConfig({})), false, 'disabled ⇒ never fires');
  });

  // --------------------------------------------------------------------------
  // Message rendering
  // --------------------------------------------------------------------------

  it('4. renders the full detail set for a lease-expiry reclaim', () => {
    const now = Date.parse('2026-09-20T14:40:00.000Z');
    const event = {
      kind: 'reclaimed',
      reason: 'lease_expired',
      project: 'kanbann',
      task: {
        id: 'w3-insights',
        project: 'kanbann',
        title: 'Investigate missed tactics',
        priority: 'high',
        round: 5,
        branch: 'task/w3-insights',
        depends_on: ['w3-tactics', 'w3-parse'],
        issues: ['GH-42'],
        description: 'Look into the missed-tactics pipeline.',
        reclaim_count: 2,
        stage_owners: { BUILDING: 'builder-7', IN_REVIEW: 'reviewer-2' },
      },
      prev: {
        id: 'w3-insights',
        assigned_agent: 'builder-7',
        claim_expires_at: '2026-09-20T14:32:05.000Z',
        updated: '2026-09-20T14:27:10.000Z',
        created_at: '2026-09-20T13:00:00.000Z',
        agent_logs: [{ message: 'LEASE EXPIRED', agent_id: 'system' }],
      },
    };
    const text = formatReclaimMessage(event, notifierConfig(BASE_ENV), { now });

    for (const expected of [
      'Task reclaimed to BACKLOG',
      'kanbann',
      'w3-insights',
      'Investigate missed tactics',
      'high',
      'round <b>5</b>',
      'task/w3-insights',
      'w3-tactics, w3-parse',
      'GH-42',
      'Lease expired',
      'builder-7',
      '2026-09-20 14:32:05 UTC',
      '7m ago',
      'Reclaim count:',
      'BUILDING: builder-7 · IN_REVIEW: reviewer-2',
      'Look into the missed-tactics pipeline.',
      'LEASE EXPIRED',
      `${DEFAULT_BOARD_URL}/?project=kanbann`,
    ]) {
      assert.ok(text.includes(expected), `message should include: ${expected}`);
    }
    assert.ok(text.length <= 4096, 'within Telegram limits');
  });

  it('5. distinguishes an ownerless orphan from a dead lease', () => {
    const orphan = {
      kind: 'reclaimed',
      reason: 'orphan_normalized',
      project: 'chess',
      task: { id: 'w3-streaks', project: 'chess', title: 'Streak screen', reclaim_count: 1 },
      prev: { id: 'w3-streaks', assigned_agent: null, claim_expires_at: null, agent_logs: [] },
    };
    const text = formatReclaimMessage(orphan, notifierConfig(BASE_ENV));
    assert.ok(text.includes('Orphan normalized'), 'orphan reason surfaced');
    assert.ok(text.includes('none — active with no owner'), 'explicit no-owner line');
    assert.ok(!text.includes('Lease ended'), 'no lease line when there was no lease');
    assert.ok(!text.includes('Held by:</b> null'), 'never prints a null owner');

    const lease = formatReclaimMessage(
      { ...orphan, reason: 'lease_expired', prev: { ...orphan.prev, assigned_agent: 'a-1' } },
      notifierConfig(BASE_ENV)
    );
    assert.ok(lease.includes('Lease expired'), 'lease reason surfaced');
    assert.ok(lease.includes('a-1'), 'previous owner surfaced');
  });

  it('6. re-escapes stored entities exactly once (no double-escaping)', () => {
    // The store saves already-escaped text; the alert must show the ORIGINAL
    // characters, while still neutralising anything Telegram would treat as HTML.
    const event = {
      kind: 'reclaimed',
      reason: 'lease_expired',
      project: 'kanbann',
      task: { id: 't-1', title: 'Tom &amp; Jerry &lt;b&gt;', reclaim_count: 1 },
      prev: { id: 't-1', assigned_agent: 'a&amp;b', agent_logs: [] },
    };
    const text = formatReclaimMessage(event, notifierConfig(BASE_ENV));
    assert.ok(text.includes('Tom &amp; Jerry &lt;b&gt;'), 'decoded then re-escaped once');
    assert.ok(!text.includes('&amp;amp;'), 'no double-escaped ampersand');
    assert.ok(!text.includes('&amp;quot;'), 'no double-escaped quote entity');
    assert.ok(text.includes('a&amp;b'), 'owner entity handled');
  });

  it('7. truncates the description, and omits it when disabled', () => {
    const long = 'x'.repeat(DESCRIPTION_LIMIT * 2);
    const event = {
      kind: 'reclaimed',
      reason: 'lease_expired',
      project: 'kanbann',
      task: { id: 't-2', description: long, reclaim_count: 1 },
      prev: { id: 't-2', agent_logs: [] },
    };
    const withDesc = formatReclaimMessage(event, { ...notifierConfig(BASE_ENV), includeDesc: true });
    assert.ok(withDesc.includes('…'), 'truncation marker present');
    assert.ok(
      !withDesc.includes('x'.repeat(DESCRIPTION_LIMIT + 1)),
      'description actually truncated'
    );

    const without = formatReclaimMessage(event, { ...notifierConfig(BASE_ENV), includeDesc: false });
    assert.ok(!without.includes('Description'), 'description omitted when disabled');
  });

  // --------------------------------------------------------------------------
  // End-to-end through the store (still no network)
  // --------------------------------------------------------------------------

  it('8. sends exactly one message per reclaim, end to end', async () => {
    const fetchImpl = mockFetch();
    const handle = startNotifier({ env: BASE_ENV, fetchImpl, sleep: async () => {} });
    assert.ok(handle, 'notifier started');
    assert.equal(isNotifierRunning(), true);

    const created = await store.createTask({
      id: 'notify-1',
      title: 'Notifier end to end',
      status: 'BACKLOG',
      round: 1,
      project: 'kanbann',
    });
    assert.equal(created.status, 201);
    await store.claimTask('notify-1', 'builder-9', 'kanbann');

    const before = fetchImpl.calls.length;
    const res = await store.reapExpiredClaims({ now: Date.now() + 6 * 60 * 1000 });
    assert.ok(res.reclaimed.includes('kanbann/notify-1'), 'task was reclaimed');
    await flush();

    const sent = fetchImpl.calls.slice(before);
    assert.equal(sent.length, 1, 'exactly one message per reclaim');
    assert.equal(sent[0].body.chat_id, BASE_ENV.KANBAN_TELEGRAM_CHAT_ID);
    assert.equal(sent[0].body.parse_mode, 'HTML');
    assert.ok(sent[0].url.includes('/sendMessage'), 'hits the Bot API sendMessage endpoint');
    assert.ok(sent[0].body.text.includes('notify-1'), 'message names the task');
    assert.ok(sent[0].body.text.includes('kanbann'), 'message names the project');
    assert.ok(sent[0].body.text.includes('builder-9'), 'message names the previous owner');
  });

  it('9. a failing webhook NEVER breaks the reclaim', async () => {
    const boom = async () => {
      throw new Error('network down');
    };
    const handle = startNotifier({ env: BASE_ENV, fetchImpl: boom, sleep: async () => {} });
    assert.ok(handle);

    await store.createTask({
      id: 'notify-2',
      title: 'Reclaim survives a dead webhook',
      status: 'BACKLOG',
      round: 1,
      project: 'kanbann',
    });
    await store.claimTask('notify-2', 'builder-1', 'kanbann');

    const res = await store.reapExpiredClaims({ now: Date.now() + 6 * 60 * 1000 });
    await flush();

    assert.ok(res.reclaimed.includes('kanbann/notify-2'), 'reclaim still succeeded');
    const t = store.getTask('notify-2', 'kanbann');
    assert.equal(t.status, 'BACKLOG', 'task really returned to BACKLOG');
    assert.equal(t.assigned_agent, null, 'owner cleared');
    assert.equal(t.reclaim_count, 1, 'reclaim bookkeeping intact');
  });

  it('10. is a no-op when unconfigured, and never leaks the token', async () => {
    const fetchImpl = mockFetch();
    const handle = startNotifier({ env: {}, fetchImpl, sleep: async () => {} });
    assert.equal(handle, null, 'no config ⇒ no handle');
    assert.equal(isNotifierRunning(), false);

    await store.createTask({
      id: 'notify-3',
      title: 'Silent when off',
      status: 'BACKLOG',
      round: 1,
      project: 'kanbann',
    });
    await store.claimTask('notify-3', 'builder-1', 'kanbann');
    await store.reapExpiredClaims({ now: Date.now() + 6 * 60 * 1000 });
    await flush();
    assert.equal(fetchImpl.calls.length, 0, 'no network call when disabled');

    // Token hygiene: capture console output and assert the secret never appears.
    const logged = [];
    const origErr = console.error;
    const origLog = console.log;
    console.error = (...a) => logged.push(a.join(' '));
    console.log = (...a) => logged.push(a.join(' '));
    try {
      const broken = startNotifier({
        env: BASE_ENV,
        fetchImpl: async () => {
          throw new Error(`failed posting with ${BASE_ENV.KANBAN_TELEGRAM_BOT_TOKEN}`);
        },
        sleep: async () => {},
      });
      assert.ok(broken);
      await store.createTask({
        id: 'notify-4',
        title: 'Token must not leak',
        status: 'BACKLOG',
        round: 1,
        project: 'kanbann',
      });
      await store.claimTask('notify-4', 'builder-1', 'kanbann');
      await store.reapExpiredClaims({ now: Date.now() + 6 * 60 * 1000 });
      await flush();
    } finally {
      console.error = origErr;
      console.log = origLog;
    }
    const all = logged.join('\n');
    assert.ok(all.includes('[kanban notify]'), 'the failure was actually logged');
    assert.ok(
      !all.includes(BASE_ENV.KANBAN_TELEGRAM_BOT_TOKEN),
      'the bot token must never be logged'
    );
    assert.ok(all.includes('[redacted]'), 'the secret was redacted in the log line');
  });
});
