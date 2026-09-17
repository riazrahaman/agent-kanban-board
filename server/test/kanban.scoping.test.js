/**
 * Regressions for the project-scoping and audit-attribution defects found in
 * review of the multi-project branch. Each test here failed before its fix.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'pi03-scoping-token';

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
     });
   });
}

function headers(role = 'builder', agentId) {
  return {
    Authorization: `Bearer ${TOKEN}`,
     'Content-Type': 'application/json',
     ...(role ? { 'X-Agent-Role': role } : {}),
     ...(agentId ? { 'X-Agent-Id': agentId } : {}),
   };
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

async function createTask(baseUrl, project, id, title, extra = {}) {
  const r = await jsonRequest(baseUrl, `/api/tasks?project=${project}`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ id, title, status: 'BACKLOG', round: 1, ...extra }),
    });
  assert.equal(r.response.status, 201, `created ${project}/${id}`);
  return r.body;
}

describe('project scoping + audit attribution regressions', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-scoping-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
   });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
   });

  it('1. the reaper reclaims an expired lease in a NON-default project', async () => {
    // Before the fix, reapExpiredClaims called the 1-arg getTask(t.id), which
    // resolves against `default`. For a task in `atlas` that returned null and
    // reclaimTaskInner threw, aborting the sweep for the whole batch.
    await createTask(baseUrl, 'atlas', 'reap-atlas', 'Atlas lease');
    const claim = await jsonRequest(baseUrl, '/api/tasks/reap-atlas/claim?project=atlas', {
      method: 'POST', headers: headers('builder', 'crashy'),
      body: JSON.stringify({ agent_id: 'crashy' }),
      });
    assert.equal(claim.response.status, 200);

    const t = store.getTask('reap-atlas', 'atlas');
    assert.ok(t, 'the atlas task exists');
    const expiredMs = Date.now() - 1000;
    t.claim_expires_at = new Date(expiredMs).toISOString();
    await store.getStorage('atlas').saveTask(t, store.getProjectBucket('atlas'));

    const res = await store.reapExpiredClaims({ now: expiredMs + 10 });
    assert.ok(
      res.reclaimed.includes('atlas/reap-atlas'),
      'the atlas lease was reclaimed, and is reported by composite key',
      );
    const after = store.getTask('reap-atlas', 'atlas');
    assert.equal(after.status, 'BACKLOG', 'status forced back to BACKLOG');
    assert.equal(after.assigned_agent, null, 'ownership cleared');
    });

  it('2. the reaper reclaims the right task when two projects share a short id', async () => {
    await createTask(baseUrl, 'default', 'dupe', 'Default dupe');
    await createTask(baseUrl, 'orion', 'dupe', 'Orion dupe');
    for (const [project, agent] of [['default', 'agent-d'], ['orion', 'agent-o']]) {
      const r = await jsonRequest(baseUrl, `/api/tasks/dupe/claim?project=${project}`, {
        method: 'POST', headers: headers('builder', agent),
        body: JSON.stringify({ agent_id: agent }),
        });
      assert.equal(r.response.status, 200, `claimed ${project}/dupe`);
      }

    // Expire ONLY the orion copy. The default copy must survive untouched.
    const orion = store.getTask('dupe', 'orion');
    const expiredMs = Date.now() - 1000;
    orion.claim_expires_at = new Date(expiredMs).toISOString();
    await store.getStorage('orion').saveTask(orion, store.getProjectBucket('orion'));

    const res = await store.reapExpiredClaims({ now: expiredMs + 10 });
    assert.ok(res.reclaimed.includes('orion/dupe'), 'the expired orion lease was reclaimed');
    assert.ok(!res.reclaimed.includes('default/dupe'), 'the healthy default lease was not');
    assert.equal(store.getTask('dupe', 'orion').assigned_agent, null, 'orion released');
    assert.equal(
      store.getTask('dupe', 'default').assigned_agent, 'agent-d',
      'the default copy still belongs to its agent — no cross-project reclaim',
      );
    });

  it('3. nextClaim never hands an agent a task from another project', async () => {
    await createTask(baseUrl, 'projx', 'x-1', 'X card');
    await createTask(baseUrl, 'projy', 'y-1', 'Y card');

    const r = await jsonRequest(baseUrl, '/api/tasks/next-claim?project=projx', {
      method: 'POST', headers: headers('builder', 'agent-x'),
      body: JSON.stringify({ agent_id: 'agent-x', role: 'builder' }),
      });
    assert.equal(r.response.status, 200);
    assert.equal(r.body.project, 'projx', 'the winner came from the requested project');
    assert.equal(r.body.id, 'x-1');
    assert.equal(
      store.getTask('y-1', 'projy').assigned_agent, null,
      'the other project\'s card was never touched',
      );
    });

  it('4. nextClaim reports nothing claimable rather than crossing projects', async () => {
    await createTask(baseUrl, 'emptyproj', 'placeholder', 'Held', {});
    await jsonRequest(baseUrl, '/api/tasks/placeholder/claim?project=emptyproj', {
      method: 'POST', headers: headers('builder', 'holder'),
      body: JSON.stringify({ agent_id: 'holder' }),
      });

    // emptyproj now has no unclaimed BACKLOG card, but other projects do.
    const r = await fetch(`${baseUrl}/api/tasks/next-claim?project=emptyproj`, {
      method: 'POST', headers: headers('builder', 'agent-e'),
      body: JSON.stringify({ agent_id: 'agent-e', role: 'builder' }),
      });
    assert.equal(r.status, 204, 'no claimable card in scope -> 204, not another project\'s card');
    });

  it('5. an invalid ?project= is a 400, never a silent widening to all projects', async () => {
    await createTask(baseUrl, 'realproj', 'real-1', 'Real card');

    const bad = await jsonRequest(baseUrl, '/api/tasks?project=my%20proj');
    assert.equal(bad.response.status, 400, 'a malformed scope is rejected');
    assert.match(bad.body.error, /Invalid project scope/);

    // The dangerous prior behaviour: undefined scope -> store.getTasks(undefined)
    // -> the entire portfolio handed to a caller that thinks it is scoped.
    assert.ok(!Array.isArray(bad.body), 'no task array is returned for a bad scope');

    const badCreate = await jsonRequest(baseUrl, '/api/tasks?project=my%20proj', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ id: 'leak-1', title: 'Leak', status: 'BACKLOG', round: 1 }),
      });
    assert.equal(badCreate.response.status, 400, 'create is rejected too');
    assert.equal(
      store.getTask('leak-1', 'default'), null,
      'the rejected create did not silently land in the default project',
      );

    const good = await jsonRequest(baseUrl, '/api/tasks?project=realproj');
    assert.equal(good.response.status, 200);
    assert.ok(good.body.every((t) => t.project === 'realproj'), 'a valid scope still filters');
    });

  it('6. a lease renewal is attributed to the renewing agent, not to system', async () => {
    await createTask(baseUrl, 'auditproj', 'renew-1', 'Renew me');
    await jsonRequest(baseUrl, '/api/tasks/renew-1/claim?project=auditproj', {
      method: 'POST', headers: headers('builder', 'agent-r'),
      body: JSON.stringify({ agent_id: 'agent-r' }),
      });

    const seen = [];
    const off = store.onDiff((evt) => seen.push(evt));
    try {
      const hb = await jsonRequest(baseUrl, '/api/tasks/renew-1/heartbeat?project=auditproj', {
        method: 'POST', headers: headers('builder', 'agent-r'),
        body: JSON.stringify({ agent_id: 'agent-r' }),
        });
      assert.equal(hb.response.status, 200, 'the heartbeat succeeded');
      } finally {
      off();
      }

    const renewed = seen.filter((e) => e.kind === 'renewed');
    assert.equal(renewed.length, 1, 'exactly one renewed event');
    assert.equal(
      renewed[0].actor, 'agent-r',
      'the renewing agent owns the event — reading caller.agentId (vs the ' +
      'middleware\'s agent_id) attributed every renewal to system',
      );
    });
});
