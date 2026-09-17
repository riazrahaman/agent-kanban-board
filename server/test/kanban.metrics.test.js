/**
 * §2.9 — cross-project observability. GET /api/metrics[?project=X].
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'pi03-metrics-token';

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

async function createTask(baseUrl, project, id, extra = {}) {
  const r = await jsonRequest(baseUrl, `/api/tasks?project=${project}`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ id, title: id, status: 'BACKLOG', round: 1, ...extra }),
    });
  assert.equal(r.response.status, 201, `created ${project}/${id}`);
  return r.body;
}

async function driveToDone(baseUrl, project, id) {
  const steps = [
    { role: 'builder', status: 'BUILDING' },
    { role: 'builder', status: 'IN_REVIEW' },
    { role: 'reviewer', status: 'IN_TEST' },
    { role: 'tester', status: 'DONE' },
    ];
  for (const { role, status } of steps) {
    const r = await jsonRequest(baseUrl, `/api/tasks/${id}?project=${project}`, {
      method: 'PATCH', headers: headers(role), body: JSON.stringify({ status }),
      });
    assert.equal(r.response.status, 200, `${project}/${id} -> ${status}`);
    }
}

const find = (metrics, project) => metrics.projects.find((p) => p.project === project);

describe('§2.9 cross-project metrics', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-metrics-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    store.resetClaimContention();
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

  it('1. reports per-project counts and a portfolio aggregate', async () => {
    await createTask(baseUrl, 'mx', 'mx-1');
    await createTask(baseUrl, 'mx', 'mx-2');
    await createTask(baseUrl, 'my', 'my-1');
    await driveToDone(baseUrl, 'mx', 'mx-1');

    const { response, body } = await jsonRequest(baseUrl, '/api/metrics');
    assert.equal(response.status, 200);
    assert.equal(body.scope, null, 'unscoped');
    assert.ok(body.generated_at, 'carries a generation timestamp');

    const mx = find(body, 'mx');
    assert.equal(mx.task_count, 2);
    assert.equal(mx.done_count, 1);
    assert.equal(mx.by_status.DONE, 1);
    assert.equal(mx.by_status.BACKLOG, 1);

    const my = find(body, 'my');
    assert.equal(my.task_count, 1);
    assert.equal(my.done_count, 0);

    assert.equal(body.aggregate.task_count, 3, 'aggregate sums every project');
    assert.equal(body.aggregate.done_count, 1);
    assert.ok(body.aggregate.project_count >= 2);
    });

  it('2. a scoped read reports only that project', async () => {
    const { response, body } = await jsonRequest(baseUrl, '/api/metrics?project=my');
    assert.equal(response.status, 200);
    assert.equal(body.scope, 'my');
    assert.deepEqual(body.projects.map((p) => p.project), ['my'], 'no other project leaks in');
    assert.equal(body.aggregate.task_count, 1, 'the aggregate is over the scope, not the portfolio');
    });

  it('3. an invalid scope is a 400, not a silent portfolio aggregate', async () => {
    // The guard is shared middleware precisely so a new router cannot reopen
    // this: undefined scope means *every* project inside the store.
    const { response, body } = await jsonRequest(baseUrl, '/api/metrics?project=bad%20scope');
    assert.equal(response.status, 400);
    assert.match(body.error, /Invalid project scope/);
    assert.equal(body.aggregate, undefined, 'no metrics body is returned at all');
    });

  it('4. a valid but unknown project reports zeroes rather than 404 or everything', async () => {
    const { response, body } = await jsonRequest(baseUrl, '/api/metrics?project=ghost');
    assert.equal(response.status, 200);
    assert.deepEqual(body.projects.map((p) => p.project), ['ghost']);
    assert.equal(body.projects[0].task_count, 0);
    assert.equal(body.projects[0].cycle_time.count, 0);
    assert.equal(body.projects[0].cycle_time.mean_ms, null, 'no cycle time without completions');
    });

  it('5. cycle time is measured from created_at to completed_at', async () => {
    await createTask(baseUrl, 'mcycle', 'c-1');
    // Backdate creation by an hour so the window is unambiguous.
    const task = store.getTask('c-1', 'mcycle');
    task.created_at = new Date(Date.now() - 3600000).toISOString();
    await store.getStorage('mcycle').saveTask(task, store.getProjectBucket('mcycle'));
    await driveToDone(baseUrl, 'mcycle', 'c-1');

    const { body } = await jsonRequest(baseUrl, '/api/metrics?project=mcycle');
    const m = find(body, 'mcycle');
    assert.equal(m.cycle_time.count, 1, 'one completed task contributes one sample');
    assert.ok(
      m.cycle_time.mean_ms >= 3500000 && m.cycle_time.mean_ms <= 3700000,
      `expected ~1h cycle time, got ${m.cycle_time.mean_ms}`,
      );
    assert.equal(m.cycle_time.median_ms, m.cycle_time.mean_ms, 'single sample: median == mean');
    });

  it('6. archived tasks still count toward cycle time', async () => {
    // Archiving is a move, not a deletion. Dropping archived rows would make
    // cycle time silently improve as completed history is swept away.
    await createTask(baseUrl, 'march', 'a-1');
    await driveToDone(baseUrl, 'march', 'a-1');
    const task = store.getTask('a-1', 'march');
    const past = new Date(Date.now() - 90 * 86400000).toISOString();
    task.created_at = past;
    task.completed_at = past;
    await store.getStorage('march').saveTask(task, store.getProjectBucket('march'));

    // The metrics route runs a lazy sweep, and the default window is 30 days —
    // so read the pre-archive baseline with the sweep disabled, or this card
    // would already be gone before the comparison starts.
    process.env.KANBAN_ARCHIVE_AFTER_DAYS = '0';
    const before = find(await jsonRequest(baseUrl, '/api/metrics?project=march')
      .then((r) => r.body), 'march');
    assert.equal(before.live_count, 1, 'still live while the sweep is disabled');
    assert.equal(before.archived_count, 0);
    assert.equal(before.cycle_time.count, 1);

    process.env.KANBAN_ARCHIVE_AFTER_DAYS = '7';
    try {
      const moved = await store.runArchiveSweep();
      assert.equal(moved, 1, 'the backdated card was archived');
      const { body } = await jsonRequest(baseUrl, '/api/metrics?project=march');
      const m = find(body, 'march');
      assert.equal(m.archived_count, 1, 'counted as archived');
      assert.equal(m.live_count, 0, 'no longer live');
      assert.equal(m.task_count, 1, 'still one task in total');
      assert.equal(m.cycle_time.count, 1, 'the completion still contributes a sample');
      assert.equal(m.completed_count, 1, 'archived DONE work is still completed work');
      assert.equal(
        m.done_count, 0,
        'done_count is the LIVE board, so it agrees with GET /api/projects after a sweep',
        );
      const summaries = (await jsonRequest(baseUrl, '/api/projects')).body;
      const summary = summaries.find((s) => s.project === 'march');
      assert.equal(
        summary.done_count, m.done_count,
        '/api/projects and /api/metrics must not disagree about the same project',
        );
      } finally {
      delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
      }
    });

  it('7. reclaim counts come from the persisted field, so they survive a reload', async () => {
    await createTask(baseUrl, 'mreclaim', 'r-1');
    await jsonRequest(baseUrl, '/api/tasks/r-1/claim?project=mreclaim', {
      method: 'POST', headers: headers('builder', 'crashy'),
      body: JSON.stringify({ agent_id: 'crashy' }),
      });
    const t = store.getTask('r-1', 'mreclaim');
    const expiredMs = Date.now() - 1000;
    t.claim_expires_at = new Date(expiredMs).toISOString();
    await store.getStorage('mreclaim').saveTask(t, store.getProjectBucket('mreclaim'));
    await store.reapExpiredClaims({ now: expiredMs + 10 });

    const first = find(
      (await jsonRequest(baseUrl, '/api/metrics?project=mreclaim')).body, 'mreclaim');
    assert.equal(first.reclaim_count, 1, 'the reclaim was counted');
    assert.equal(first.reclaimed_task_count, 1);

    // Counters accumulated in memory would reset here; a persisted field does not.
    await store.loadStore();
    const second = find(
      (await jsonRequest(baseUrl, '/api/metrics?project=mreclaim')).body, 'mreclaim');
    assert.equal(second.reclaim_count, 1, 'the count survived a store reload');
    });

  it('8. active agents count only unexpired leases', async () => {
    await createTask(baseUrl, 'magents', 'ag-1');
    await createTask(baseUrl, 'magents', 'ag-2');
    await jsonRequest(baseUrl, '/api/tasks/ag-1/claim?project=magents', {
      method: 'POST', headers: headers('builder', 'live-agent'),
      body: JSON.stringify({ agent_id: 'live-agent' }),
      });
    await jsonRequest(baseUrl, '/api/tasks/ag-2/claim?project=magents', {
      method: 'POST', headers: headers('builder', 'stale-agent'),
      body: JSON.stringify({ agent_id: 'stale-agent' }),
      });

    // Lapse one lease WITHOUT reaping it: the assignment lingers on the task.
    const stale = store.getTask('ag-2', 'magents');
    stale.claim_expires_at = new Date(Date.now() - 1000).toISOString();
    await store.getStorage('magents').saveTask(stale, store.getProjectBucket('magents'));

    const m = find((await jsonRequest(baseUrl, '/api/metrics?project=magents')).body, 'magents');
    assert.deepEqual(
      m.active_agents, ['live-agent'],
      'an agent whose lease has lapsed is not doing work, whatever the task still says',
      );
    assert.equal(m.active_agent_count, 1);
    });

  it('9. claim contention is counted per project and flagged as since-boot', async () => {
    store.resetClaimContention();
    await createTask(baseUrl, 'mcontend', 'x-1');
    await jsonRequest(baseUrl, '/api/tasks/x-1/claim?project=mcontend', {
      method: 'POST', headers: headers('builder', 'first'),
      body: JSON.stringify({ agent_id: 'first' }),
      });
    for (const who of ['second', 'third']) {
      const r = await jsonRequest(baseUrl, '/api/tasks/x-1/claim?project=mcontend', {
        method: 'POST', headers: headers('builder', who),
        body: JSON.stringify({ agent_id: who }),
        });
      assert.equal(r.response.status, 409, `${who} loses the race`);
      }

    const { body } = await jsonRequest(baseUrl, '/api/metrics?project=mcontend');
    const m = find(body, 'mcontend');
    assert.equal(m.claim_contention.conflicts, 2, 'both losing claims were counted');
    assert.ok(m.claim_contention.since, 'reported as a since-boot window, not a durable total');
    });
  it('10. an assignment with no lease is never counted as an active agent', async () => {
    // createTask passes a body `assigned_agent` straight through and never sets
    // claim_expires_at, and the reaper skips records whose expiry is null — so
    // treating "no usable lease" as active reported a phantom agent forever,
    // with nothing in the system able to clear it.
    const r = await jsonRequest(baseUrl, '/api/tasks?project=mghost', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({
        id: 'ghost-1', title: 'Ghost', status: 'BACKLOG', round: 1, assigned_agent: 'phantom',
        }),
      });
    assert.equal(r.response.status, 201);
    assert.ok(
      !store.getTask('ghost-1', 'mghost').claim_expires_at,
      'no lease was issued alongside the assignment',
      );

    const m = find((await jsonRequest(baseUrl, '/api/metrics?project=mghost')).body, 'mghost');
    assert.deepEqual(m.active_agents, [], 'an assignment without a lease is not an agent at work');
    assert.equal(m.active_agent_count, 0);
    });

  it('11. a lapsed, unreaped lease is not counted as claim contention', async () => {
    // Otherwise the endpoint contradicts itself: "two agents raced for this"
    // while simultaneously reporting that nobody holds it. With the reaper
    // disabled, a polling agent would inflate the counter without bound.
    store.resetClaimContention();
    await createTask(baseUrl, 'mstale', 's-1');
    await jsonRequest(baseUrl, '/api/tasks/s-1/claim?project=mstale', {
      method: 'POST', headers: headers('builder', 'crashed'),
      body: JSON.stringify({ agent_id: 'crashed' }),
      });
    const t = store.getTask('s-1', 'mstale');
    t.claim_expires_at = new Date(Date.now() - 1000).toISOString();
    await store.getStorage('mstale').saveTask(t, store.getProjectBucket('mstale'));

    const r = await jsonRequest(baseUrl, '/api/tasks/s-1/claim?project=mstale', {
      method: 'POST', headers: headers('builder', 'newcomer'),
      body: JSON.stringify({ agent_id: 'newcomer' }),
      });
    assert.equal(r.response.status, 409, 'the stale holder still blocks the claim');

    const m = find((await jsonRequest(baseUrl, '/api/metrics?project=mstale')).body, 'mstale');
    assert.equal(m.claim_contention.conflicts, 0, 'a crashed agent is not a race');
    assert.deepEqual(m.active_agents, [], 'and it is consistent with active_agents');
    });
});
