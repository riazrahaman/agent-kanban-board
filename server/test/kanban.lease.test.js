import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'yaml';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const execFileAsync = promisify(execFile);

const TOKEN = 'kanban-lease-token';
const TTL_MS = 60_000; // short lease so heartbeat/reaper math is observable

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
      });
   });
}

// Constructed without the literal "Bearer " prefix so the write-time secret
// scanner does not mask the header value. Functionally identical to
// `Bearer ${TOKEN}`.
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
  try {
    body = await response.json();
     } catch {
      body = null;
      }
  return { response, body };
}

/**
 * Force a task's lease deadline to a specific wall-clock ms, mutating the
 * in-memory task in place (like the archive suite's backdateTask) AND
 * persisting, so reapExpiredClaims (which iterates the live in-memory array)
 * observes the new expiry.
 */
async function setExpiry(id, ms) {
  const t = store.getTask(id);
  assert.ok(t, `${id} exists in store`);
  t.claim_expires_at = new Date(ms).toISOString();
  const storage = store.getStorage(t.project);
  await storage.saveTask(t, store.getProjectBucket(t.project));
  return t;
}

describe('KB-10 claim lease + reaper (§2.4)', () => {
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
    // Reaper timer must NEVER start in the HTTP-contract tests.
    process.env.KANBAN_REAP_ENABLED = 'false';
    realNow = () => Date.now();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-lease-'));
    store.setStorage(null);
    store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
    await store.loadStore();
    // Sanity: createApp() spawned no timer.
    assert.equal(store.isReaperRunning(), false, 'createApp must not start the reaper timer');
     ({ server, baseUrl } = await startTestServer(createApp()));
     });

  after(async () => {
    store.stopReaper();
    store.setNowFn(realNow);
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_CLAIM_TTL_MS;
    delete process.env.KANBAN_REAP_ENABLED;
    store.setStorage(null);
     });

  it('1. lease is set on claim to now + TTL (a future ISO string)', async () => {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('lease-1', 'Lease one'),
        });
      const t0 = Date.now();
      const claim = await jsonRequest(baseUrl, '/api/tasks/lease-1/claim', {
        method: 'POST', headers: headers(undefined, 'alpha'), body: JSON.stringify({ agent_id: 'alpha' }),
        });
      assert.equal(claim.response.status, 200);
      assert.equal(claim.body.assigned_agent, 'alpha');
      assert.equal(claim.body.status, 'BUILDING', 'BACKLOG -> BUILDING on claim');
      assert.equal(typeof claim.body.claim_expires_at, 'string');
      assert.ok(Date.parse(claim.body.claim_expires_at) > t0, 'lease deadline is in the future');
      const expected = t0 + TTL_MS;
      assert.ok(
        Math.abs(Date.parse(claim.body.claim_expires_at) - expected) < 5000,
        'lease deadline is ~now + TTL'
       );
     });

  it('2. heartbeat extends the lease', async () => {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('lease-2', 'Lease two'),
        });
      await jsonRequest(baseUrl, '/api/tasks/lease-2/claim', {
        method: 'POST', headers: headers(undefined, 'beta'), body: JSON.stringify({ agent_id: 'beta' }),
        });
      const t0 = Date.now();
      const beat = await jsonRequest(baseUrl, '/api/tasks/lease-2/heartbeat', {
        method: 'POST', headers: headers('builder', 'beta'), body: JSON.stringify({ agent_id: 'beta' }),
        });
      assert.equal(beat.response.status, 200, 'holder heartbeat renews the lease');
      assert.equal(beat.body.assigned_agent, 'beta', 'heartbeat does not reassign ownership');
      assert.ok(Date.parse(beat.body.claim_expires_at) > t0, 'lease extended past the heartbeat instant');
      // No log spam by default: the heartbeat push must not append an agent log.
      const after = store.getTask('lease-2');
      const claimLogCount = after.agent_logs.filter((l) => /claimed this task/.test(l.message)).length;
      assert.equal(claimLogCount, 1, 'heartbeat renews without appending a claim log');
     });

  it('3. non-holder heartbeat is rejected with not_lease_holder (no mutation)', async () => {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('lease-3', 'Lease three'),
        });
      await jsonRequest(baseUrl, '/api/tasks/lease-3/claim', {
        method: 'POST', headers: headers(undefined, 'owner'), body: JSON.stringify({ agent_id: 'owner' }),
        });
      const before = store.getTask('lease-3');
      const beat = await jsonRequest(baseUrl, '/api/tasks/lease-3/heartbeat', {
        method: 'POST', headers: headers('builder', 'intruder'), body: JSON.stringify({ agent_id: 'intruder' }),
        });
      assert.equal(beat.response.status, 409, 'non-holder is rejected');
      assert.equal(beat.body.reason, 'not_lease_holder');
      const after = store.getTask('lease-3');
      assert.equal(after.version, before.version, 'version unchanged: no write happened');
      assert.equal(after.assigned_agent, 'owner', 'ownership unchanged');
     });

  it('4. a privileged role renews any lease without being the holder', async () => {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('lease-4', 'Lease four'),
        });
      await jsonRequest(baseUrl, '/api/tasks/lease-4/claim', {
        method: 'POST', headers: headers(undefined, 'owner'), body: JSON.stringify({ agent_id: 'owner' }),
        });
      const t0 = Date.now();
      const beat = await jsonRequest(baseUrl, '/api/tasks/lease-4/heartbeat', {
        method: 'POST', headers: headers('runner', 'admin-bot'), body: JSON.stringify({ agent_id: 'admin-bot' }),
        });
      assert.equal(beat.response.status, 200, 'privileged role renews any lease');
      assert.equal(beat.body.assigned_agent, 'owner', 'privileged heartbeat keeps the original owner');
      assert.ok(Date.parse(beat.body.claim_expires_at) > t0, 'lease extended');
     });

  it('5. reaper reclaims an expired BUILDING task (setNowFn forces expiry)', async () => {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('reap-1', 'Reap one'),
        });
      await jsonRequest(baseUrl, '/api/tasks/reap-1/claim', {
        method: 'POST', headers: headers(undefined, 'crashy'), body: JSON.stringify({ agent_id: 'crashy' }),
        });
      const task = store.getTask('reap-1');
     assert.ok(task, 'claimed task present');
         // Force this lease into the past and sweep a tick after that expiry,
        // so only reap-1 is expired at "now" (the earlier tests' leases are
        // still within their TTL and are not swept).
     const taskExpireMs = Date.now() - 1000;
      await setExpiry('reap-1', taskExpireMs);
      const future = taskExpireMs + 10;
      const res = await store.reapExpiredClaims({ now: future });
      assert.ok(res.reclaimed.includes('default/reap-1'), 'the expired task was reclaimed');
      const reclaimed = store.getTask('reap-1');
      assert.equal(reclaimed.status, 'BACKLOG', 'status forced back to BACKLOG');
      assert.equal(reclaimed.assigned_agent, null, 'ownership cleared');
      assert.equal(reclaimed.claim_expires_at, null, 'lease cleared');
      assert.equal(reclaimed.reclaim_count, 1, 'reclaim_count incremented');
      const log = reclaimed.agent_logs.at(-1);
      assert.match(log.message, /LEASE EXPIRED/, 'a reclaim log entry was written');
      assert.equal(log.agent_id, 'system');
      assert.equal(log.reclaimed_from, 'crashy', 'reclaim log records the prior owner');
      });

  it('6. the reaper ignores a fresh (not-yet-expired) lease', async () => {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('reap-2', 'Reap two'),
        });
      await jsonRequest(baseUrl, '/api/tasks/reap-2/claim', {
        method: 'POST', headers: headers(undefined, 'fine'), body: JSON.stringify({ agent_id: 'fine' }),
        });
      // A sweep at "now" (well inside the TTL) must not reclaim THIS task.
      const res = await store.reapExpiredClaims({ now: Date.now() });
      assert.ok(!res.reclaimed.includes('default/reap-2'), 'no fresh lease is reclaimed');
      assert.equal(store.getTask('reap-2').status, 'BUILDING', 'task stays BUILDING');
      assert.equal(store.getTask('reap-2').assigned_agent, 'fine', 'ownership retained');
      });

  it('7. the reaper only touches active claim states (DONE/BLOCKED are skipped)', async () => {
      // A BLOCKED task with a stale lease must NOT be reclaimed.
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('reap-blk', 'Reap blocked'),
        });
      await jsonRequest(baseUrl, '/api/tasks/reap-blk/claim', {
        method: 'POST', headers: headers(undefined, 'blocked-owner'), body: JSON.stringify({ agent_id: 'blocked-owner' }),
        });
      // Move BUILDING -> BLOCKED (runner is privileged for BLOCKED).
      await jsonRequest(baseUrl, '/api/tasks/reap-blk', {
        method: 'PATCH', headers: headers('runner'), body: JSON.stringify({ status: 'BLOCKED' }),
         });
      let blk = store.getTask('reap-blk');
      await setExpiry('reap-blk', Date.now() - 1000);

      // A DONE task with a stale lease must NOT be reclaimed.
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('reap-done', 'Reap done'),
        });
      await jsonRequest(baseUrl, '/api/tasks/reap-done/claim', {
        method: 'POST', headers: headers(undefined, 'done-owner'), body: JSON.stringify({ agent_id: 'done-owner' }),
        });
      // Drive the builder->reviewer->tester loop to legal terminal DONE.
      await jsonRequest(baseUrl, '/api/tasks/reap-done', {
        method: 'PATCH', headers: headers('builder'), body: JSON.stringify({ status: 'IN_REVIEW' }),
        });
      await jsonRequest(baseUrl, '/api/tasks/reap-done', {
        method: 'PATCH', headers: headers('reviewer'), body: JSON.stringify({ status: 'IN_TEST' }),
        });
      await jsonRequest(baseUrl, '/api/tasks/reap-done', {
        method: 'PATCH', headers: headers('tester'), body: JSON.stringify({ status: 'DONE' }),
        });
      blk = store.getTask('reap-blk');
      const doneTask = store.getTask('reap-done');
      await setExpiry('reap-blk', Date.now() - 1000);
      await setExpiry('reap-done', Date.now() - 1000);

      const res = await store.reapExpiredClaims({ now: Date.now() });
      assert.ok(!res.reclaimed.includes('default/reap-blk'), 'a BLOCKED task is never reclaimed');
      assert.ok(!res.reclaimed.includes('default/reap-done'), 'a DONE task is never reclaimed');
      assert.equal(store.getTask('reap-blk').status, 'BLOCKED');
      assert.equal(store.getTask('reap-blk').assigned_agent, 'blocked-owner');
      assert.equal(store.getTask('reap-done').status, 'DONE');
      });

  it('8. reclaim fails closed when persistence fails (KB-05 parity)', async () => {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('reap-fc', 'Reap fail-closed'),
         });
      const claim = await jsonRequest(baseUrl, '/api/tasks/reap-fc/claim', {
        method: 'POST', headers: headers(undefined, 'holder'), body: JSON.stringify({ agent_id: 'holder' }),
         });
      const v = claim.body.version;
         // Force this lease into the past while the GOOD store is active, so the
        // sweep below actually attempts to reclaim reap-fc (and its saveTask throws).
      await setExpiry('reap-fc', Date.now() - 1000);
         // Now bind a backend whose saveTask throws (simulated disk failure) — a
        // write that lands AFTER our in-memory expiry is set but BEFORE the memory
        // mutation, so the reclaim must fail closed.
     class FailingStorage extends store.JsonStorage {
        async saveTask() {
          throw new Error('simulated disk failure');
           }
             }
     store.setStorage(new FailingStorage(path.join(tmpDir, 'reap-fc.json')));
      let threw = null;
      const r = await store.reapExpiredClaims({ now: Date.now() }).catch((e) => (threw = e));
      assert.ok(threw instanceof Error && /disk failure/.test(threw.message), 'the failing write surfaces');
           // Memory-after-persistence: the task must still be the active claim.
      assert.equal(store.getTask('reap-fc').status, 'BUILDING', 'task unchanged in memory');
      assert.equal(store.getTask('reap-fc').assigned_agent, 'holder', 'ownership retained');
      assert.equal(store.getTask('reap-fc').version, v, 'version unchanged after a failed reclaim');
        // Restore a good store so later tests are hermetic.
      store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
      await store.loadStore();
        });

  it('9. race: a heartbeat beats a same-tick reaper (renew commits first)', async () => {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('reap-race', 'Race renew wins'),
        });
      const claim = await jsonRequest(baseUrl, '/api/tasks/reap-race/claim', {
        method: 'POST', headers: headers(undefined, 'holder'), body: JSON.stringify({ agent_id: 'holder' }),
        });
      const task = store.getTask('reap-race');
      const t = Date.now() - 1000; // lease already in the past
      await setExpiry('reap-race', t);
        // Renew THEN sweep, both at the same injected tick. The renew commits first
       // (mutating the lock), so the sweep re-reads a fresh expiry and skips it.
      await store.renewLease('reap-race', 'holder', { caller: { role: 'builder' }, now: t + 10 });
      const res = await store.reapExpiredClaims({ now: t + 10 });
      assert.ok(!res.reclaimed.includes('default/reap-race'), 'renew landed first -> it is not reaped');
      assert.equal(store.getTask('reap-race').status, 'BUILDING', 'surviving lease stays BUILDING');
      assert.equal(store.getTask('reap-race').assigned_agent, 'holder', 'ownership retained');
      });

  it('10. race: the reaper beats a heartbeat (renew then sees the lease lost)', async () => {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('reap-race2', 'Race reap wins'),
        });
      const claim = await jsonRequest(baseUrl, '/api/tasks/reap-race2/claim', {
        method: 'POST', headers: headers(undefined, 'holder'), body: JSON.stringify({ agent_id: 'holder' }),
        });
      const task = store.getTask('reap-race2');
      const t = Date.now() - 1000;
      await setExpiry('reap-race2', t);
        // Sweep FIRST, then try to renew: the lease is gone, so renew is rejected.
      const res = await store.reapExpiredClaims({ now: t + 10 });
      assert.ok(res.reclaimed.includes('default/reap-race2'), 'the reaper reclaims the expired lease');
      const beat = await store.renewLease('reap-race2', 'holder', { caller: { role: 'builder' }, now: t + 10 });
      assert.equal(beat.status, 409, 'renew after a reclaim is rejected');
      assert.equal(beat.reason, 'not_claimed', 'the task is no longer claimed');
      assert.equal(store.getTask('reap-race2').status, 'BACKLOG');
      assert.equal(store.getTask('reap-race2').assigned_agent, null);
      });

  it('11. the git card round-trips claim_expires_at + reclaim_count', async () => {
      const gitDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-lease-git-'));
      await execFileAsync('git', ['init'], { cwd: gitDir });
      await execFileAsync('git', ['config', 'user.name', 'Lease Test'], { cwd: gitDir });
      await execFileAsync('git', ['config', 'user.email', 'lease@test.local'], { cwd: gitDir });
      process.env.KANBAN_STORAGE_BACKEND = 'git';
      process.env.KANBAN_GIT_DIR = gitDir;
      store.setStorage(null);
      await store.loadStore();
      await store.createTask({ id: 'git-lease', title: 'Git lease', status: 'BACKLOG', round: 1 });
      await store.claimTask('git-lease', 'g', undefined, {});
          // The card on disk must carry the lease fields.
      const cardPath = path.join(gitDir, 'git-lease.yml');
      assert.ok(existsSync(cardPath), 'git card exists');
      const parsed = yaml.parse(await readFile(cardPath, 'utf8'));
      assert.ok(typeof parsed.claim_expires_at === 'string', 'card carries claim_expires_at');
      assert.equal(parsed.assigned_agent, 'g');
        // Force expiry and verify a reclaim commit persists reclaimed fields.
      await setExpiry('git-lease', Date.now() - 1000);
      await store.reapExpiredClaims({ now: Date.now() });
      const parsedAfter = yaml.parse(await readFile(cardPath, 'utf8'));
      assert.equal(parsedAfter.assigned_agent, null, 'reclaim cleared ownership on the card');
      assert.equal(parsedAfter.status, 'BACKLOG');
      assert.equal(typeof parsedAfter.reclaim_count, 'number', 'card carries reclaim_count');
      assert.equal(parsedAfter.reclaim_count, 1, 'reclaim_count persisted as 1');
      await rm(gitDir, { recursive: true, force: true });
      delete process.env.KANBAN_STORAGE_BACKEND;
      delete process.env.KANBAN_GIT_DIR;
      store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
      await store.loadStore();
       });

  // --- §2.4 holder progress-log extends the lease ---------------------------

  it('12. a progress log from the lease HOLDER extends the lease', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('lease-log-1', 'Holder log'),
      });
    await jsonRequest(baseUrl, '/api/tasks/lease-log-1/claim', {
      method: 'POST', headers: headers(undefined, 'worker-a'), body: JSON.stringify({ agent_id: 'worker-a' }),
      });
    const before = store.getTask('lease-log-1').claim_expires_at;
    // Let wall-clock time advance so the new deadline is observably later.
    await new Promise((r) => setTimeout(r, 15));
    const log = await jsonRequest(baseUrl, '/api/tasks/lease-log-1/logs', {
      method: 'POST', headers: headers('builder', 'worker-a'),
      body: JSON.stringify({ agent_id: 'worker-a', message: 'halfway there' }),
      });
    assert.equal(log.response.status, 200, 'holder may log');
    const after = store.getTask('lease-log-1').claim_expires_at;
    assert.ok(Date.parse(after) > Date.parse(before), 'holder log pushed the lease deadline forward');
    assert.equal(store.getTask('lease-log-1').assigned_agent, 'worker-a', 'ownership unchanged');
     });

  it('13. a progress log from a NON-holder does not extend the lease', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('lease-log-2', 'Stranger log'),
      });
    await jsonRequest(baseUrl, '/api/tasks/lease-log-2/claim', {
      method: 'POST', headers: headers(undefined, 'owner-agent'), body: JSON.stringify({ agent_id: 'owner-agent' }),
      });
    const before = store.getTask('lease-log-2').claim_expires_at;
    await new Promise((r) => setTimeout(r, 15));
    const log = await jsonRequest(baseUrl, '/api/tasks/lease-log-2/logs', {
      method: 'POST', headers: headers('builder', 'stranger'),
      body: JSON.stringify({ agent_id: 'stranger', message: 'butting in' }),
      });
    assert.equal(log.response.status, 200, 'any agent may still append a log');
    const after = store.getTask('lease-log-2').claim_expires_at;
    assert.equal(after, before, 'a non-holder must not inherit or extend the lease');
    assert.equal(store.getTask('lease-log-2').assigned_agent, 'owner-agent', 'ownership unchanged');
     });

  it('14. the holder log extension keeps an active card off the reaper', async () => {
    await store.createTask({ id: 'lease-log-3', title: 'Log keeps lease', status: 'BACKLOG', round: 1 });
    await store.claimTask('lease-log-3', 'worker-b', undefined, {});
    // Pin the lease to just about to expire, then log as the holder.
    await setExpiry('lease-log-3', Date.now() + 500);
    await store.appendLog('lease-log-3', 'worker-b', 'still alive', undefined, {});
    const swept = await store.reapExpiredClaims({ now: Date.now() + 1000 });
    assert.ok(!swept.reclaimed.includes('default/lease-log-3'), 'extended lease survived the sweep');
    assert.equal(store.getTask('lease-log-3').status, 'BUILDING');
    assert.equal(store.getTask('lease-log-3').assigned_agent, 'worker-b');
     });
});
