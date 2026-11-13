/**
 * C1 (v3.12.5) — the ONE home for store state.
 *
 * Before this split every mutable module-level binding (the live task array,
 * the composite index, the archive/trash/settings sinks, the mutation queue and
 * the aggregate-invalidation flag) lived in the 3.6k-line store.js. Extracting
 * leases, archiving, trash and the listener buses without moving the state made
 * every extracted module import store.js and every store.js path import it
 * back: a cycle, and two homes for the same array.
 *
 * So the state moved here, together with the primitives that REASSIGN it
 * (storage factory, mutation lock, index maintenance, load/reset markers, the
 * aggregate dirty flag, the mutation serial). Extracted modules import the
 * bindings (ESM live bindings: a reassignment here is visible to every
 * importer) and store.js re-exports the accessors, so all 54 test files that
 * import from ../store.js keep working unchanged.
 *
 * Never assign an imported binding from another module — call the setter below.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStorage, GitYamlStorage } from '../storage.js';
import {
  isValidProjectId,
  defaultProjectName,
  normalizeProject,
  resolveProjectScope,
  gitRoot,
  jsonDataDir,
} from '../task-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ENH-11 (v2.10.0): Atomic File Operations + Project/Workspace namespacing
// live in ../task-identity.js and are re-exported by store.js.

export function compositeKey(project, id) {
  return `${project}/${id}`;
}

// ============================================================================
// Store State & API
// ============================================================================

let storage = null;
export let storeLoaded = false;    // true once loadStore() has completed (§health read-only)
export let tasks = [];             // every live task across all projects
export let archive = {};           // project -> Task[] (archived, not in `tasks`)
export const index = new Map();    // `${project}/${id}` -> Task   (O(1) composite lookup)
const storageCache = new Map(); // project -> per-project storage instance
let mutationQueue = Promise.resolve();

// v2.5.0: per-project display settings (column colors). Maps project -> raw
// saved settings object; resolution (board default -> project override) happens
// at read time in getSettings().
export let projectSettings = new Map();

// v2.5.6 (ENH-03): trash sink. project -> Task[] (soft-deleted, not live).
export let trash = {};
export function withMutationLock(operation) {
  const run = mutationQueue.then(() => operation(), () => operation());
  mutationQueue = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Incremental aggregate cache (Pipeline C)
// ---------------------------------------------------------------------------
//
// getProjectSummaries() and getMetrics() are hot observability endpoints that
// used to scan every live task AND every archive entry on each call. That cost
// grows without bound as archive history accumulates. Instead we cache the
// task-derived aggregates and rebuild them lazily only after a committed
// mutation (create/patch/claim/reclaim/archive/unlock), so a clean read is
// O(projects) instead of O(live + archive). The two time/event-dependent bits
// — `active_agents` (lease expiry vs now) and `claim_contention` (since-boot
// map) — are still resolved at read time, matching the original semantics.
//
// `aggregatesDirty` is set by the same serialized mutation paths that touch
// state (updateInMemoryTask / removeFromMemory / rebuildIndex), so the cache
// never observes a torn state. Cold start is handled by rebuildIndex marking
// the cache dirty on load.
// The derived CACHES live in ./aggregates.js (only that module reads them);
// this flag is the single invalidation signal the mutation paths below set.
export let aggregatesDirty = true;

// ---------------------------------------------------------------------------
// Storage factory (per-project, cached)
// ---------------------------------------------------------------------------

// ENH-11 (v2.10.0): gitRoot() / jsonDataDir() moved to ./task-identity.js
// (re-exported at the top of this file).

export function getStorage(project) {
  const p = project === undefined ? defaultProjectName() : normalizeProject(project);
  if (storageCache.has(p)) return storageCache.get(p);

  const backend = process.env.KANBAN_STORAGE_BACKEND || 'json';
  let inst;
  if (backend === 'git') {
    const root = gitRoot();
    const autoCommit = process.env.KANBAN_GIT_COMMIT !== 'false';
    if (p === defaultProjectName()) {
      // Default project reuses the flat legacy root.
      inst = new GitYamlStorage(root, { autoCommit, rootPath: root, project: p });
    } else {
      inst = new GitYamlStorage(path.join(root, p), { autoCommit, rootPath: root, project: p });
    }
  } else {
    if (p === defaultProjectName()) {
      // Default project reuses KANBAN_DATA_FILE / server/tasks.json unchanged.
      // __dirname is server/store/ now; the legacy default lives one level up.
      const live = process.env.KANBAN_DATA_FILE || path.join(__dirname, '..', 'tasks.json');
      inst = new JsonStorage(live, { project: p, isDefault: true });
    } else {
      const live = path.join(jsonDataDir(), 'tasks', `${p}.json`);
      inst = new JsonStorage(live, { project: p, isDefault: false });
    }
  }

  storageCache.set(p, inst);
  return inst;
}

export function setStorage(newStorage, project) {
  if (newStorage === null || newStorage === undefined) {
    storage = null;
    storageCache.clear();
    return;
  }
  if (project === undefined) {
    // Bind to the default project (preserves the existing test contract where
    // every project is the implicit single project).
    storage = newStorage;
    storageCache.set(defaultProjectName(), newStorage);
  } else {
    const p = normalizeProject(project);
    storageCache.set(p, newStorage);
  }
}

// ---------------------------------------------------------------------------
// Enumeration helpers
// ---------------------------------------------------------------------------

export async function listJsonProjects() {
  const dir = path.join(jsonDataDir(), 'tasks');
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  // A project that has only journaled writes (no compacted base yet) has just
  // `<p>.json.journal.jsonl`; discover it too, deduplicated.
  const JOURNAL_SUFFIX = '.json.journal.jsonl';
  const ids = new Set();
  for (const f of entries) {
    let id = null;
    if (f.endsWith(JOURNAL_SUFFIX)) id = f.slice(0, -JOURNAL_SUFFIX.length);
    else if (f.endsWith('.json')) id = f.slice(0, -5);
    if (id !== null && isValidProjectId(id)) ids.add(id);
  }
  return [...ids];
}

export async function listGitProjects(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // BUG-06 (v2.7.0): a blanket `entry.name === 'archive'` skip made a real
    // git project literally named `archive` invisible after restart. The
    // archive SINK dir (`<root>/archive/`) holds only per-project SUBDIRECTORIES
    // and no direct `.yml`, so the `files.some(yml)` check below already
    // excludes it. Only dotfiles are skipped here.
    if (entry.name.startsWith('.')) continue;
    let files;
    try {
      files = await readdir(path.join(root, entry.name));
    } catch {
      continue;
    }
    if (files.some((f) => (f.endsWith('.yml') || f.endsWith('.yaml')) && !f.startsWith('.'))) {
      projects.push(entry.name);
    }
  }
  return projects;
}

// ---------------------------------------------------------------------------
// Index maintenance
// ---------------------------------------------------------------------------

export function rebuildIndex(loaded) {
  index.clear();
  tasks = loaded.slice();
  for (const t of tasks) {
    index.set(compositeKey(t.project, t.id), t);
  }
  invalidateAggregates();
}

export function updateInMemoryTask(updatedTask) {
  const key = compositeKey(updatedTask.project, updatedTask.id);
  index.set(key, updatedTask);
  const idx = tasks.findIndex((t) => t.id === updatedTask.id && t.project === updatedTask.project);
  if (idx >= 0) {
    tasks[idx] = updatedTask;
   } else {
    tasks.push(updatedTask);
   }
  invalidateAggregates();
}

/**
 * Test-only helper: install/replace a task's in-memory copy in place (no
 * persistence, no version bump, no notify). Used by tests to seed synthetic
 * states that are otherwise unreachable through the claim path (e.g. a held but
 * dependency-unmet task, which no legal claim can produce).
 */
