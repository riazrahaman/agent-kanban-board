/**
 * Pipeline C — incremental aggregate cache. Proves that the cached
 * getProjectSummaries() / getMetrics() output is byte-for-byte identical to a
 * brute-force recompute from the authoritative live + archive state across a
 * sequence of mutations (create -> patch -> reclaim -> archive).
 */
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as store from '../store.js';

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function bruteDurations(values) {
  if (values.length === 0) {
    return { count: 0, mean_ms: null, median_ms: null, p90_ms: null, min_ms: null, max_ms: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    mean_ms: Math.round(total / sorted.length),
    median_ms: percentile(sorted, 50),
    p90_ms: percentile(sorted, 90),
    min_ms: sorted[0],
    max_ms: sorted[sorted.length - 1],
  };
}

// Independent brute-force recompute of getProjectSummaries() from raw state.
function bruteSummaries(tasks, archive) {
  const map = new Map();
  const ensure = (p) => {
    let s = map.get(p);
    if (!s) {
      s = { project: p, task_count: 0, done_count: 0, live_count: 0, archived_count: 0, updated: null };
      map.set(p, s);
    }
    return s;
  };
  const touch = (s, iso) => {
    if (iso && (!s.updated || iso > s.updated)) s.updated = iso;
  };
  for (const t of tasks) {
    const s = ensure(t.project);
    s.live_count += 1;
    s.task_count += 1;
    if (t.status === store.STATUSES.DONE) s.done_count += 1;
    touch(s, t.updated);
  }
  for (const [p, list] of Object.entries(archive)) {
    const s = ensure(p);
    s.archived_count += list.length;
    s.task_count += list.length;
    for (const t of list) touch(s, t.archived_at || t.updated);
  }
  return [...map.values()].sort((a, b) => a.project.localeCompare(b.project));
}

// Independent brute-force recompute of getMetrics(scope).projects/aggregate.
function bruteMetrics(scope, tasks, archive, contentionCounts, contentionSince) {
  const byProject = new Map();
  const ensure = (p) => {
    if (!byProject.has(p)) {
      byProject.set(p, {
        project: p, task_count: 0, live_count: 0, archived_count: 0, done_count: 0,
        completed_count: 0,
        by_status: Object.fromEntries(store.VALID_STATUS_LIST.map((s) => [s, 0])),
        reclaim_count: 0, reclaimed_task_count: 0, cycles: [], agents: new Set(),
      });
    }
    return byProject.get(p);
  };
  const nowMs = Date.now();
  const ingest = (task, archived) => {
    if (scope !== null && task.project !== scope) return;
    const m = ensure(task.project);
    m.task_count += 1;
    if (archived) m.archived_count += 1; else m.live_count += 1;
    if (Object.prototype.hasOwnProperty.call(m.by_status, task.status)) m.by_status[task.status] += 1;
    if (task.status === store.STATUSES.DONE) {
      m.completed_count += 1;
      if (!archived) m.done_count += 1;
    }
    const reclaims = Number.isInteger(task.reclaim_count) ? task.reclaim_count : 0;
    m.reclaim_count += reclaims;
    if (reclaims > 0) m.reclaimed_task_count += 1;
    if (task.completed_at && task.created_at) {
      const start = Date.parse(task.created_at);
      const end = Date.parse(task.completed_at);
      if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) m.cycles.push(end - start);
    }
    if (!archived && task.assigned_agent) {
      const expiry = task.claim_expires_at ? Date.parse(task.claim_expires_at) : NaN;
      if (!Number.isNaN(expiry) && expiry > nowMs) m.agents.add(task.assigned_agent);
    }
  };
  for (const t of tasks) ingest(t, false);
  for (const [p, list] of Object.entries(archive)) {
    for (const t of list) ingest({ ...t, project: t.project || p }, true);
  }
  if (scope !== null) ensure(scope);

  const projects = [...byProject.values()]
    .map((m) => ({
      project: m.project, task_count: m.task_count, live_count: m.live_count,
      archived_count: m.archived_count, done_count: m.done_count, completed_count: m.completed_count,
      by_status: m.by_status, cycle_time: bruteDurations(m.cycles),
      reclaim_count: m.reclaim_count, reclaimed_task_count: m.reclaimed_task_count,
      active_agents: [...m.agents].sort(), active_agent_count: m.agents.size,
      claim_contention: { conflicts: contentionCounts.get(m.project) || 0, since: contentionSince },
    }))
    .sort((a, b) => a.project.localeCompare(b.project));

  const allCycles = [...byProject.values()].flatMap((m) => m.cycles);
  const allAgents = new Set([...byProject.values()].flatMap((m) => [...m.agents]));
  const sum = (k) => projects.reduce((acc, m) => acc + m[k], 0);
  const aggregate = {
    project: null, project_count: projects.length, task_count: sum('task_count'),
    live_count: sum('live_count'), archived_count: sum('archived_count'),
    done_count: sum('done_count'), completed_count: sum('completed_count'),
    by_status: Object.fromEntries(store.VALID_STATUS_LIST.map((s) => [s, projects.reduce((acc, m) => acc + m.by_status[s], 0)])),
    cycle_time: bruteDurations(allCycles),
    reclaim_count: sum('reclaim_count'), reclaimed_task_count: sum('reclaimed_task_count'),
    active_agents: [...allAgents].sort(), active_agent_count: allAgents.size,
    claim_contention: { conflicts: projects.reduce((acc, m) => acc + m.claim_contention.conflicts, 0), since: contentionSince },
  };
  return { projects, aggregate };
}

