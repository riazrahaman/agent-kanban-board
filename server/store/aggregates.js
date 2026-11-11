/**
 * C1 (v3.12.5) — §2.9 cross-project aggregates: project summaries, metrics and
 * the since-boot claim-contention counters.
 *
 * The aggregate CACHES (summaries, per-project metric bases, cycle samples) live
 * here because only this module reads or writes them; the dirty FLAG lives in
 * ./core.js because the index-maintenance primitives there invalidate it under
 * the mutation lock. Extracted verbatim from store.js.
 */
import { tasks, archive, aggregatesDirty, markAggregatesClean } from './core.js';
import { STATUSES, VALID_STATUS_LIST } from '../state-machine.js';
import { defaultProjectName, isValidProjectId } from '../task-identity.js';

let cachedSummaries = null;   // sorted array result of getProjectSummaries()
let cachedMetricBases = null; // Map<project, baseMetric> (counts + sorted cycles)
let cachedAggregateCycleTime = null; // summarizeDurations(all cycle samples)

function rebuildSummaries() {
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
    if (t.status === STATUSES.DONE) s.done_count += 1;
    touch(s, t.updated);
  }
  for (const [p, list] of Object.entries(archive)) {
    const s = ensure(p);
    s.archived_count += list.length;
    s.task_count += list.length;
    for (const t of list) touch(s, t.archived_at || t.updated);
  }
  cachedSummaries = [...map.values()].sort((a, b) => a.project.localeCompare(b.project));
}

// Builds the task-derived, durable portion of §2.9 metrics (everything except
// `active_agents` — lease expiry is measured against wall-clock `now` — and
// `claim_contention` — a since-boot counter). Cycle samples are sorted once here
// so `cycle_time` is O(1) at read time instead of re-sorting the completed set.
function rebuildMetricBases() {
  const byProject = new Map();
  const ensure = (p) => {
    if (!byProject.has(p)) {
      byProject.set(p, {
        project: p,
        task_count: 0,
        live_count: 0,
        archived_count: 0,
        done_count: 0,
        completed_count: 0,
        by_status: Object.fromEntries(VALID_STATUS_LIST.map((s) => [s, 0])),
        reclaim_count: 0,
        reclaimed_task_count: 0,
        cycles: [],
      });
    }
    return byProject.get(p);
  };
  const ingest = (task, archived) => {
    const m = ensure(task.project);
    m.task_count += 1;
    if (archived) m.archived_count += 1;
    else m.live_count += 1;

    if (Object.prototype.hasOwnProperty.call(m.by_status, task.status)) {
      m.by_status[task.status] += 1;
    }
    if (task.status === STATUSES.DONE) {
      m.completed_count += 1;
      if (!archived) m.done_count += 1;
    }

    const reclaims = Number.isInteger(task.reclaim_count) ? task.reclaim_count : 0;
    m.reclaim_count += reclaims;
    if (reclaims > 0) m.reclaimed_task_count += 1;

    if (task.completed_at && task.created_at) {
      const start = Date.parse(task.created_at);
      const end = Date.parse(task.completed_at);
      if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
        m.cycles.push(end - start);
      }
    }
  };

  for (const t of tasks) ingest(t, false);
  for (const [p, list] of Object.entries(archive)) {
    for (const t of list) ingest({ ...t, project: t.project || p }, true);
  }

  // Pre-sorted union of every project's cycle samples, for the unscoped
  // aggregate. (The scoped aggregate's cycle time equals that project's own.)
  const allCycles = [];
  for (const m of byProject.values()) {
    for (const d of m.cycles) allCycles.push(d);
    m.cycles.sort((a, b) => a - b);
    m.cycle_time = summarizeDurations(m.cycles);
    delete m.cycles;
  }
  allCycles.sort((a, b) => a - b);
  cachedMetricBases = byProject;
  cachedAggregateCycleTime = summarizeDurations(allCycles);
}

// Empty (no tasks) per-project metric base, for a valid-but-unknown scope.
function emptyBase(project) {
  return {
    project,
    task_count: 0,
    live_count: 0,
    archived_count: 0,
    done_count: 0,
    completed_count: 0,
    by_status: Object.fromEntries(VALID_STATUS_LIST.map((s) => [s, 0])),
    cycle_time: summarizeDurations([]),
    reclaim_count: 0,
    reclaimed_task_count: 0,
  };
}

// Recomputes the aggregate caches from authoritative live + archive state. Only
// runs after a committed mutation (or load) flips `aggregatesDirty`.
function rebuildAggregates() {
  if (!aggregatesDirty) return;
  rebuildSummaries();
  rebuildMetricBases();
  markAggregatesClean();
}

export function getProjectSummaries() {
  rebuildAggregates();
  // Deep-review: return a copy — a caller (or a route handler mutating entries)
  // must never be able to edit the shared aggregate cache in place.
  return cachedSummaries.map((s) => ({ ...s }));
}

