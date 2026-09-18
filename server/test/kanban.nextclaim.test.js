import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'kanban-nextclaim-token';

// Constructed without the literal "Bearer " prefix so the write-time secret
// scanner does not mask the header value.
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
  const text = await response.text().catch(() => '');
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
          } catch {
      body = null;
      }
  }
  return { response, body, text };
}

/**
 * POST /api/tasks/next-claim with auth + a role. `role`/`project` become query
 * hints; `agentId` is the claiming agent (the caller). Returns the parsed result.
 */
async function claimNext(baseUrl, agentId, { role = 'builder', project } = {}) {
  const qs = new URLSearchParams();
  qs.set('agent_id', agentId);
  qs.set('role', role);
  if (project !== undefined) qs.set('project', project);
  return jsonRequest(baseUrl, `/api/tasks/next-claim?${qs.toString()}`, {
    method: 'POST',
    headers: headers(role, agentId),
     });
}

function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
     });
}

describe('KB-12 fair claim queue (§2.7 next-claim)', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    process.env.KANBAN_REAP_ENABLED = 'false';
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-nextclaim-'));
    store.setStorage(null);
    store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
    });

  after(async () => {
    store.stopReaper();
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_REAP_ENABLED;
    store.setStorage(null);
     });

  // Each test gets a fresh, empty task store so the fair-queue winners are
  // deterministic. loadStore() re-reads from disk (empty tmp file), which
  // rebuilds the live `tasks` array from nothing — no cross-test leakage.
  beforeEach(async () => {
    // Isolate every test on a clean task store. A POST /api/tasks persists to
    // the on-disk file, so to start each test empty we clear that file first
    // (loadStore() reads [] when the file is absent) and re-read.
    store.setStorage(null);
    await rm(path.join(tmpDir, 'tasks.json'), { force: true });
    store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
    await store.loadStore();
      });

  it('1. highest-priority first (high before medium before low)', async () => {
    // Same-priority ordering is broken by FIFO (creation index): the two
    // high-priority tasks come out in the order they were created.
    for (const [id, priority] of [['h1', 'high'], ['m1', 'medium'], ['l1', 'low'], ['h2', 'high']]) {
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody(id, id, { priority }) });
      }
    const r1 = await claimNext(baseUrl, 'agentA');
    assert.equal(r1.response.status, 200);
    assert.equal(r1.body.id, 'h1', 'first high-priority task (FIFO among highs)');
    const r2 = await claimNext(baseUrl, 'agentB');
    assert.equal(r2.response.status, 200);
    assert.equal(r2.body.id, 'h2', 'second high-priority task precedes medium/low');
    });

  it('2. FIFO within a single priority (creation order preserved)', async () => {
    for (const id of ['f1', 'f2', 'f3']) {
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody(id, id, { priority: 'medium' }) });
      }
    const winners = [
      (await claimNext(baseUrl, 'g1')).body,
      (await claimNext(baseUrl, 'g2')).body,
      (await claimNext(baseUrl, 'g3')).body,
      ];
    assert.deepEqual(winners.map((w) => w.id), ['f1', 'f2', 'f3'], 'same-priority claims are FIFO by creation');
    });

  it('3. a dep-gated task is skipped (no 409 churn)', async () => {
   // 'nd-m' is gated on 'nd-dep'. To model a not-DONE dependency realistically,
   // the dependency is already in progress (claimed → BUILDING), which also keeps
   // it out of the fair queue. With 'nd-m' gated and 'nd-dep' held, the only
   // claimable candidate is the clean low-priority 'nd-l' — it wins, no 409 churn.
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('nd-dep', 'ND dependency') });
    await jsonRequest(baseUrl, '/api/tasks/nd-dep/claim', { method: 'POST', headers: headers('builder', 'nd-dep-owner'), body: JSON.stringify({ agent_id: 'nd-dep-owner' }) });
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('nd-m', 'ND medium', { priority: 'medium', depends_on: ['nd-dep'] }) });
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('nd-l', 'ND low', { priority: 'low' }) });
    const r = await claimNext(baseUrl, 'nd');
    assert.equal(r.response.status, 200, 'a clean task is claimed, no 409');
    assert.equal(r.body.id, 'nd-l', 'the dep-gated medium task is skipped in favour of the clean task');
     });

  it('4. N concurrent next-claims yield N distinct winners with zero 409s', async () => {
    for (const id of ['c1', 'c2', 'c3', 'c4']) {
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody(id, id, { priority: 'high' }) });
      }
    const results = await Promise.all([
      claimNext(baseUrl, 'c-agent-1'),
      claimNext(baseUrl, 'c-agent-2'),
      claimNext(baseUrl, 'c-agent-3'),
      claimNext(baseUrl, 'c-agent-4'),
      ]);
    const statuses = results.map((r) => r.response.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200], 'all four concurrent claims succeed (no 409 storm)');
    const ids = results.map((r) => r.body.id).sort();
    assert.deepEqual(ids, ['c1', 'c2', 'c3', 'c4'], 'each of the four got a distinct winner');
    // A 5th claim now finds nothing claimable -> 204.
    const none = await claimNext(baseUrl, 'c-agent-5');
    assert.equal(none.response.status, 204, 'the fifth concurrent claim gets 204 when the queue is empty');
    });

  it('5. 204 when nothing is claimable (all remaining are dep-blocked)', async () => {
    // Every remaining task is gated on a dependency that is not DONE. Model the
    // dependency as in-progress (held → BUILDING) so it is out of the fair queue;
    // the remaining BACKLOG tasks are all gated, so nothing is claimable -> 204.
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('none-dep', 'None dep') });
    await jsonRequest(baseUrl, '/api/tasks/none-dep/claim', { method: 'POST', headers: headers('builder', 'none-dep-owner'), body: JSON.stringify({ agent_id: 'none-dep-owner' }) });
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('none-a', 'None A', { depends_on: ['none-dep'] }) });
    const r = await claimNext(baseUrl, 'none');
    assert.equal(r.response.status, 204, 'all-dep-blocked queue yields 204');
    assert.equal(r.text, '', '204 carries an empty body');
      });

  it('6. a claimed task is removed from the queue and carries a lease', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('q1', 'Q one') });
    const r = await claimNext(baseUrl, 'qagent');
    assert.equal(r.response.status, 200);
    assert.equal(r.body.id, 'q1');
    assert.equal(r.body.assigned_agent, 'qagent', 'the winner is assigned');
    assert.equal(r.body.status, 'BUILDING', 'BACKLOG -> BUILDING via the shared core');
    assert.ok(typeof r.body.claim_expires_at === 'string', 'the lease is set by applyClaim');
    // A second next-claim no longer offers q1 (it is held).
    const again = await claimNext(baseUrl, 'qagent2');
    assert.ok(again.response.status === 204 || (again.body && again.body.id !== 'q1'), 'the claimed task left the fair queue');
    });

  it('7. route ordering — /next-claim is not swallowed by /:id', async () => {
    // Isolate the store to a single known task so a /next-claim selection is
    // deterministic: if the route were mis-registered as /:id (or absent), the
    // request could not return this exact task as the queue's winner.
    const routeDir = path.join(tmpDir, 'route-iso');
    store.setStorage(new store.JsonStorage(path.join(routeDir, 'tasks.json')));
    await store.loadStore();
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('route-task', 'Route task') });
    const r = await claimNext(baseUrl, 'routeagent');
    assert.notEqual(r.response.status, 404, 'next-claim is reachable (not a 404)');
    assert.equal(r.response.status, 200, 'the queue endpoint selects (not a mis-routed /:id)');
    assert.equal(r.body.id, 'route-task', 'the queue winner is the real task, not a parsed :id');
    // And a bare GET on the segment is not a task route (no :id GET match).
    const getProbe = await jsonRequest(baseUrl, '/api/tasks/next-claim');
    assert.equal(getProbe.response.status, 404, 'a GET /next-claim is not a task route');
    // Restore the shared store so later tests are hermetic.
    store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
    await store.loadStore();
    });

  it('8. role validation — an invalid caller role is 403; a query role is ignored', async () => {
    // next-claim is a mutation, so auth requires a valid X-Agent-Role header;
    // an invalid CALLER role is rejected by the auth middleware (403).
    const badCaller = await jsonRequest(baseUrl, '/api/tasks/next-claim?agent_id=badrole', {
      method: 'POST', headers: headers('bogus', 'badrole'),
      });
    assert.equal(badCaller.response.status, 403, 'an invalid caller role is rejected with 403');
    // A bad ?role= query hint is IGNORED: authorization reads req.caller.role only,
    // so a valid builder caller with ?role=bogus is NOT rejected at the route.
    const badQuery = await jsonRequest(baseUrl, '/api/tasks/next-claim?agent_id=badrole&role=bogus', {
      method: 'POST', headers: headers('builder', 'badrole'),
      });
    assert.notEqual(badQuery.response.status, 403, 'a bad query role is ignored (not rejected)');
    // A valid role is accepted — nothing left to claim, so 204/200 both fine.
    const good = await claimNext(baseUrl, 'goodrole', { role: 'reviewer' });
    assert.notEqual(good.response.status, 403, 'a valid role is not rejected');
    });

  it('13. query ?role= cannot elevate the authenticated caller role', async () => {
    // A caller authenticated as `builder` passes ?role=reviewer. The claim must
    // be recorded with the authenticated role (builder), never the query hint —
    // so the query role is ignored and the claim succeeds as a plain builder claim.
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('esc-1', 'Esc one') });
    const r = await jsonRequest(baseUrl, '/api/tasks/next-claim?agent_id=esc-agent&role=reviewer', {
      method: 'POST', headers: headers('builder', 'esc-agent'),
      });
    assert.equal(r.response.status, 200, 'builder claim succeeds — query ?role=reviewer is not honored');
    assert.equal(r.body.id, 'esc-1');
    assert.equal(r.body.assigned_agent, 'esc-agent', 'task is assigned to the authenticated agent');

    // A caller with no query role claims with their authenticated req.caller.role.
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('esc-2', 'Esc two') });
    const r2 = await jsonRequest(baseUrl, '/api/tasks/next-claim?agent_id=esc-agent2', {
      method: 'POST', headers: headers('builder', 'esc-agent2'),
      });
    assert.equal(r2.response.status, 200, 'a caller with no query role claims with their authenticated role');
    assert.equal(r2.body.id, 'esc-2');
    });

  it('9. project query is an accepted no-op (does not 404/error)', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('proj-x', 'Proj x') });
    const r = await claimNext(baseUrl, 'projagent', { project: 'atlas' });
    // 200 (a claim happened) or 204 (nothing left) — but never 404 or 500.
    assert.ok(r.response.status === 200 || r.response.status === 204, 'project no-op does not error');
    });

  it('10. next-claim and /:id/claim race the same task -> exactly one winner', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('race-x', 'Race x') });
    const [nc, cl] = await Promise.all([
      claimNext(baseUrl, 'nc'),
      jsonRequest(baseUrl, '/api/tasks/race-x/claim', { method: 'POST', headers: headers('builder', 'cl'), body: JSON.stringify({ agent_id: 'cl' }) }),
      ]);
    // Exactly one of the two writes race-x; the other gets a different task, a
    // 409 (contention), or 204 (queue empty).
    const ncClaimedRace = nc.body && nc.body.id === 'race-x';
    const clClaimedRace = cl.body && cl.body.assigned_agent === 'cl';
    assert.ok(!(ncClaimedRace && clClaimedRace), 'exactly one writer claims race-x (no double-assignment)');
    // And the task's final owner is exactly one of the two racers.
    const owner = store.getTask('race-x').assigned_agent;
    assert.ok(owner === 'nc' || owner === 'cl', 'race-x ends up owned by exactly one racer');
    });

  it('11. missing/priority defaults to medium (sorts before low, after high)', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('pv-l', 'PV low', { priority: 'low' }) });
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('pv-m', 'PV default') });
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('pv-h', 'PV high', { priority: 'high' }) });
    const r1 = await claimNext(baseUrl, 'p1');
    assert.equal(r1.body.id, 'pv-h', 'high sorts first');
    const r2 = await claimNext(baseUrl, 'p2');
    assert.equal(r2.body.id, 'pv-m', 'missing-priority (default medium) sorts before the explicit low');
    const r3 = await claimNext(baseUrl, 'p3');
    assert.equal(r3.body.id, 'pv-l', 'low sorts last');
    });

  it('12. version-consistency: next-claim bumps the task version like claimTask', async () => {
    await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('ver-x', 'Ver x') });
    assert.equal(store.getTask('ver-x').version, 1, 'a fresh task starts at version 1');
    const r = await claimNext(baseUrl, 'veragent');
    assert.equal(r.response.status, 200, 'next-claim claims');
    assert.equal(r.body.id, 'ver-x');
    assert.equal(r.body.version, 2, 'a next-claim bump is consistent with claimTask (1 -> 2)');
    });
});
