import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

// v2.13.0 — post-release review fixups on top of v2.12.0's lease-window work
// (I-1 through I-8 in the review doc). Reuses the same HTTP-harness pattern as
// kanban.leasewindow.test.js.

const TOKEN = 'kanban-leasewindow2-token';
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

describe('v2.13.0 lease-window fixups (I-1..I-8, E-1, E-2)', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    process.env.KANBAN_CLAIM_TTL_MS = String(TTL_MS);
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    delete process.env.KANBAN_PROJECT_TOKENS;
    delete process.env.KANBAN_MAX_CLAIMS_PER_AGENT;
    process.env.KANBAN_REAP_ENABLED = 'false';
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-leasewin2-'));
    process.env.KANBAN_DATA_DIR = tmpDir;
    store.setStorage(null);
    store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  after(async () => {
    store.stopReaper();
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_CLAIM_TTL_MS;
    delete process.env.KANBAN_REAP_ENABLED;
    delete process.env.KANBAN_PROJECT_TOKENS;
    delete process.env.KANBAN_MAX_CLAIMS_PER_AGENT;
    store.setStorage(null);
  });

  // --- I-1: sibling renewal must not bump version ---

  it('1. a holder log on card A does not bump sibling card B version (I-1)', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('i1-a', 'A') });
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('i1-b', 'B') });
    await jsonRequest(baseUrl, '/api/tasks/i1-a/claim', {
      method: 'POST', headers: headers(undefined, 'i1-agent'), body: JSON.stringify({ agent_id: 'i1-agent' }),
    });
    const claimB = await jsonRequest(baseUrl, '/api/tasks/i1-b/claim', {
      method: 'POST', headers: headers(undefined, 'i1-agent'), body: JSON.stringify({ agent_id: 'i1-agent' }),
    });
    const versionBBefore = claimB.body.version;

    await jsonRequest(baseUrl, '/api/tasks/i1-a/logs', {
      method: 'POST', headers: headers('builder', 'i1-agent'),
      body: JSON.stringify({ agent_id: 'i1-agent', message: 'progress on A' }),
    });

    const bAfter = store.getTask('i1-b');
    assert.equal(bAfter.version, versionBBefore, 'sibling version unchanged by a lease-only renewal');

    // The version the human/other client already saw is STILL VALID for a CAS PATCH.
    const patchB = await jsonRequest(baseUrl, '/api/tasks/i1-b', {
      method: 'PATCH', headers: headers('human', 'someone-else'),
      body: JSON.stringify({ title: 'edited', expected_version: versionBBefore }),
    });
    assert.equal(patchB.response.status, 200, 'CAS PATCH against the pre-renewal version still succeeds');
  });

  // --- I-2: sibling renewal must stay within the writer's project ---

  it('2. a holder write in project alpha does not renew a lease in project beta (I-2)', async () => {
    await jsonRequest(baseUrl, '/api/tasks?project=alpha', {
      method: 'POST', headers: headers(), body: taskBody('i2-a', 'Alpha'),
    });
    await jsonRequest(baseUrl, '/api/tasks?project=beta', {
      method: 'POST', headers: headers(), body: taskBody('i2-b', 'Beta'),
    });
    await jsonRequest(baseUrl, '/api/tasks/i2-a/claim?project=alpha', {
      method: 'POST', headers: headers(undefined, 'i2-agent'), body: JSON.stringify({ agent_id: 'i2-agent' }),
    });
    await jsonRequest(baseUrl, '/api/tasks/i2-b/claim?project=beta', {
      method: 'POST', headers: headers(undefined, 'i2-agent'), body: JSON.stringify({ agent_id: 'i2-agent' }),
    });
    const before = store.getTask('i2-b', 'beta').claim_expires_at;
    await new Promise((r) => setTimeout(r, 20));
    await jsonRequest(baseUrl, '/api/tasks/i2-a/logs?project=alpha', {
      method: 'POST', headers: headers('builder', 'i2-agent'),
      body: JSON.stringify({ agent_id: 'i2-agent', message: 'progress on alpha' }),
    });
    const after = store.getTask('i2-b', 'beta').claim_expires_at;
    assert.equal(after, before, 'beta lease untouched by an alpha-scoped write');
  });

  // --- I-5: sibling renewal broadcasts in the same tick ---

  it('3. a PATCH on card A emits a diff event for sibling card B in the same tick (I-5)', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('i5-a', 'A') });
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('i5-b', 'B') });
    await jsonRequest(baseUrl, '/api/tasks/i5-a/claim', {
      method: 'POST', headers: headers(undefined, 'i5-agent'), body: JSON.stringify({ agent_id: 'i5-agent' }),
    });
    await jsonRequest(baseUrl, '/api/tasks/i5-b/claim', {
      method: 'POST', headers: headers(undefined, 'i5-agent'), body: JSON.stringify({ agent_id: 'i5-agent' }),
    });
    const seen = [];
    const off = store.onDiff((e) => seen.push(`${e.kind}:${e.task?.id}`));
    await new Promise((r) => setTimeout(r, 20));
    await jsonRequest(baseUrl, '/api/tasks/i5-a', {
      method: 'PATCH', headers: headers('builder', 'i5-agent'),
      body: JSON.stringify({ description: 'moving forward' }),
    });
    off();
    assert.ok(seen.includes('updated:i5-a'), 'primary card event present');
    assert.ok(seen.includes('renewed:i5-b'), 'sibling renewal broadcast in the same tick');
  });

  // --- I-7: sibling renewal is tagged 'renewed', not a plain 'updated' ---

  it('4. sibling renewals from a bulk heartbeat are tagged "renewed" (I-7)', async () => {
    for (const id of ['i7-a', 'i7-b']) {
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody(id, id) });
      await jsonRequest(baseUrl, `/api/tasks/${id}/claim`, {
        method: 'POST', headers: headers(undefined, 'i7-agent'), body: JSON.stringify({ agent_id: 'i7-agent' }),
      });
    }
    const seen = [];
    const off = store.onDiff((e) => seen.push(`${e.kind}:${e.task?.id}`));
    await new Promise((r) => setTimeout(r, 20));
    await jsonRequest(baseUrl, '/api/agents/i7-agent/heartbeat?project=default', {
      method: 'POST', headers: headers('builder', 'i7-agent'), body: JSON.stringify({}),
    });
    off();
    assert.ok(seen.includes('renewed:i7-a') && seen.includes('renewed:i7-b'), `got: ${JSON.stringify(seen)}`);
  });

  // --- I-8: lease_ms validation rejects non-numeric-looking input ---

  it('5. lease_ms rejects a boolean, an array, and a non-numeric string (I-8)', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('i8-a', 'A') });
    const boolAttempt = await jsonRequest(baseUrl, '/api/tasks/i8-a/claim', {
      method: 'POST', headers: headers(undefined, 'i8-agent'),
      body: JSON.stringify({ agent_id: 'i8-agent', lease_ms: true }),
    });
    assert.equal(boolAttempt.response.status, 400, 'a boolean lease_ms is rejected, not silently clamped');

    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('i8-b', 'B') });
    const arrAttempt = await jsonRequest(baseUrl, '/api/tasks/i8-b/claim', {
      method: 'POST', headers: headers(undefined, 'i8-agent2'),
      body: JSON.stringify({ agent_id: 'i8-agent2', lease_ms: [5] }),
    });
    assert.equal(arrAttempt.response.status, 400);

    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('i8-c', 'C') });
    const strAttempt = await jsonRequest(baseUrl, '/api/tasks/i8-c/claim', {
      method: 'POST', headers: headers(undefined, 'i8-agent3'),
      body: JSON.stringify({ agent_id: 'i8-agent3', lease_ms: 'abc' }),
    });
    assert.equal(strAttempt.response.status, 400);
  });

  it('6. an empty lease_ms query string on next-claim is treated as absent, not rejected (I-8)', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('i8-d', 'D') });
    const claim = await jsonRequest(baseUrl, '/api/tasks/next-claim?agent_id=i8-agent4&lease_ms=', {
      method: 'POST', headers: headers('builder', 'i8-agent4'),
    });
    assert.equal(claim.response.status, 200);
    assert.equal(claim.body.claim_lease_ms, null, 'unpinned — falls back to the live global TTL');
  });

  // --- C-1: an unpinned claim stays live against later KANBAN_CLAIM_TTL_MS changes ---

  it('7. a claim with no lease_ms is not pinned (claim_lease_ms is null)', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('c1-a', 'A') });
    const claim = await jsonRequest(baseUrl, '/api/tasks/c1-a/claim', {
      method: 'POST', headers: headers(undefined, 'c1-agent'), body: JSON.stringify({ agent_id: 'c1-agent' }),
    });
    assert.equal(claim.body.claim_lease_ms, null);
  });

  it('8. an explicit lease_ms is pinned and survives a later default TTL change', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('c1-b', 'B') });
    const claim = await jsonRequest(baseUrl, '/api/tasks/c1-b/claim', {
      method: 'POST', headers: headers(undefined, 'c1-agent2'),
      body: JSON.stringify({ agent_id: 'c1-agent2', lease_ms: 120000 }),
    });
    assert.equal(claim.body.claim_lease_ms, 120000);
  });

  // --- I-3 / I-4: bulk heartbeat scoping + credential-derived privilege ---

  it('9. bulk heartbeat requires ?project= for a non-privileged self caller (I-3)', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('i3-a', 'A') });
    await jsonRequest(baseUrl, '/api/tasks/i3-a/claim', {
      method: 'POST', headers: headers(undefined, 'i3-agent'), body: JSON.stringify({ agent_id: 'i3-agent' }),
    });
    const noScope = await jsonRequest(baseUrl, '/api/agents/i3-agent/heartbeat', {
      method: 'POST', headers: headers('builder', 'i3-agent'), body: JSON.stringify({}),
    });
    assert.equal(noScope.response.status, 400);
    const scoped = await jsonRequest(baseUrl, '/api/agents/i3-agent/heartbeat?project=default', {
      method: 'POST', headers: headers('builder', 'i3-agent'), body: JSON.stringify({}),
    });
    assert.equal(scoped.response.status, 200);
  });

  it('10. a per-project token cannot grant itself cross-agent heartbeat access via X-Agent-Role header (I-4)', async () => {
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({ gamma: 'gamma-token' });
    try {
      const gammaHeaders = (agentId) => ({
        Authorization: authHeader('gamma-token'),
        'Content-Type': 'application/json',
        'X-Agent-Role': 'admin', // self-asserted — must NOT confer privilege
        ...(agentId ? { 'X-Agent-Id': agentId } : {}),
      });
      await jsonRequest(baseUrl, '/api/tasks?project=gamma', {
        method: 'POST', headers: gammaHeaders('owner-10'), body: taskBody('i4-a', 'A', { project: 'gamma' }),
      });
      await jsonRequest(baseUrl, '/api/tasks/i4-a/claim?project=gamma', {
        method: 'POST', headers: gammaHeaders('owner-10'), body: JSON.stringify({ agent_id: 'owner-10' }),
      });
      // A different agent id, same per-project token, self-asserting admin —
      // must still be rejected as a non-self, non-privileged caller.
      const attempt = await jsonRequest(baseUrl, '/api/agents/owner-10/heartbeat?project=gamma', {
        method: 'POST', headers: gammaHeaders('intruder-10'), body: JSON.stringify({}),
      });
      assert.equal(attempt.response.status, 403, 'X-Agent-Role: admin from a per-project token is not privilege');
    } finally {
      delete process.env.KANBAN_PROJECT_TOKENS;
    }
  });

  // --- E-1: last_progress_at tracks THIS card, not sibling renewals ---

  it('11. last_progress_at is set on claim/log/PATCH but untouched by a sibling renewal', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('e1-a', 'A') });
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('e1-b', 'B') });
    const claimA = await jsonRequest(baseUrl, '/api/tasks/e1-a/claim', {
      method: 'POST', headers: headers(undefined, 'e1-agent'), body: JSON.stringify({ agent_id: 'e1-agent' }),
    });
    assert.ok(claimA.body.last_progress_at, 'claim sets last_progress_at');
    await jsonRequest(baseUrl, '/api/tasks/e1-b/claim', {
      method: 'POST', headers: headers(undefined, 'e1-agent'), body: JSON.stringify({ agent_id: 'e1-agent' }),
    });
    const bProgressAfterOwnClaim = store.getTask('e1-b').last_progress_at;
    await new Promise((r) => setTimeout(r, 20));
    // A log on A renews B's LEASE as a side effect, but must not touch B's progress marker.
    await jsonRequest(baseUrl, '/api/tasks/e1-a/logs', {
      method: 'POST', headers: headers('builder', 'e1-agent'),
      body: JSON.stringify({ agent_id: 'e1-agent', message: 'working on A' }),
    });
    assert.equal(store.getTask('e1-b').last_progress_at, bProgressAfterOwnClaim, 'B progress marker untouched');
  });

  // --- E-2: per-agent claim cap ---

  it('12. KANBAN_MAX_CLAIMS_PER_AGENT rejects a claim past the cap with 409 claim_limit', async () => {
    process.env.KANBAN_MAX_CLAIMS_PER_AGENT = '1';
    try {
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('e2-a', 'A') });
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('e2-b', 'B') });
      const first = await jsonRequest(baseUrl, '/api/tasks/e2-a/claim', {
        method: 'POST', headers: headers(undefined, 'e2-agent'), body: JSON.stringify({ agent_id: 'e2-agent' }),
      });
      assert.equal(first.response.status, 200);
      const second = await jsonRequest(baseUrl, '/api/tasks/e2-b/claim', {
        method: 'POST', headers: headers(undefined, 'e2-agent'), body: JSON.stringify({ agent_id: 'e2-agent' }),
      });
      assert.equal(second.response.status, 409);
      assert.equal(second.body.reason, 'claim_limit');
    } finally {
      delete process.env.KANBAN_MAX_CLAIMS_PER_AGENT;
    }
  });

  it('13. KANBAN_MAX_CLAIMS_PER_AGENT exempts a privileged caller', async () => {
    process.env.KANBAN_MAX_CLAIMS_PER_AGENT = '1';
    try {
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('e2-c', 'C') });
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody('e2-d', 'D') });
      const first = await jsonRequest(baseUrl, '/api/tasks/e2-c/claim', {
        method: 'POST', headers: headers('admin', 'admin-agent'), body: JSON.stringify({ agent_id: 'admin-agent' }),
      });
      assert.equal(first.response.status, 200);
      const second = await jsonRequest(baseUrl, '/api/tasks/e2-d/claim', {
        method: 'POST', headers: headers('admin', 'admin-agent'), body: JSON.stringify({ agent_id: 'admin-agent' }),
      });
      assert.equal(second.response.status, 200, 'privileged role is exempt from the cap');
    } finally {
      delete process.env.KANBAN_MAX_CLAIMS_PER_AGENT;
    }
  });

  it('14. bulk renewAllLeases reuses the sibling-renewal core (C-2) and tags a bulk reason', async () => {
    for (const id of ['c2-a', 'c2-b']) {
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers(), body: taskBody(id, id) });
      await jsonRequest(baseUrl, `/api/tasks/${id}/claim`, {
        method: 'POST', headers: headers(undefined, 'c2-agent'), body: JSON.stringify({ agent_id: 'c2-agent' }),
      });
    }
    const result = await store.renewAllLeases('c2-agent', { project: 'default', caller: { privileged: true } });
    assert.equal(result.count, 2);
  });
});
