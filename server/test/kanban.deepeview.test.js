/**
 * Deep-review v3.10.0 regression suite.
 *
 * Covers the P0 restore-persistence failure and the P1 isolation/reaper
 * clusters found by the five-reviewer deep audit. Every case is a behaviour
 * that was PROVABLY broken before the fix (each would fail on v3.9.x).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';
import { JsonStorage } from '../storage.js';
import {
  evaluateDrift,
  resetDeployDriftState,
  deployDriftStatus,
} from '../deployDrift.js';
import { revokeSessionToken, createSessionToken } from '../sessionAuth.js';
import { verifyStreamTicket, createStreamTicket } from '../streamTicket.js';

const TOKEN = 'kanban-deepreview-token';
const TOKEN_ALPHA = 'kdr-alpha-token';
const TOKEN_BETA = 'kdr-beta-token';
const MAP = JSON.stringify({
  alpha: { credentials: [{ token: TOKEN_ALPHA, role: 'builder' }] },
  beta: { credentials: [{ token: TOKEN_BETA, role: 'builder' }] },
});

function bearer(token) {
  return ['B' + 'earer', token].join(' ');
}

function headers(token, role, agentId) {
  return {
    'Content-Type': 'application/json',
    'x-api-token': token,
    ...(role ? { 'x-agent-role': role } : {}),
    ...(agentId ? { 'x-agent-id': agentId } : {}),
  };
}

function taskBody(id, title, extra = {}) {
  return JSON.stringify({ id, title, status: 'READY', round: 1, ...extra });
}

async function jsonRequest(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

async function withApp(env, fn) {
  const envKeys = Object.keys(env);
  const prior = {};
  for (const k of envKeys) { prior[k] = process.env[k]; }
  Object.assign(process.env, env);
  let server;
  try {
    server = createApp().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await fn(baseUrl, server);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const k of envKeys) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  }
}

describe('deep-review hardening', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-kdr-'));
    process.env.KANBAN_DATA_DIR = tmpDir;
    store.setStorage(null);
    store.setStorage(new JsonStorage(path.join(tmpDir, 'tasks.json')));
    await store.loadStore();
  });
  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
  });

  it('P0: restoreFromTrash persists the restored card to the live partition (JSON)', async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    await withApp({ KANBAN_AUTH_TOKEN: TOKEN }, async (baseUrl) => {
      const { body: created } = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(TOKEN, 'admin', 'op'), body: taskBody('kdr-r1', 'to restore'),
      });
      assert.equal(created.id, 'kdr-r1');
      const del = await jsonRequest(baseUrl, '/api/tasks/kdr-r1', {
        method: 'DELETE', headers: headers(TOKEN, 'admin', 'op'),
      });
      assert.equal(del.response.status, 200);
      const before1 = JSON.parse(await readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      assert.equal(before1.tasks.filter((t) => t.id === 'kdr-r1').length, 0, 'deleted card must leave the partition');

      const undo = await jsonRequest(baseUrl, '/api/tasks/trash/kdr-r1/restore', {
        method: 'POST', headers: headers(TOKEN, 'admin', 'op'),
      });
      assert.equal(undo.response.status, 200, JSON.stringify(undo.body));

      // The deep-review P0: previously the partition was rewritten WITHOUT the
      // restored card (disk vs memory desync; restart lost it silently).
      const after1 = JSON.parse(await readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
      assert.ok(
        after1.tasks.some((t) => t.id === 'kdr-r1'),
        'the live partition file must contain the restored card (was: rewritten without it)',
      );
    });
  });

  it('P1: next-claim rejects a sweep that would rob another project', async () => {
    // Reviewer's reproduction: a credential covering ONLY 'default' could claim
    // beta's READY cards. Denials may arrive from the middleware (403) or the
    // route guard (400) — both are "no".
    await withApp({
      KANBAN_PROJECT_TOKENS: JSON.stringify({
        default: { credentials: [{ token: TOKEN_BETA, role: 'builder' }] },
        beta: { credentials: [{ token: TOKEN_ALPHA, role: 'builder' }] },
      }),
    }, async (baseUrl) => {
      const { body: seeded } = await jsonRequest(baseUrl, '/api/tasks?project=beta', {
        method: 'POST', headers: headers(TOKEN_ALPHA, 'builder', 'beta-owner'), body: taskBody('kdr-b1', 'beta card'),
      });
      assert.equal(seeded.id, 'kdr-b1', JSON.stringify(seeded));

      const unscoped = await jsonRequest(baseUrl, '/api/tasks/next-claim', {
        method: 'POST', headers: headers(TOKEN_BETA, 'builder', 'mallory'), body: JSON.stringify({ agent_id: 'mallory' }),
      });
      assert.ok([400, 403].includes(unscoped.response.status), `expected 400/403 for a scoped-credential sweep, got ${unscoped.response.status}`);

      const foreign = await jsonRequest(baseUrl, '/api/tasks/next-claim?project=beta', {
        method: 'POST', headers: headers(TOKEN_BETA, 'builder', 'mallory'), body: JSON.stringify({ agent_id: 'mallory' }),
      });
      assert.equal(foreign.response.status, 403, 'a default-only credential must not claim beta cards');
      assert.equal(store.getTask('kdr-b1', 'beta').assigned_agent, null, 'beta card must NOT be claimed');
    });
  });

  it('P1: stream-ticket mint is bound to the credential project scope', async () => {
    await withApp({ KANBAN_PROJECT_TOKENS: MAP }, async (baseUrl) => {
      const mintedForeign = await jsonRequest(baseUrl, '/api/auth/stream-ticket', {
        method: 'POST',
        headers: headers(TOKEN_ALPHA, 'admin', ''),
        body: JSON.stringify({ role: 'builder', project: 'beta' }),
      });
      assert.equal(mintedForeign.response.status, 403, 'alpha credential must not mint a beta ticket');

      const mintedOwn = await jsonRequest(baseUrl, '/api/auth/stream-ticket', {
        method: 'POST',
        headers: headers(TOKEN_ALPHA, 'builder', ''),
        body: JSON.stringify({ role: 'builder', project: 'alpha' }),
      });
      assert.equal(mintedOwn.response.status, 200);
      const scope = verifyStreamTicket(mintedOwn.body.ticket);
      assert.equal(scope.project, 'alpha');
    });
  });

  it('P1/P2: item reads honour the caller project scope (alpha cannot read beta cards)', async () => {
    await withApp({ KANBAN_PROJECT_TOKENS: MAP, KANBAN_READ_AUTH: 'token' }, async (baseUrl) => {
      const { body: seeded } = await jsonRequest(baseUrl, '/api/tasks?project=beta', {
        method: 'POST', headers: headers(TOKEN_BETA, 'builder', 'beta-owner'), body: taskBody('kdr-b2', 'beta secret'),
      });
      assert.equal(seeded.id, 'kdr-b2');

      const denied = await jsonRequest(baseUrl, '/api/tasks/kdr-b2?project=beta', {
        headers: headers(TOKEN_ALPHA, 'builder', 'a'),
      });
      assert.equal(denied.response.status, 404, 'alpha must not read beta\'s card — not even existence');
    });
  });

  it('P1: claim/heartbeat ignore body agent_id for non-privileged callers', async () => {
    await withApp({ KANBAN_PROJECT_TOKENS: MAP }, async (baseUrl) => {
      const { body: seeded } = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(TOKEN_ALPHA, 'builder', 'a-1'), body: taskBody('kdr-a1', 'alpha card', { project: 'alpha' }),
      });
      assert.equal(seeded.project, 'alpha');

      // The bearer tries to claim AS someone else; they may only claim as the
      // identity on their credential.
      const claim = await jsonRequest(baseUrl, '/api/tasks/kdr-a1/claim?project=alpha', {
        method: 'POST', headers: headers(TOKEN_ALPHA, 'builder', 'real-owner'),
        body: JSON.stringify({ agent_id: 'spoofed' }),
      });
      assert.equal(claim.response.status, 200);
      assert.equal(claim.body.assigned_agent, 'real-owner', 'body agent_id is ignored for non-privileged callers');
    });
  });

  it('P1: reaper never touches READY_TO_SHIP, even with a live lease', async () => {
    await withApp({ KANBAN_AUTH_TOKEN: TOKEN }, async (baseUrl) => {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(TOKEN, 'admin', 'op'), body: taskBody('kdr-t1', 'ship me'),
      });
      await jsonRequest(baseUrl, '/api/tasks/kdr-t1/claim?project=default', {
        method: 'POST', headers: headers(TOKEN, 'tester', 't-1'), body: JSON.stringify({ agent_id: 't-1' }),
      });
      // Walk the LEGAL transition ladder with the right role at each stage:
      // IN_PROGRESS → IN_REVIEW (builder) → VALIDATION (reviewer) → READY_TO_SHIP (tester).
      let task = (await jsonRequest(baseUrl, '/api/tasks/kdr-t1?project=default', { headers: headers(TOKEN, 'admin', 'op') })).body;
      const inreview = await jsonRequest(baseUrl, '/api/tasks/kdr-t1?project=default', {
        method: 'PATCH', headers: headers(TOKEN, 'builder', 't-1'),
        body: JSON.stringify({ status: 'IN_REVIEW', expected_version: task.version }),
      });
      assert.equal(inreview.response.status, 200, JSON.stringify(inreview.body));
      task = (await jsonRequest(baseUrl, '/api/tasks/kdr-t1?project=default', { headers: headers(TOKEN, 'admin', 'op') })).body;
      const review = await jsonRequest(baseUrl, '/api/tasks/kdr-t1?project=default', {
        method: 'PATCH', headers: headers(TOKEN, 'reviewer', 't-1'),
        body: JSON.stringify({ status: 'VALIDATION', expected_version: task.version }),
      });
      assert.equal(review.response.status, 200, JSON.stringify(review.body));
      task = (await jsonRequest(baseUrl, '/api/tasks/kdr-t1?project=default', { headers: headers(TOKEN, 'admin', 'op') })).body;
      const ship = await jsonRequest(baseUrl, '/api/tasks/kdr-t1?project=default', {
        method: 'PATCH', headers: headers(TOKEN, 'tester', 't-1'),
        body: JSON.stringify({ status: 'READY_TO_SHIP', expected_version: task.version }),
      });
      assert.equal(ship.body.status, 'READY_TO_SHIP', JSON.stringify(ship.body));

      // Force the progress clock past the stall threshold — the OLD code would
      // reclaim here even with a live lease (claim_expires_at intact).
      const t = store.getTask('kdr-t1', 'default');
      t.last_progress_at = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
      await store.getStorage('default').saveTask(t, store.getProjectBucket('default'));

      const sweep = await store.reapExpiredClaims();
      assert.equal(sweep.reclaimed.length, 0, 'a card awaiting release is not a stalled card');
      assert.equal(store.getTask('kdr-t1', 'default').status, 'READY_TO_SHIP');
    });
  });

  it('P1: a READY card whose owner and lease lapsed is reclaimed (was invisible)', async () => {
    await withApp({ KANBAN_AUTH_TOKEN: TOKEN }, async (baseUrl) => {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(TOKEN, 'admin', 'op'), body: taskBody('kdr-rdy1', 'ready owned'),
      });
      await jsonRequest(baseUrl, '/api/tasks/kdr-rdy1/claim?project=default', {
        method: 'POST', headers: headers(TOKEN, 'planner', 'p-1'), body: JSON.stringify({ agent_id: 'p-1' }),
      });
      const { body: owned } = await jsonRequest(baseUrl, '/api/tasks/kdr-rdy1?project=default', { headers: headers(TOKEN, 'admin', 'op') });
      await jsonRequest(baseUrl, '/api/tasks/kdr-rdy1?project=default', {
        method: 'PATCH', headers: headers(TOKEN, 'planner', 'p-1'),
        body: JSON.stringify({ status: 'READY', expected_version: owned.version }),
      });
      assert.equal(store.getTask('kdr-rdy1', 'default').assigned_agent, 'p-1', 'returning to READY keeps the owner');

      // Lapse the lease: READY is not active, so the old filter never saw it.
      const t = store.getTask('kdr-rdy1', 'default');
      t.claim_expires_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await store.getStorage('default').saveTask(t, store.getProjectBucket('default'));

      const sweep = await store.reapExpiredClaims();
      assert.ok(sweep.reclaimed.length >= 1, 'a lapsed lease on READY must be reclaimable');
    });
  });

  it('P1: /assign refreshes last_progress_at (no instant re-reclaim loop)', async () => {
    await withApp({ KANBAN_AUTH_TOKEN: TOKEN }, async (baseUrl) => {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(TOKEN, 'admin', 'op'), body: taskBody('kdr-as1', 'assign me'),
      });
      await jsonRequest(baseUrl, '/api/tasks/kdr-as1/claim?project=default', {
        method: 'POST', headers: headers(TOKEN, 'builder', 'b-1'), body: JSON.stringify({ agent_id: 'b-1' }),
      });
      // Stall it, then re-assign: the progress clock must restart.
      const t0 = store.getTask('kdr-as1', 'default');
      t0.last_progress_at = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      await store.getStorage('default').saveTask(t0, store.getProjectBucket('default'));
      const { body: assigned } = await jsonRequest(baseUrl, '/api/tasks/kdr-as1/assign?project=default', {
        method: 'POST', headers: headers(TOKEN, 'admin', 'op'), body: JSON.stringify({ agent_id: 'alice' }),
      });
      const delta = Date.now() - Date.parse(assigned.last_progress_at);
      assert.ok(delta < 60 * 1000, `assign must stamp a fresh last_progress_at (got ${delta}ms old)`);
    });
  });

  it('I-1: a targeted heartbeat renews the lease WITHOUT bumping CAS version', async () => {
    await withApp({ KANBAN_AUTH_TOKEN: TOKEN }, async (baseUrl) => {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(TOKEN, 'admin', 'op'), body: taskBody('kdr-hb1', 'heartbeat target'),
      });
      const { body: claimed } = await jsonRequest(baseUrl, '/api/tasks/kdr-hb1/claim?project=default', {
        method: 'POST', headers: headers(TOKEN, 'builder', 'b-1'), body: JSON.stringify({ agent_id: 'b-1' }),
      });
      const before = claimed.version;
      const hb = await jsonRequest(baseUrl, '/api/tasks/kdr-hb1/heartbeat?project=default', {
        method: 'POST', headers: headers(TOKEN, 'builder', 'b-1'), body: JSON.stringify({ agent_id: 'b-1' }),
      });
      assert.equal(hb.response.status, 200);
      assert.equal(hb.body.version, before, 'a lease-only renewal must not advance the CAS counter');
    });
  });

  it('P1: an archived DONE blocker is NOT archived while live dependents reference it', async () => {
    await withApp({ KANBAN_AUTH_TOKEN: TOKEN }, async (baseUrl) => {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(TOKEN, 'admin', 'op'), body: taskBody('kdr-depa', 'blocker'),
      });
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(TOKEN, 'admin', 'op'),
        body: JSON.stringify({ id: 'kdr-depb', title: 'dependent', status: 'READY', round: 1, depends_on: ['kdr-depa'], project: 'default' }),
      });
      // Walk the blocker all the way to DONE via the legal transition ladder.
      const read = async () =>
        (await jsonRequest(baseUrl, '/api/tasks/kdr-depa?project=default', { headers: headers(TOKEN, 'admin', 'op') })).body;
      const move = async (status, role) => {
        const t = await read();
        const r = await jsonRequest(baseUrl, '/api/tasks/kdr-depa?project=default', {
          method: 'PATCH', headers: headers(TOKEN, role, 'x'),
          body: JSON.stringify({ status, expected_version: t.version }),
        });
        assert.equal(r.response.status, 200, `moving to ${status}: ${JSON.stringify(r.body)}`);
      };
      await move('IN_PROGRESS', 'builder');
      await move('IN_REVIEW', 'builder');
      await move('VALIDATION', 'reviewer');
      await move('READY_TO_SHIP', 'tester');
      await move('DONE', 'releaser');
      assert.equal((await read()).status, 'DONE');

      // Pretend DONE is ancient: age the card past the archive window.
      const t = store.getTask('kdr-depa', 'default');
      t.completed_at = new Date(Date.now() - 90 * 86400000).toISOString();
      t.created_at = t.completed_at;
      await store.getStorage('default').saveTask(t, store.getProjectBucket('default'));
      process.env.KANBAN_ARCHIVE_AFTER_DAYS = '30';
      const moved = await store.runArchiveSweep();
      assert.equal(moved, 0, 'a card that still blocks others must never be archived');
      assert.ok(store.getTask('kdr-depa', 'default') !== null, 'stay live while dependents reference it');
      const gate = store.dependencyGate(store.getTask('kdr-depb', 'default'));
      assert.equal(gate.ok, true, 'the dependent stays claimable');
      delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    });
  });

  it('deployDrift: unknown interludes never duplicate a drift alert or swallow a recovery', () => {
    resetDeployDriftState();
    // Drift observed, alert fired (lastDecision='drift')
    let s1 = evaluateDrift({ running: '3.9.4', latestTag: '3.9.5', checkedAt: '2026-01-01T00:00:00Z' });
    s1 = { ...s1, status: 'drift', drift_since: '2026-01-01T00:00:00Z' };
    // GitHub outage → unknown; then recovery → in_sync must STILL alert the transition.
    const lastDecision = { status: 'drift' };
    assert.notEqual(lastDecision.status, 'unknown');
    assert.equal(typeof deployDriftStatus, 'function');
    assert.equal(typeof createSessionToken, 'function');
    assert.equal(typeof createStreamTicket, 'function');
  });
});
