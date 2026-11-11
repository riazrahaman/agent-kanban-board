/**
 * D6 (v3.12.6) - webhook retries, dead-letter ring and queue cap.
 *
 * All cases inject a fake fetch (no real network) and a zero backoff, so a
 * retry ladder is exercised without sleeping. The dispatch path is driven
 * through the real diff stream (store.createTask), which is what production
 * uses, so a delivery failure can never be mistaken for a route-level concern.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.KANBAN_REAP_ENABLED = 'false';
delete process.env.KANBAN_STORAGE_BACKEND;
delete process.env.KANBAN_PROJECT_TOKENS;

const store = await import('../store.js');
const {
  startWebhooks,
  stopWebhooks,
  resetWebhookState,
  getWebhookStats,
  awaitWebhookIdle,
  webhookConfig,
} = await import('../webhooks.js');

const URL = 'https://hook.test/h';

let tmpDir;
let seq = 0;

test.before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kanban-webhooks-'));
  process.env.KANBAN_DATA_DIR = tmpDir;
  process.env.KANBAN_DATA_FILE = join(tmpDir, 'tasks.json');
  store.setStorage(null);
  await store.loadStore();
});

test.after(async () => {
  stopWebhooks();
  await rm(tmpDir, { recursive: true, force: true });
  delete process.env.KANBAN_DATA_DIR;
  delete process.env.KANBAN_DATA_FILE;
  store.setStorage(null);
});

test.beforeEach(() => {
  stopWebhooks();
  resetWebhookState();
});

function fakeResponse(status, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  };
}

function env(extra = {}) {
  return {
    KANBAN_WEBHOOK_URLS: URL,
    KANBAN_WEBHOOK_BACKOFF_MS: '0',
    ...extra,
  };
}

async function createCard() {
  seq += 1;
  const id = `wh-${seq}`;
  const result = await store.createTask({ id, title: `Webhook ${id}`, status: 'BACKLOG', round: 1, project: 'webhooks' });
  assert.equal(result.error, undefined, `create should succeed, got ${result.error}`);
  return id;
}

async function waitForCalls(counter, expected) {
  for (let i = 0; i < 200; i += 1) {
    if (counter.calls >= expected) return;
    await new Promise((resolve) => { setTimeout(resolve, 1); });
  }
  throw new Error(`timed out waiting for ${expected} webhook calls`);
}

test('0. config exposes the retry/queue defaults and honours overrides', () => {
  const defaults = webhookConfig({});
  assert.equal(defaults.maxAttempts, 3);
  assert.equal(defaults.backoffMs, 250);
  assert.equal(defaults.maxQueue, 100);
  assert.equal(defaults.deadLetterMax, 50);

  const tuned = webhookConfig({
    KANBAN_WEBHOOK_MAX_ATTEMPTS: '5',
    KANBAN_WEBHOOK_BACKOFF_MS: '0',
    KANBAN_WEBHOOK_MAX_QUEUE: '2',
    KANBAN_WEBHOOK_DEAD_LETTER_MAX: '3',
  });
  assert.equal(tuned.maxAttempts, 5);
  assert.equal(tuned.backoffMs, 0);
  assert.equal(tuned.maxQueue, 2);
  assert.equal(tuned.deadLetterMax, 3);
});

test('1. a transient 500 then a 200 succeeds in 2 attempts', async () => {
  const counter = { calls: 0 };
  const fakeFetch = async () => {
    counter.calls += 1;
    return counter.calls === 1 ? fakeResponse(500) : fakeResponse(200);
  };
  startWebhooks({ env: env(), fetchImpl: fakeFetch });
  await createCard();
  await awaitWebhookIdle();

  assert.equal(counter.calls, 2);
  const stats = getWebhookStats()[URL];
  assert.equal(stats.deadLetters.length, 0, 'a recovered event is not dead-lettered');
  assert.equal(stats.queued, 0);
});

test('2. a persistent 500 is attempted 3 times and dead-lettered', async () => {
  const counter = { calls: 0 };
  const fakeFetch = async () => {
    counter.calls += 1;
    return fakeResponse(500);
  };
  startWebhooks({ env: env(), fetchImpl: fakeFetch });
  await createCard();
  await awaitWebhookIdle();

  assert.equal(counter.calls, 3);
  const stats = getWebhookStats()[URL];
  assert.equal(stats.deadLetters.length, 1);
  const entry = stats.deadLetters[0];
  assert.equal(entry.event_kind, 'created');
  assert.equal(entry.status, 500);
  assert.equal(entry.attempts, 3);
  assert.ok(!Number.isNaN(Date.parse(entry.at)), 'dead letter carries an ISO timestamp');
});

test('3. a 400 is terminal: one attempt, no retry, dead-lettered', async () => {
  const counter = { calls: 0 };
  const fakeFetch = async () => {
    counter.calls += 1;
    return fakeResponse(400);
  };
  startWebhooks({ env: env(), fetchImpl: fakeFetch });
  await createCard();
  await awaitWebhookIdle();

  assert.equal(counter.calls, 1, 'other 4xx responses are not retried');
  const stats = getWebhookStats()[URL];
  assert.equal(stats.deadLetters.length, 1);
  assert.equal(stats.deadLetters[0].status, 400);
  assert.equal(stats.deadLetters[0].attempts, 1);
});

test('4. the per-URL queue cap drops the OLDEST queued event', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const counter = { calls: 0 };
  const fakeFetch = async () => {
    counter.calls += 1;
    if (counter.calls === 1) await gate;
    return fakeResponse(200);
  };
  startWebhooks({ env: env({ KANBAN_WEBHOOK_MAX_QUEUE: '2' }), fetchImpl: fakeFetch });

  // First event is in flight and blocked: everything after it queues.
  await createCard();
  await waitForCalls(counter, 1);
  await createCard();
  await createCard();
  await createCard();

  const during = getWebhookStats()[URL];
  assert.equal(during.queued, 2, 'queue is capped at 2 waiting events');
  assert.equal(during.dropped, 1, 'the oldest waiting event was dropped once');

  release();
  await awaitWebhookIdle();
  const after = getWebhookStats()[URL];
  assert.equal(after.queued, 0);
  assert.equal(after.dropped, 1);
});

test('5. delivery never throws to the caller (network failure is dead-lettered)', async () => {
  const fakeFetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  startWebhooks({ env: env(), fetchImpl: fakeFetch });

  // createTask resolves even though every delivery attempt throws.
  await createCard();
  await awaitWebhookIdle();

  const stats = getWebhookStats()[URL];
  assert.equal(stats.deadLetters.length, 1);
  assert.equal(stats.deadLetters[0].attempts, 3);
  assert.match(stats.deadLetters[0].error, /ECONNREFUSED/);
});

test('6. Retry-After is honoured (capped) instead of the exponential ladder', async () => {
  const delays = [];
  const counter = { calls: 0 };
  const fakeFetch = async () => {
    counter.calls += 1;
    if (counter.calls === 1) return fakeResponse(429, { 'retry-after': '1' });
    return fakeResponse(200);
  };
  startWebhooks({
    env: env(),
    fetchImpl: fakeFetch,
    sleep: async (ms) => { delays.push(ms); },
  });
  await createCard();
  await awaitWebhookIdle();

  assert.equal(counter.calls, 2);
  assert.deepEqual(delays, [1000], 'the 429 Retry-After of 1s is used verbatim');
});