export function setTaskInMemory(task) {
  updateInMemoryTask(task);
}

export function removeFromMemory(project, id) {
  index.delete(compositeKey(project, id));
  const idx = tasks.findIndex((t) => t.id === id && t.project === project);
  if (idx >= 0) tasks.splice(idx, 1);
  invalidateAggregates();
}

/**
 * Builds the live bucket for a project with `candidate` applied (replacing or
 * appending). Used for the partition-scoped save so only that project's file
 * (JSON) / card (Git) is rewritten.
 */
export function getProjectBucket(project) {
  return tasks.filter((t) => t.project === project);
}

export function projectBucket(project, candidate) {
  const out = tasks.filter((t) => t.project === project);
  const idx = out.findIndex((t) => t.id === candidate.id);
  if (idx >= 0) out[idx] = candidate;
  else out.push(candidate);
  return out;
}

/**
 * B1 (v3.12.3) — like `projectBucket`, but applies a BATCH of already-mutated
 * candidates to the project's live bucket. Used by `renewAllLeasesInner` so a
 * whole sibling-renewal sweep persists in ONE save per project with every
 * renewal applied.
 */
export function projectBucketFor(project, candidates) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return tasks
    .filter((t) => t.project === project)
    .map((t) => byId.get(t.id) ?? t);
}

// Mutation serials: notify() bumps the first on every committed batch; the
// archive sweep records the serial it last swept so a lazy read with no writes
// between can skip the sweep. Both are written only under the mutation lock.
let mutationSerial = 0;
let lastSweepSerial = -1; // first sweep always runs (boot + seed)

// ---------------------------------------------------------------------------
// C1 state setters — the only sanctioned way for another module to replace a
// whole binding (reassignment is illegal across an ESM import).
// ---------------------------------------------------------------------------

export function resetArchive() {
  archive = {};
}

