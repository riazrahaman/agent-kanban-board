import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'kanban-leasewindow-token';
const TTL_MS = 60_000;

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function authHeader(token) {
  return ['B' + 'earer', token].join(' ');
}

function headers(role = 'builder', agentId) {
  return {
    Authorization: authHeader(TOKEN),
    'Content-Type': 'application/json',
    ...(role ? { 'X-Agent-Role': role } : {}),
    ...(agentId ? { 'X-Agent-Id': agentId } : {}),
  };
}

function taskBody(id, title, extra = {}) {
  return JSON.stringify({ id, title, status: 'BACKLOG', round: 1, ...extra });
}

async function jsonRequest(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

async function setExpiry(id, ms) {
  const t = store.getTask(id);
  assert.ok(t, `${id} exists in store`);
  t.claim_expires_at = new Date(ms).toISOString();
  const storage = store.getStorage(t.project);
  await storage.saveTask(t, store.getProjectBucket(t.project));
  return t;
}

describe('v2.12.0 lease window (§2.4b)', () => {
  let tmpDir;
  let server;
  let baseUrl;
  let realNow;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    process.env.KANBAN_CLAIM_TTL_MS = String(TTL_MS);
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    process.env.KANBAN_REAP_ENABLED = 'false';
    realNow = () => Date.now();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-leasewin-'));
    // NAMED projects resolve through jsonDataDir() (KANBAN_DATA_DIR), which
    // setStorage() does NOT redirect — point it at the tmpdir so project-scoped
    // tests never write into the repo's in-repo server/data fallback.
    process.env.KANBAN_DATA_DIR = tmpDir;
    store.setStorage(null);
    store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  after(async () => {
    store.stopReaper();
    store.setNowFn(realNow);
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_CLAIM_TTL_MS;
    delete process.env.KANBAN_REAP_ENABLED;
    delete process.env.KANBAN_MIN_LEASE_MS;
    delete process.env.KANBAN_MAX_LEASE_MS;
    delete process.env.KANBAN_HOLDER_WRITE_RENEWS_ALL;
    store.setStorage(null);
  });

  // --- claim_lease_ms persisted on claim ---

  it('1. claim with lease_ms persists claim_lease_ms on the task', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('lw-1', 'Lease window one'),
    });
    const t0 = Date.now();
    const claim = await jsonRequest(baseUrl, '/api/tasks/lw-1/claim', {
      method: 'POST', headers: headers(undefined, 'alpha'),
      body: JSON.stringify({ agent_id: 'alpha', lease_ms: 300000 }),
    });
    assert.equal(claim.response.status, 200);
    assert.equal(claim.body.claim_lease_ms, 300000, 'claim_lease_ms persisted as 300000');
    const expected = t0 + 300000;
    assert.ok(
      Math.abs(Date.parse(claim.body.claim_expires_at) - expected) < 5000,
      'lease deadline is ~now + 300000 (the requested window, not the default TTL)',
    );
  });

  it('2. claim without lease_ms uses the server default (claim_lease_ms = default TTL)', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('lw-2', 'Lease window two'),
    });
    const t0 = Date.now();
    const claim = await jsonRequest(baseUrl, '/api/tasks/lw-2/claim', {
      method: 'POST', headers: headers(undefined, 'beta'),
      body: JSON.stringify({ agent_id: 'beta' }),
    });
    assert.equal(claim.response.status, 200);
    assert.equal(claim.body.claim_lease_ms, TTL_MS, 'claim_lease_ms defaults to KANBAN_CLAIM_TTL_MS');
    const expected = t0 + TTL_MS;
    assert.ok(
      Math.abs(Date.parse(claim.body.claim_expires_at) - expected) < 5000,
      'lease deadline is ~now + TTL_MS',
    );
  });

  // --- lease_ms clamping ---

  it('3. lease_ms below MIN is clamped up to MIN', async () => {
    process.env.KANBAN_MIN_LEASE_MS = '120000';
    try {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('lw-3', 'Clamp min'),
      });
      const claim = await jsonRequest(baseUrl, '/api/tasks/lw-3/claim', {
        method: 'POST', headers: headers(undefined, 'gamma'),
        body: JSON.stringify({ agent_id: 'gamma', lease_ms: 1000 }),
      });
      assert.equal(claim.response.status, 200);
      assert.equal(claim.body.claim_lease_ms, 120000, 'clamped up to MIN');
    } finally {
      delete process.env.KANBAN_MIN_LEASE_MS;
    }
  });

  it('4. lease_ms above MAX is clamped down to MAX', async () => {
    process.env.KANBAN_MAX_LEASE_MS = '600000';
    try {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('lw-4', 'Clamp max'),
      });
      const claim = await jsonRequest(baseUrl, '/api/tasks/lw-4/claim', {
        method: 'POST', headers: headers(undefined, 'delta'),
        body: JSON.stringify({ agent_id: 'delta', lease_ms: 999999999 }),
      });
      assert.equal(claim.response.status, 200);
      assert.equal(claim.body.claim_lease_ms, 600000, 'clamped down to MAX');
    } finally {
      delete process.env.KANBAN_MAX_LEASE_MS;
    }
  });

  it('5. lease_ms = 0 is rejected with 400', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('lw-5', 'Zero lease'),
    });
    const claim = await jsonRequest(baseUrl, '/api/tasks/lw-5/claim', {
      method: 'POST', headers: headers(undefined, 'epsilon'),
      body: JSON.stringify({ agent_id: 'epsilon', lease_ms: 0 }),
    });
    assert.equal(claim.response.status, 400);
    assert.match(claim.body.error, /positive number of milliseconds/);
  });

  it('6. lease_ms = negative is rejected with 400', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('lw-6', 'Negative lease'),
    });
    const claim = await jsonRequest(baseUrl, '/api/tasks/lw-6/claim', {
      method: 'POST', headers: headers(undefined, 'zeta'),
      body: JSON.stringify({ agent_id: 'zeta', lease_ms: -100 }),
    });
    assert.equal(claim.response.status, 400);
    assert.match(claim.body.error, /positive number of milliseconds/);
  });

  it('7. lease_ms = non-numeric is rejected with 400', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('lw-7', 'Bad lease'),
    });
    const claim = await jsonRequest(baseUrl, '/api/tasks/lw-7/claim', {
      method: 'POST', headers: headers(undefined, 'eta'),
      body: JSON.stringify({ agent_id: 'eta', lease_ms: 'foo' }),
    });
    assert.equal(claim.response.status, 400);
    assert.match(claim.body.error, /positive number of milliseconds/);
  });

  // --- heartbeat renews using the card's own lease window ---

  it('8. heartbeat on a card with claim_lease_ms uses that window, not the default', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('lw-8', 'Heartbeat window'),
    });
    await jsonRequest(baseUrl, '/api/tasks/lw-8/claim', {
      method: 'POST', headers: headers(undefined, 'theta'),
      body: JSON.stringify({ agent_id: 'theta', lease_ms: 300000 }),
    });
    const t0 = Date.now();
    const beat = await jsonRequest(baseUrl, '/api/tasks/lw-8/heartbeat', {
      method: 'POST', headers: headers('builder', 'theta'),
      body: JSON.stringify({ agent_id: 'theta' }),
    });
    assert.equal(beat.response.status, 200);
    assert.equal(beat.body.claim_lease_ms, 300000, 'claim_lease_ms preserved across heartbeat');
    const expected = t0 + 300000;
    assert.ok(
      Math.abs(Date.parse(beat.body.claim_expires_at) - expected) < 5000,
      'heartbeat extends by the card own 300000ms window, not the 60000ms default',
    );
  });

  // --- renewLease with explicit lease_ms ---

  it('9. renewLease with explicit lease_ms changes the window for future heartbeats', async () => {
    await store.createTask({ id: 'lw-9', title: 'Renew change', status: 'BACKLOG', round: 1 });
    await store.claimTask('lw-9', 'iota', undefined, { lease_ms: 120000 });
    let t = store.getTask('lw-9');
    assert.equal(t.claim_lease_ms, 120000);
    // Renew with a different lease_ms RE-WINDOWS the card: the stored window is
    // updated too, otherwise the very next heartbeat (which reads claim_lease_ms)
    // would shrink the lease straight back to the old value — the exact RC-1
    // footgun this feature exists to remove.
    const t0 = Date.now();
    const r = await store.renewLease('lw-9', 'iota', { caller: { role: 'builder' }, lease_ms: 300000 });
    assert.equal(r.status, 200);
    t = store.getTask('lw-9');
    assert.equal(t.claim_lease_ms, 300000, 'explicit heartbeat lease_ms re-windows claim_lease_ms');
    const expected = t0 + 300000;
    assert.ok(
      Math.abs(Date.parse(t.claim_expires_at) - expected) < 5000,
      'renew deadline uses the requested 300000ms',
    );
  });

  it('10. renewLease without lease_ms extends by the card own stored window', async () => {
    await store.createTask({ id: 'lw-10', title: 'Renew default', status: 'BACKLOG', round: 1 });
    await store.claimTask('lw-10', 'kappa', undefined, { lease_ms: 300000 });
    const t0 = Date.now();
    const r = await store.renewLease('lw-10', 'kappa', { caller: { role: 'builder' } });
    assert.equal(r.status, 200);
    const t = store.getTask('lw-10');
    const expected = t0 + 300000;
    assert.ok(
      Math.abs(Date.parse(t.claim_expires_at) - expected) < 5000,
      'renew without lease_ms uses leaseWindowFor -> the stored 300000ms',
    );
  });

  // --- nextClaim with lease_ms ---

  it('11. nextClaim respects lease_ms and persists claim_lease_ms', async () => {
    // Isolate in its own project so leftover BACKLOG cards from earlier tests
    // cannot win the priority/FIFO selection.
    await store.createTask({ id: 'lw-11', title: 'Next claim lease', status: 'BACKLOG', round: 1 }, 'lw11proj');
    const t0 = Date.now();
    const r = await store.nextClaim({ agentId: 'lambda', role: 'builder', project: 'lw11proj', lease_ms: 300000 });
    assert.equal(r.status, 200);
    assert.equal(r.task.id, 'lw-11');
    assert.equal(r.task.claim_lease_ms, 300000, 'nextClaim persisted claim_lease_ms');
    const expected = t0 + 300000;
    assert.ok(
      Math.abs(Date.parse(r.task.claim_expires_at) - expected) < 5000,
      'nextClaim deadline is ~now + 300000',
    );
  });

  // --- claim_lease_ms cleared on reclaim ---

  it('12. reclaim clears claim_lease_ms to null', async () => {
    await store.createTask({ id: 'lw-12', title: 'Reclaim clears', status: 'BACKLOG', round: 1 });
    await store.claimTask('lw-12', 'mu', undefined, { lease_ms: 300000 });
    let t = store.getTask('lw-12');
    assert.equal(t.claim_lease_ms, 300000);
    await setExpiry('lw-12', Date.now() - 1000);
    await store.reapExpiredClaims({ now: Date.now() });
    t = store.getTask('lw-12');
    assert.equal(t.assigned_agent, null, 'ownership cleared');
    assert.equal(t.claim_expires_at, null, 'lease cleared');
    assert.equal(t.claim_lease_ms, null, 'claim_lease_ms cleared on reclaim');
  });

  // --- unlock clears claim_lease_ms ---

  it('13. dependency unlock clears claim_lease_ms to null', async () => {
    // The unlock path is internal (unlockTaskInner); it is only reachable through
    // the public maybeUnlockDependents sweep, which runs when a BLOCKED card's
    // last dependency reaches DONE. Seed a BLOCKED card carrying a stale lease +
    // window, complete its dependency, and assert the unlock clears the window.
    await store.createTask({ id: 'lw-13-dep', title: 'Dep', status: 'BACKLOG', round: 1 });
    await store.createTask(
      { id: 'lw-13', title: 'Blocked', status: 'BLOCKED', round: 1, depends_on: ['lw-13-dep'] },
    );
    // Hand-seed a claimed window on the BLOCKED card (createTask forces it null).
    let t = store.getTask('lw-13');
    t.assigned_agent = 'nu';
    t.claim_lease_ms = 300000;
    t.claim_expires_at = new Date(Date.now() + 300000).toISOString();
    await store.getStorage(t.project).saveTask(t, store.getProjectBucket(t.project));
    assert.equal(store.getTask('lw-13').claim_lease_ms, 300000);
    // Drive the dependency to DONE, then run the unlock sweep.
    await store.patchTask('lw-13-dep', { status: 'BUILDING' }, { caller: { agent_id: 'sys', role: 'admin' } });
    await store.patchTask('lw-13-dep', { status: 'IN_REVIEW' }, { caller: { agent_id: 'sys', role: 'admin' } });
    await store.patchTask('lw-13-dep', { status: 'IN_TEST' }, { caller: { agent_id: 'sys', role: 'admin' } });
    await store.patchTask('lw-13-dep', { status: 'DONE' }, { caller: { agent_id: 'sys', role: 'admin' } });
    await store.maybeUnlockDependents('lw-13-dep', { now: Date.now() });
    t = store.getTask('lw-13');
    assert.equal(t.status, 'BACKLOG', 'unblocked back to BACKLOG');
    assert.equal(t.assigned_agent, null);
    assert.equal(t.claim_lease_ms, null, 'claim_lease_ms cleared on unlock');
  });

  // --- bulk heartbeat (POST /api/agents/:id/heartbeat) ---

  it('14. POST /api/agents/:id/heartbeat renews all held leases in one call', async () => {
    // Create 3 tasks, claim them all by the same agent.
    for (const id of ['lw-14a', 'lw-14b', 'lw-14c']) {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody(id, `Bulk ${id}`),
      });
      await jsonRequest(baseUrl, `/api/tasks/${id}/claim`, {
        method: 'POST', headers: headers(undefined, 'bulk-agent'),
        body: JSON.stringify({ agent_id: 'bulk-agent' }),
      });
    }
    const deadlinesBefore = ['lw-14a', 'lw-14b', 'lw-14c'].map((id) =>
      Date.parse(store.getTask(id).claim_expires_at),
    );
    await new Promise((r) => setTimeout(r, 20));
    const beat = await jsonRequest(baseUrl, '/api/agents/bulk-agent/heartbeat', {
      method: 'POST', headers: headers('builder', 'bulk-agent'),
      body: JSON.stringify({}),
    });
    assert.equal(beat.response.status, 200);
    assert.equal(beat.body.count, 3, 'all three leases renewed');
    for (let i = 0; i < 3; i++) {
      const id = ['lw-14a', 'lw-14b', 'lw-14c'][i];
      const after = Date.parse(store.getTask(id).claim_expires_at);
      assert.ok(after > deadlinesBefore[i], `${id} lease extended`);
    }
  });

  it('15. POST /api/agents/:id/heartbeat is 403 for a non-privileged non-self caller', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('lw-15', 'Auth guard'),
    });
    await jsonRequest(baseUrl, '/api/tasks/lw-15/claim', {
      method: 'POST', headers: headers(undefined, 'owner-15'),
      body: JSON.stringify({ agent_id: 'owner-15' }),
    });
    const beat = await jsonRequest(baseUrl, '/api/agents/owner-15/heartbeat', {
      method: 'POST', headers: headers('builder', 'intruder-15'),
      body: JSON.stringify({}),
    });
    assert.equal(beat.response.status, 403);
    assert.match(beat.body.error, /Forbidden/);
  });

  it('16. POST /api/agents/:id/heartbeat allows a privileged role to renew another agent', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('lw-16', 'Priv heart'),
    });
    await jsonRequest(baseUrl, '/api/tasks/lw-16/claim', {
      method: 'POST', headers: headers(undefined, 'worker-16'),
      body: JSON.stringify({ agent_id: 'worker-16' }),
    });
    const before = Date.parse(store.getTask('lw-16').claim_expires_at);
    await new Promise((r) => setTimeout(r, 20));
    const beat = await jsonRequest(baseUrl, '/api/agents/worker-16/heartbeat', {
      method: 'POST', headers: headers('runner', 'admin-bot'),
      body: JSON.stringify({}),
    });
    assert.equal(beat.response.status, 200);
    assert.equal(beat.body.count, 1, 'privileged role renewed the other agent lease');
    const after = Date.parse(store.getTask('lw-16').claim_expires_at);
    assert.ok(after > before, 'lease was extended');
  });

  it('17. bulk heartbeat does NOT revive a lapsed lease', async () => {
    await store.createTask({ id: 'lw-17', title: 'Lapsed not revived', status: 'BACKLOG', round: 1 });
    await store.claimTask('lw-17', 'lapsed-agent', undefined, {});
    // Force the lease into the past.
    await setExpiry('lw-17', Date.now() - 5000);
    const r = await store.renewAllLeases('lapsed-agent', {});
    assert.equal(r.status, 200);
    assert.equal(r.count, 0, 'a lapsed lease is not revived');
    const t = store.getTask('lw-17');
    // The task is still technically claimed (the reaper has not run), but the
    // bulk heartbeat correctly skipped it because the expiry is in the past.
    assert.equal(t.assigned_agent, 'lapsed-agent', 'ownership not touched by the skipped renewal');
  });

  it('18. bulk heartbeat with project scope only renews tasks in that project', async () => {
    await store.createTask({ id: 'lw-18a', title: 'In scope', status: 'BACKLOG', round: 1, project: 'atlas' });
    await store.createTask({ id: 'lw-18b', title: 'Out of scope', status: 'BACKLOG', round: 1, project: 'orion' });
    await store.claimTask('lw-18a', 'scoped-agent', 'atlas', {});
    await store.claimTask('lw-18b', 'scoped-agent', 'orion', {});
    const r = await store.renewAllLeases('scoped-agent', { project: 'atlas' });
    assert.equal(r.status, 200);
    assert.equal(r.count, 1, 'only the atlas task was renewed');
    assert.ok(r.renewed.includes('atlas/lw-18a'));
    assert.ok(!r.renewed.includes('orion/lw-18b'));
  });

  // --- holder-write renews all (Fix 3) ---

  it('19. a holder PATCH renews all other leases held by the same agent', async () => {
    // Create two tasks claimed by the same agent.
    await store.createTask({ id: 'lw-19a', title: 'Sibling A', status: 'BACKLOG', round: 1 });
    await store.createTask({ id: 'lw-19b', title: 'Sibling B', status: 'BACKLOG', round: 1 });
    await store.claimTask('lw-19a', 'sibling-agent', undefined, {});
    await store.claimTask('lw-19b', 'sibling-agent', undefined, {});
    const beforeB = Date.parse(store.getTask('lw-19b').claim_expires_at);
    await new Promise((r) => setTimeout(r, 20));
    // PATCH lw-19a as the holder — this should also renew lw-19b.
    const patched = await store.patchTask('lw-19a', { title: 'Sibling A updated' }, {
      caller: { agent_id: 'sibling-agent', role: 'builder' },
    });
    assert.equal(patched.status, 200);
    const afterB = Date.parse(store.getTask('lw-19b').claim_expires_at);
    assert.ok(afterB > beforeB, 'lw-19b lease was renewed as a side effect of patching lw-19a');
  });

  it('20. a holder log append renews all other leases held by the same agent', async () => {
    await store.createTask({ id: 'lw-20a', title: 'Log A', status: 'BACKLOG', round: 1 });
    await store.createTask({ id: 'lw-20b', title: 'Log B', status: 'BACKLOG', round: 1 });
    await store.claimTask('lw-20a', 'log-agent', undefined, {});
    await store.claimTask('lw-20b', 'log-agent', undefined, {});
    const beforeB = Date.parse(store.getTask('lw-20b').claim_expires_at);
    await new Promise((r) => setTimeout(r, 20));
    await store.appendLog('lw-20a', 'log-agent', 'progress update', undefined, {});
    const afterB = Date.parse(store.getTask('lw-20b').claim_expires_at);
    assert.ok(afterB > beforeB, 'lw-20b lease was renewed as a side effect of logging on lw-20a');
  });

  it('21. holder-write-renews-all can be disabled via env', async () => {
    process.env.KANBAN_HOLDER_WRITE_RENEWS_ALL = '0';
    try {
      await store.createTask({ id: 'lw-21a', title: 'Disabled A', status: 'BACKLOG', round: 1 });
      await store.createTask({ id: 'lw-21b', title: 'Disabled B', status: 'BACKLOG', round: 1 });
      await store.claimTask('lw-21a', 'disabled-agent', undefined, {});
      await store.claimTask('lw-21b', 'disabled-agent', undefined, {});
      const beforeB = store.getTask('lw-21b').claim_expires_at;
      await store.patchTask('lw-21a', { title: 'Disabled A updated' }, {
        caller: { agent_id: 'disabled-agent', role: 'builder' },
      });
      const afterB = store.getTask('lw-21b').claim_expires_at;
      assert.equal(afterB, beforeB, 'sibling lease NOT renewed when the feature is disabled');
    } finally {
      delete process.env.KANBAN_HOLDER_WRITE_RENEWS_ALL;
    }
  });

  it('22. a new claim renews all other leases held by the same agent (applyClaim side effect)', async () => {
    await store.createTask({ id: 'lw-22a', title: 'Claim A', status: 'BACKLOG', round: 1 });
    await store.createTask({ id: 'lw-22b', title: 'Claim B', status: 'BACKLOG', round: 1 });
    // Claim A first.
    await store.claimTask('lw-22a', 'claim-agent', undefined, {});
    const beforeA = Date.parse(store.getTask('lw-22a').claim_expires_at);
    await new Promise((r) => setTimeout(r, 20));
    // Claim B — this should renew A as a side effect.
    await store.claimTask('lw-22b', 'claim-agent', undefined, {});
    const afterA = Date.parse(store.getTask('lw-22a').claim_expires_at);
    assert.ok(afterA > beforeA, 'lw-22a lease was renewed when the agent claimed lw-22b');
  });

  // --- leaseWindowFor + resolveLeaseMs unit checks ---

  it('23. leaseWindowFor returns the task claim_lease_ms when set', () => {
    assert.equal(store.leaseWindowFor({ claim_lease_ms: 300000 }), 300000);
  });

  it('24. leaseWindowFor falls back to getClaimTtlMs when claim_lease_ms is null', () => {
    process.env.KANBAN_CLAIM_TTL_MS = '420000';
    try {
      assert.equal(store.leaseWindowFor({ claim_lease_ms: null }), 420000);
    } finally {
      delete process.env.KANBAN_CLAIM_TTL_MS;
    }
  });

  it('25. getMinLeaseMs / getMaxLeaseMs read their env vars', () => {
    process.env.KANBAN_MIN_LEASE_MS = '5000';
    process.env.KANBAN_MAX_LEASE_MS = '999000';
    try {
      assert.equal(store.getMinLeaseMs(), 5000);
      assert.equal(store.getMaxLeaseMs(), 999000);
    } finally {
      delete process.env.KANBAN_MIN_LEASE_MS;
      delete process.env.KANBAN_MAX_LEASE_MS;
    }
  });
});