// ---------------------------------------------------------------------------
// §2.9 — cross-project observability
// ---------------------------------------------------------------------------

/**
 * Claim-contention counters, per project. This is the one metric with no
 * durable source: a rejected claim is not a committed mutation, so it leaves no
 * trace on any task and emits no audit entry. It is therefore reported as an
 * explicitly since-boot figure (`claim_contention.since`) rather than being
 * presented alongside the durable counts as if it survived a restart.
 */
let contentionCounts = new Map();
let contentionSince = new Date().toISOString();

export function recordClaimContention(project) {
  const key = project || defaultProjectName();
  contentionCounts.set(key, (contentionCounts.get(key) || 0) + 1);
}

export function resetClaimContention() {
  contentionCounts = new Map();
  contentionSince = new Date().toISOString();
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarizeDurations(values) {
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

/**
 * §2.9 metrics for one project, or every project plus an aggregate.
 *
 * Everything except claim contention is computed from persisted task fields
 * (`created_at` / `completed_at` / `reclaim_count` / `assigned_agent`) rather
 * than from accumulated in-process counters, so the numbers survive a restart
 * and can never drift from the tasks they describe.
 *
 * Archived tasks are included. They are exactly the completed work, so
 * excluding them would make cycle time silently improve as history is swept.
 */
export function getMetrics(project) {
  const scope =
    project === undefined || project === null || project === '' ? null : project;
  if (scope !== null && !isValidProjectId(scope)) return null;

  rebuildAggregates();

  const nowMs = Date.now();

  // Only `active_agents` depends on wall-clock lease expiry, so it must be
  // recomputed per read. Everything else (counts, by_status, reclaims, sorted
  // cycle samples) is served from the cached metric bases rebuilt only on a
  // committed mutation. `active_agents` scans only live tasks, never archive,
  // so it stays O(live) even as archive history grows unbounded.
  const liveAgents = new Map(); // project -> Set<agent>
  for (const t of tasks) {
    if (scope !== null && t.project !== scope) continue;
    if (!t.assigned_agent) continue;
    const expiry = t.claim_expires_at ? Date.parse(t.claim_expires_at) : NaN;
    if (!Number.isNaN(expiry) && expiry > nowMs) {
      if (!liveAgents.has(t.project)) liveAgents.set(t.project, new Set());
      liveAgents.get(t.project).add(t.assigned_agent);
    }
  }

  // Build the per-project result list from cached bases (or an empty base for a
  // valid-but-unknown scope), overlaying the live `active_agents`.
  const bases = [];
  if (scope !== null) {
    const cached = cachedMetricBases.get(scope);
    bases.push(cached ? { ...cached } : emptyBase(scope));
  } else {
    for (const m of cachedMetricBases.values()) bases.push({ ...m });
  }

  const projects = bases
    .map((m) => {
      const agents = [...(liveAgents.get(m.project) || [])].sort();
      return {
        project: m.project,
        task_count: m.task_count,
        live_count: m.live_count,
        archived_count: m.archived_count,
        done_count: m.done_count,
        completed_count: m.completed_count,
        by_status: { ...m.by_status },
        cycle_time: m.cycle_time,
        reclaim_count: m.reclaim_count,
        reclaimed_task_count: m.reclaimed_task_count,
        active_agents: agents,
        active_agent_count: agents.length,
        claim_contention: {
          conflicts: contentionCounts.get(m.project) || 0,
          since: contentionSince,
        },
      };
    })
    .sort((a, b) => a.project.localeCompare(b.project));

  // Aggregate over the scope. The unscoped aggregate's cycle time uses the
  // pre-sorted union of all cycle samples. For a scoped read the aggregate is
  // over exactly one project, so its cycle time equals that project's own
  // (already-computed, already-sorted) cycle time.
  const allAgents = new Set();
  for (const a of liveAgents.values()) for (const x of a) allAgents.add(x);

  const sum = (key) => projects.reduce((acc, m) => acc + m[key], 0);
  const aggregate = {
    project: null,
    project_count: projects.length,
    task_count: sum('task_count'),
    live_count: sum('live_count'),
    archived_count: sum('archived_count'),
    done_count: sum('done_count'),
    completed_count: sum('completed_count'),
    by_status: Object.fromEntries(
      VALID_STATUS_LIST.map((s) => [s, projects.reduce((acc, m) => acc + m.by_status[s], 0)]),
      ),
    cycle_time: scope !== null ? projects[0].cycle_time : cachedAggregateCycleTime,
    reclaim_count: sum('reclaim_count'),
    reclaimed_task_count: sum('reclaimed_task_count'),
    active_agents: [...allAgents].sort(),
    active_agent_count: allAgents.size,
    claim_contention: {
      conflicts: projects.reduce((acc, m) => acc + m.claim_contention.conflicts, 0),
      since: contentionSince,
    },
  };

  return { generated_at: new Date().toISOString(), scope, projects, aggregate };
}
