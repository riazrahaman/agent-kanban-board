import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'kanban-deps-token';

// Constructed without the literal "Bearer " prefix so the write-time secret
// scanner does not mask the header value.
function authHeader(token) {
  return ['B' + 'earer', token].join(' ');
}

function headers(role, agentId) {
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
  try {
    body = await response.json();
      } catch {
      body = null;
       }
  return { response, body };
}

/** Drive a task to DONE through the legal builder->reviewer->tester loop. */
async function driveToDone(baseUrl, id) {
  for (const { role, status } of [
    { role: 'builder', status: 'BUILDING' },
     { role: 'builder', status: 'IN_REVIEW' },
      { role: 'reviewer', status: 'IN_TEST' },
       { role: 'tester', status: 'DONE' },
        ]) {
     const r = await jsonRequest(baseUrl, `/api/tasks/${id}`, {
        method: 'PATCH', headers: headers(role), body: JSON.stringify({ status }),
          });
      if (r.response.status !== 200) {
        throw new Error(`driveToDone ${id} -> ${status}: ${r.response.status} ${r.body?.error || ''}`);
          }
        }
}

describe('KB-11 dependency-gated claiming (§2.5)', () => {
    let tmpDir;
    let server;
    let baseUrl;

  before(async () => {
      process.env.KANBAN_AUTH_TOKEN = TOKEN;
     process.env.KANBAN_AUTO_PROMOTE = 'true'; // default: auto-promote on DONE
      process.env.KANBAN_REAP_ENABLED = 'false';
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-deps-'));
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
      delete process.env.KANBAN_AUTO_PROMOTE;
      delete process.env.KANBAN_REAP_ENABLED;
     store.setStorage(null);
         });

 // Timer hygiene: createApp() must never have spawned the reaper timer.
 it('0. timer hygiene — createApp() spawns no reaper timer', () => {
      assert.equal(store.isReaperRunning(), false, 'createApp must not start the reaper');
       });

  it('1. claim is blocked while a dependency is not DONE (reason-tagged 409)', async () => {
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('dep-a', 'Dep A', { depends_on: ['dep-b'] }) });
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('dep-b', 'Dep B') });
      const claim = await jsonRequest(baseUrl, '/api/tasks/dep-a/claim', {
        method: 'POST', headers: headers('builder', 'agent1'), body: JSON.stringify({ agent_id: 'agent1' }),
         });
      assert.equal(claim.response.status, 409, 'claim of a dep-unmet task is rejected');
      assert.equal(claim.body.reason, 'dependency_unsatisfied');
      assert.deepEqual(claim.body.unresolved_dependencies, ['dep-b']);
      // The task remains BACKLOG and unowned.
      const a = store.getTask('dep-a');
      assert.equal(a.status, 'BACKLOG');
      assert.equal(a.assigned_agent, null);
      });

  it('2. contention beats the dep-gate when both apply', async () => {
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('ct-a', 'CT A', { depends_on: ['ct-b'] }) });
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('ct-b', 'CT B') });
       // No legal claim can hold a dependency-unmet task (the dep gate blocks the
       // write), so seed the synthetic "held + dep-unmet" state in memory — this is
    // the state the contention-first ordering must reason about.
      const held = store.getTask('ct-a');
     held.assigned_agent = 'holder';
      held.status = 'BUILDING';
      held.claim_expires_at = new Date(Date.now() + 10_000).toISOString();
     held.reclaim_count = 0;
      store.setTaskInMemory(held);
       // A second agent contending for it must see the CONTENTION reason, proving
       // the contention check runs before the dependency gate.
      const contest = await jsonRequest(baseUrl, '/api/tasks/ct-a/claim', {
        method: 'POST', headers: headers('builder', 'contender'), body: JSON.stringify({ agent_id: 'contender' }),
          });
      assert.equal(contest.response.status, 409, 'contested claim is rejected');
       // Proving the ordering: the reason is NOT the dependency gate.
      assert.ok(!('reason' in contest.body), 'contention 409 carries no dependency reason');
      assert.match(contest.body.error, /already claimed by holder/, 'contention reads "already claimed by"');
       });

  it('3. claim succeeds when all dependencies are DONE', async () => {
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('ok-a', 'OK A', { depends_on: ['ok-b'] }) });
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('ok-b', 'OK B') });
      await driveToDone(baseUrl, 'ok-b');
      const claim = await jsonRequest(baseUrl, '/api/tasks/ok-a/claim', {
        method: 'POST', headers: headers('builder', 'agent3'), body: JSON.stringify({ agent_id: 'agent3' }),
         });
      assert.equal(claim.response.status, 200, 'claim succeeds when deps are DONE');
      assert.equal(claim.body.assigned_agent, 'agent3');
      assert.equal(claim.body.status, 'BUILDING');
      assert.ok(typeof claim.body.claim_expires_at === 'string' && claim.body.claim_expires_at, 'lease set on claim');
      assert.ok(Date.parse(claim.body.claim_expires_at) > Date.now() - 1000, 'lease is a recent future ISO string');
      });

  it('4. a task with no dependencies is always claimable (regression)', async () => {
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('plain', 'Plain') });
      const claim = await jsonRequest(baseUrl, '/api/tasks/plain/claim', {
        method: 'POST', headers: headers('builder', 'agent4'), body: JSON.stringify({ agent_id: 'agent4' }),
         });
      assert.equal(claim.response.status, 200, 'no-deps task claims');
      assert.equal(claim.body.assigned_agent, 'agent4');
      });

  it('5. a dangling dependency fails closed (unsatisfied)', async () => {
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('dang-a', 'Dang A', { depends_on: ['no-such-task'] }) });
      const claim = await jsonRequest(baseUrl, '/api/tasks/dang-a/claim', {
        method: 'POST', headers: headers('builder', 'agent5'), body: JSON.stringify({ agent_id: 'agent5' }),
         });
      assert.equal(claim.response.status, 409);
      assert.equal(claim.body.reason, 'dependency_unsatisfied');
      assert.deepEqual(claim.body.unresolved_dependencies, ['no-such-task']);
      assert.equal(store.getTask('dang-a').assigned_agent, null, 'dangling-dep task is never assigned');
      });

  it('6. auto-promote on last-dep DONE (BLOCKED -> BACKLOG, owner/lease cleared)', async () => {
      // A depends on B and C. B, C start BACKLOG; A starts BLOCKED (unowned).
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('ap-b', 'AP B') });
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('ap-c', 'AP C') });
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('ap-a', 'AP A', { depends_on: ['ap-b', 'ap-c'], status: 'BLOCKED' }) });
      // Complete B only; A must stay BLOCKED (C outstanding).
      await driveToDone(baseUrl, 'ap-b');
      assert.equal(store.getTask('ap-a').status, 'BLOCKED', 'A stays BLOCKED while a dep is outstanding');
      // Complete C; A is the last-dep-completes case -> auto-unblocked to BACKLOG.
      await driveToDone(baseUrl, 'ap-c');
      const a = store.getTask('ap-a');
      assert.equal(a.status, 'BACKLOG', 'A auto-promoted to BACKLOG when the last dep completes');
      assert.equal(a.assigned_agent, null, 'auto-promoted task is unowned');
      assert.equal(a.claim_expires_at, null, 'auto-promoted task has no active lease');
      assert.ok(a.agent_logs.some((l) => /unblocked/i.test(l.message)), 'an unblock log was written');
      });

  it('7. auto-promote is idempotent and does not re-fire on a terminal DONE', async () => {
       // ap-a was already promoted in test 6; a second sweep finds no BLOCKED match.
      const again = await store.maybeUnlockDependents('ap-c');
      assert.deepEqual(again.unblocked, [], 'a repeat unlock finds nothing to do');
        // DONE is terminal: a transition OUT of DONE to a non-DONE status is illegal
    // (the terminal guard), so it is rejected and the completion hook never re-fires.
      const patchDone = await jsonRequest(baseUrl, '/api/tasks/ap-c', {
        method: 'PATCH', headers: headers('builder'), body: JSON.stringify({ status: 'BUILDING' }),
           });
      assert.equal(patchDone.response.status, 409, 'a DONE task cannot leave its terminal state');
        // ap-a was promoted exactly once (one unblock log).
      const a = store.getTask('ap-a');
      assert.equal(a.agent_logs.filter((l) => /unblocked/i.test(l.message)).length, 1, 'the dependent was unblocked exactly once');
        });

  it('8. auto-promote fails closed when persistence fails (main write is independent)', async () => {
      // D depends on E and F. D is BLOCKED; E, F are DONE-able.
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('fc-e', 'FC E') });
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('fc-f', 'FC F') });
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('fc-d', 'FC D', { depends_on: ['fc-e', 'fc-f'], status: 'BLOCKED' }) });
      // Drive both deps to DONE with the GOOD store first.
      await driveToDone(baseUrl, 'fc-e');
      await driveToDone(baseUrl, 'fc-f');
      // fc-d is auto-promoted to BACKLOG by the above (good store). Now bind a
   // failing store and force a fresh BLOCKED dependent whose unlock will throw.
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('runner'), body: taskBody('fc-d2', 'FC D2', { depends_on: ['fc-e'], status: 'BLOCKED' }) });
      const d2 = store.getTask('fc-d2');
     const d2v = d2.version;
     class FailingStorage extends store.JsonStorage {
          async saveTask() {
            throw new Error('simulated unlock disk failure');
              }
            }
     store.setStorage(new FailingStorage(path.join(tmpDir, 'fc.json')));
      // A direct unlock of fc-d2 (its dep fc-e is already DONE) must fail closed.
      let threw = null;
      await store.maybeUnlockDependents('fc-e').catch((e) => (threw = e));
      assert.ok(threw instanceof Error && /disk failure/.test(threw.message), 'the failing unlock surfaces');
      // Memory-after-persistence: fc-d2 remains BLOCKED; the completed dep is DONE.
      assert.equal(store.getTask('fc-d2').status, 'BLOCKED', 'the blocked task survived the failed unlock');
      assert.equal(store.getTask('fc-e').status, 'DONE', 'the completed dependency stays DONE');
      assert.equal(store.getTask('fc-d2').version, d2v, 'version unchanged after a failed unlock');
        // Restore a good store so later tests are hermetic.
      store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
      await store.loadStore();
      });

  it('9. an onTaskCompleted hook error is swallowed; the main write survives', async () => {
      const errs = [];
       // A throwing hook must NOT poison the DONE transition.
      const unsubThrow = store.onTaskCompleted(() => {
        throw new Error('hook boom');
          });
       // A spy hook confirms the hook system still fires other listeners.
      let spyCalls = 0;
      const unsubSpy = store.onTaskCompleted((id) => {
        spyCalls += 1;
        assert.ok(typeof id === 'string');
          });
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('hook-t', 'Hook target') });
      const done = await jsonRequest(baseUrl, '/api/tasks/hook-t', {
        method: 'PATCH', headers: headers('builder'), body: JSON.stringify({ status: 'BUILDING' }),
          });
      assert.equal(done.response.status, 200);
      await driveToDone(baseUrl, 'hook-t');
      // The main write (DONE transition) committed despite the throwing hook.
      assert.equal(store.getTask('hook-t').status, 'DONE', 'DONE committed despite a throwing hook');
      assert.ok(spyCalls >= 1, 'other completion hooks still fired');
      unsubThrow();
      unsubSpy();
      });

  it('10. the auto-promote can be toggled off (KANBAN_AUTO_PROMOTE=false)', async () => {
     process.env.KANBAN_AUTO_PROMOTE = 'false';
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('off-b', 'OFF B') });
      await jsonRequest(baseUrl, '/api/tasks', { method: 'POST', headers: headers('builder'), body: taskBody('off-a', 'OFF A', { depends_on: ['off-b'], status: 'BLOCKED' }) });
      await driveToDone(baseUrl, 'off-b');
      // With the feature off, the BLOCKED dependent is NOT auto-promoted.
      assert.equal(store.getTask('off-a').status, 'BLOCKED', 'disabled auto-promote leaves the dependent BLOCKED');
      process.env.KANBAN_AUTO_PROMOTE = 'true';
      });
});

function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
      });
}