export function resetTrash() {
  trash = {};
}

export function resetProjectSettings() {
  projectSettings = new Map();
}

export function markStoreLoaded() {
  storeLoaded = true;
}

export function invalidateAggregates() {
  aggregatesDirty = true;
}

export function markAggregatesClean() {
  aggregatesDirty = false;
}

export function bumpMutationSerial() {
  mutationSerial += 1;
}

export function getMutationSerial() {
  return mutationSerial;
}

export function getLastSweepSerial() {
  return lastSweepSerial;
}

export function setLastSweepSerial(serial) {
  lastSweepSerial = serial;
}

/**
 * Orders records most-recently-touched first.
 *
 * The board renders a lane top-to-bottom in the order the API returns, so the
 * list must be recency-ordered or "what just moved" is buried wherever the
 * record happened to sit in the array. `updated` is stamped on create and on
 * every mutation, so it is the right key. Falls back to created_at, then to
 * insertion into the returned copy for records that carry neither (legacy
 * data), so the comparison is total and stable.
 *
 * Sorts a COPY: `tasks` is the live in-memory array the store mutates.
 */
function byRecency(a, b) {
  const ka = Date.parse(a.updated ?? a.created_at ?? '');
  const kb = Date.parse(b.updated ?? b.created_at ?? '');
  const va = Number.isNaN(ka) ? -Infinity : ka;
  const vb = Number.isNaN(kb) ? -Infinity : kb;
  if (vb !== va) return vb - va;
  return 0;
}

export function getTasks(project) {
  // No filter -> all live projects (preserves current single-project behavior).
  if (project === undefined || project === null || project === '') return [...tasks].sort(byRecency);
  if (!isValidProjectId(project)) return [];
  return tasks.filter((t) => t.project === project).sort(byRecency);
}

export function getTask(id, project) {
  const { project: resolved, shortId } = resolveProjectScope(id, project);
  return index.get(compositeKey(resolved, shortId)) ?? null;
}

/**
 * B3 (v3.12.2): O(1) live-task count. The health probe only needs `.length`,
 * but the only accessor it had was getTasks() with no project — which sorts a
 * full COPY of the live set (O(n log n)) on every probe. Preferred over a
 * Pipeline-C cached count for determinism: `tasks` is the single live array.
 */
export function getTaskCount() {
  return tasks.length;
}

export function getArchivedTasks(project) {
  if (project === undefined || project === null || project === '') {
    let out = [];
    for (const list of Object.values(archive)) out = out.concat(list);
    return out;
  }
  return archive[project] || [];
}

// ---------------------------------------------------------------------------
// Optimistic concurrency (§2.6)
// ---------------------------------------------------------------------------

/**
 * Centralizes the version bump so every committed mutation advances the
 * task's monotonically-increasing `version` by exactly one. A task missing a
 * (or carrying a non-integer) version is treated as version 1, which keeps the
 * CAS total on legacy records that have not yet been backfilled.
 */
export function nextVersionFor(task) {
  const current = task && Number.isInteger(task.version) ? task.version : 1;
  return current + 1;
}

/**
 * Evaluates an optional expected-version guard supplied via a body
 * `expected_version` field or an `If-Match` header (RFC 7232 entity-tag).
 * Returns a 409 version-conflict payload when the supplied version differs
 * from the task's current version, or `null` when no guard was supplied so
 * callers that omit a version keep working unchanged.
 *
 * "No guard" means `undefined`/`null` ONLY. The route resolves `If-Match: ""`
 * (a valid empty entity-tag) and other unmatched validators to a provided
 * value, and those must conflict rather than disappear: treating `''` as
 * "absent" here silently disabled the CAS guard.
 *
 * The conflict error reads "Version mismatch" so it is distinguishable from
 * the claim-contention 409 ("… already claimed by …"): a version conflict is a
 * *stale read* while a contention conflict is *lost a race the caller knew
 * about*. Both carry a details object with the current vs. supplied version.
 */
export function versionConflict(task, rawExpected) {
  if (rawExpected === undefined || rawExpected === null) return null;
  const current = Number.isInteger(task.version) ? task.version : 1;
  // Strict: only a non-negative integer number or a plain decimal digit string
  // is a usable version. Booleans, arrays, hex/whitespace strings and the like
  // are never coerced - they are a version conflict.
  let provided = NaN;
  if (typeof rawExpected === 'number') {
    if (Number.isSafeInteger(rawExpected) && rawExpected >= 0) provided = rawExpected;
  } else if (typeof rawExpected === 'string' && /^\d+$/.test(rawExpected)) {
    provided = Number(rawExpected);
  }
  if (Number.isNaN(provided) || provided !== current) {
    return {
      error: 'Version mismatch',
      status: 409,
      details: { expected: current, provided: Number.isNaN(provided) ? rawExpected : provided },
    };
  }
  return null;
}