function assertMetricsEqual(cached, scope) {
  const tasks = store.getTasks();
  const archive = {};
  for (const p of new Set([...tasks.map((t) => t.project), ...store.getArchivedTasks().map((t) => t.project)])) {
    const a = store.getArchivedTasks(p);
    if (a.length) archive[p] = a;
  }
  const summaries = bruteSummaries(tasks, archive);
  assert.deepEqual(store.getProjectSummaries(), summaries, 'summaries match brute force');

  // claim_contention.since is a boot timestamp, not derivable from task state;
  // read the authoritative value from the cached result so the brute recompute
  // can mirror it. Everything else is recomputed independently.
  const since = cached.aggregate.claim_contention.since;
  const { projects, aggregate } = bruteMetrics(scope, tasks, archive, new Map(), since);

  assert.deepEqual(cached.projects, projects, `projects match brute force (scope=${scope})`);
  assert.equal(cached.aggregate.project_count, aggregate.project_count);
  assert.equal(cached.aggregate.task_count, aggregate.task_count);
  assert.equal(cached.aggregate.live_count, aggregate.live_count);
  assert.equal(cached.aggregate.archived_count, aggregate.archived_count);
  assert.equal(cached.aggregate.done_count, aggregate.done_count);
  assert.equal(cached.aggregate.completed_count, aggregate.completed_count);
  assert.deepEqual(cached.aggregate.by_status, aggregate.by_status);
  assert.deepEqual(cached.aggregate.cycle_time, aggregate.cycle_time);
  assert.equal(cached.aggregate.reclaim_count, aggregate.reclaim_count);
  assert.equal(cached.aggregate.reclaimed_task_count, aggregate.reclaimed_task_count);
  assert.deepEqual(cached.aggregate.active_agents, aggregate.active_agents);
  assert.equal(cached.aggregate.active_agent_count, aggregate.active_agent_count);
  assert.deepEqual(cached.aggregate.claim_contention, aggregate.claim_contention);
}

describe('Pipeline C — incremental aggregate cache equals brute force', () => {
  let tmpDir;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-agg-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    store.resetClaimContention();
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
  });

  it('cached aggregates stay identical to a brute-force recompute across create->patch->reclaim->archive', async () => {
    const p = 'aggproj';

    // create
    await store.createTask({ id: 'a', title: 'A', status: 'BACKLOG', round: 1, project: p });
    await store.createTask({ id: 'b', title: 'B', status: 'BACKLOG', round: 1, project: p });
    assertMetricsEqual(store.getMetrics(), null);

    // patch a -> DONE (produces a completion cycle)
    await store.patchTask('a', { status: 'BUILDING' }, { project: p, caller: { role: 'builder' } });
    await store.patchTask('a', { status: 'IN_REVIEW' }, { project: p, caller: { role: 'builder' } });
    await store.patchTask('a', { status: 'IN_TEST' }, { project: p, caller: { role: 'reviewer' } });
    await store.patchTask('a', { status: 'DONE' }, { project: p, caller: { role: 'tester' } });
    assertMetricsEqual(store.getMetrics(), null);
    assertMetricsEqual(store.getMetrics(p), p);

    // claim b then reclaim it (reclaim_count -> 1)
    await store.claimTask('b', 'agent-x', p);
    const held = store.getTask('b', p);
    held.claim_expires_at = new Date(Date.now() - 1000).toISOString();
    await store.getStorage(p).saveTask(held, store.getProjectBucket(p));
    await store.reapExpiredClaims({ now: Date.now() });
    assertMetricsEqual(store.getMetrics(), null);

    // archive a
    const done = store.getTask('a', p);
    const past = new Date(Date.now() - 90 * 86400000).toISOString();
    done.created_at = past;
    done.completed_at = past;
    await store.getStorage(p).saveTask(done, store.getProjectBucket(p));
    process.env.KANBAN_ARCHIVE_AFTER_DAYS = '7';
    await store.runArchiveSweep();
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    assertMetricsEqual(store.getMetrics(), null);
    assertMetricsEqual(store.getMetrics(p), p);
  });

  it('cold-start recompute matches after reload', async () => {
    await store.loadStore();
    assertMetricsEqual(store.getMetrics(), null);
  });
});
