import { readFile, writeFile, rename, mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'yaml';
import { escapeHtml } from './utils/sanitize.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Loop Statuses (KB-08) & State Machine (KB-01, KB-02)
// ============================================================================

export const STATUSES = {
  BACKLOG: 'BACKLOG',
  BUILDING: 'BUILDING',
  IN_REVIEW: 'IN_REVIEW',
  IN_TEST: 'IN_TEST',
  BLOCKED: 'BLOCKED',
  DONE: 'DONE',
};

export const VALID_STATUS_LIST = Object.values(STATUSES);

/**
 * Normalizes any status string (including legacy lowercase or aliases)
 * to canonical uppercase loop status.
 */
export function normalizeStatus(status) {
  if (!status || typeof status !== 'string') return null;
  const s = status.trim().toUpperCase();
  if (s === 'TODO') return STATUSES.BACKLOG;
  if (s === 'IN_PROGRESS') return STATUSES.BUILDING;
  if (VALID_STATUS_LIST.includes(s)) return s;
  return null;
}

export function isValidStatus(status) {
  return normalizeStatus(status) !== null;
}

/**
 * Valid transitions per loop protocol (spec Sec 2, Sec 9.4.3 KB-01):
 * BACKLOG -> BUILDING
 * BUILDING -> IN_REVIEW, BLOCKED
 * IN_REVIEW -> IN_TEST, BUILDING, BLOCKED
 * IN_TEST -> DONE, BUILDING, BLOCKED
 * BLOCKED -> BUILDING, IN_REVIEW, IN_TEST, BACKLOG
 * DONE -> terminal
 */
export const VALID_TRANSITIONS = {
  [STATUSES.BACKLOG]: [STATUSES.BUILDING, STATUSES.BLOCKED],
  [STATUSES.BUILDING]: [STATUSES.IN_REVIEW, STATUSES.BLOCKED],
  [STATUSES.IN_REVIEW]: [STATUSES.IN_TEST, STATUSES.BUILDING, STATUSES.BLOCKED],
  [STATUSES.IN_TEST]: [STATUSES.DONE, STATUSES.BUILDING, STATUSES.BLOCKED],
  [STATUSES.BLOCKED]: [STATUSES.BUILDING, STATUSES.IN_REVIEW, STATUSES.IN_TEST, STATUSES.BACKLOG],
  [STATUSES.DONE]: [],
};

export function canTransition(fromStatus, toStatus) {
  const from = normalizeStatus(fromStatus);
  const to = normalizeStatus(toStatus);
  if (!from || !to) return false;
  if (from === to) return true;
  const allowed = VALID_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

/**
 * Role ownership rules (spec Sec 1, Sec 3.2, Sec 9.4.3 KB-02):
 * - builder: may set BUILDING, IN_REVIEW
 * - reviewer: may set IN_TEST or return to BUILDING
 * - tester: may set DONE or return to BUILDING
 * - runner / system / human: may set/clear BLOCKED and administer transitions
 */
export function canRoleTransition(role, fromStatus, toStatus) {
  const from = normalizeStatus(fromStatus);
  const to = normalizeStatus(toStatus);
  if (!from || !to) return false;
  if (from === to) return true;

  const r = typeof role === 'string' ? role.toLowerCase() : null;
  if (['runner', 'system', 'human', 'admin'].includes(r)) {
    return true;
  }

  // BLOCKED transition is runner-only (spec Sec 3.2), no active role sets it manually
  if (to === STATUSES.BLOCKED) {
    return false;
  }

  if (r === 'builder') {
    return [STATUSES.BUILDING, STATUSES.IN_REVIEW].includes(to);
  }

  if (r === 'reviewer') {
    return [STATUSES.IN_TEST, STATUSES.BUILDING].includes(to);
  }

  if (r === 'tester') {
    return [STATUSES.DONE, STATUSES.BUILDING].includes(to);
  }

  return false;
}

// ============================================================================
// Injectable clock (§2.4) — all lease math goes through nowFn() so tests can
// force expiry deterministically. Pass undefined to restore the wall clock.
// ============================================================================
let nowFn = () => Date.now();

export function setNowFn(fn) {
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
}

// ============================================================================
// Lease / reaper / auto-promote config (§2.4 / §2.5) — read at call time so a
// test suite can override per-suite via env. (Minor deviation from the plan's
// "cache at load": call-time reads are correct for env-toggle tests.)
// ============================================================================
function getClaimTtlMs() {
  const raw = process.env.KANBAN_CLAIM_TTL_MS;
  if (raw === undefined || raw === '') return 300000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 300000;
}

function getReapIntervalMs() {
  const raw = process.env.KANBAN_REAP_INTERVAL_MS;
  if (raw === undefined || raw === '') return 30000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 30000;
}

export function isReaperEnabled() {
  const raw = process.env.KANBAN_REAP_ENABLED;
  if (raw === undefined || raw === '') return true;
  return raw !== 'false' && raw !== '0';
}

function isAutoPromoteEnabled() {
  const raw = process.env.KANBAN_AUTO_PROMOTE;
  if (raw === undefined || raw === '') return true;
  return raw !== 'false' && raw !== '0';
}

function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

// ============================================================================
// Atomic File Operations (KB-05)
// ============================================================================

export async function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, filePath);
}

// ============================================================================
// Project / Workspace namespacing (§2.1)
// ============================================================================

// Project ids are confined to a strict charset so they cannot introduce path
// traversal into `<project>.json` or `<project>/<id>.yml` filenames.
const PROJECT_ID_RE = /^[A-Za-z0-9_-]+$/;
const TASK_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isValidProjectId(id) {
  return typeof id === 'string' && PROJECT_ID_RE.test(id);
}

export function isValidTaskId(id) {
  return typeof id === 'string' && TASK_ID_RE.test(id);
}

/**
 * The implicit project that single-project deployments live in. Its storage
 * reuses the legacy location (KANBAN_DATA_FILE / flat git root) so a single
 * project deployment is byte-for-byte unchanged.
 */
export function defaultProjectName() {
  const p = process.env.KANBAN_DEFAULT_PROJECT;
  return isValidProjectId(p) ? p : 'default';
}

/**
 * Coerces an input to a canonical project name. Invalid / empty input falls
 * back to the default project so lookups are total.
 */
export function normalizeProject(project, fallback) {
  const fb = fallback || defaultProjectName();
  if (project === undefined || project === null || project === '') return fb;
  if (isValidProjectId(project)) return project;
  return fb;
}

/**
 * Resolves the {project, shortId} pair for a lookup. Accepts three forms:
 *   getTask('foo')            -> default/foo
 *   getTask('foo', 'atlas')   -> atlas/foo
 *   getTask('atlas:foo')      -> atlas/foo  (composite, project wins on first ':')
 */
export function resolveProjectScope(id, projectArg) {
  let project = projectArg;
  let shortId = id;
  if (typeof id === 'string' && id.includes(':')) {
    const idx = id.indexOf(':');
    const maybeProject = id.slice(0, idx);
    const rest = id.slice(idx + 1);
    if (isValidProjectId(maybeProject) && rest.length > 0) {
      project = maybeProject;
      shortId = rest;
    }
  }
  project = normalizeProject(project);
  return { project, shortId };
}

function compositeKey(project, id) {
  return `${project}/${id}`;
}

// ============================================================================
// Pluggable Storage Backends (KB-09) — partitioned per project (§2.1/§2.8)
// ============================================================================

/**
 * Backfills the lease fields (§2.4) + CAS version (§2.6) on records loaded from
 * a JSON sink that predates them: `claim_expires_at` -> null, `reclaim_count` ->
 * 0, `version` -> 1. Additive so legacy data is total without a migration step.
 */
function backfillLeaseFields(list) {
  for (const t of list) {
    if (!Number.isInteger(t.version)) t.version = 1;
    if (t.claim_expires_at === undefined) t.claim_expires_at = null;
    if (t.reclaim_count === undefined) t.reclaim_count = 0;
  }
  return list;
}

export class JsonStorage {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    // project may be undefined (legacy default), 'default', or a named project.
    this.project = options.project;
    this.isDefault = options.isDefault === true || !this.project || this.project === defaultProjectName();
    // Archive lives in a sibling `archive/` directory next to the tasks dir.
    const dir = path.dirname(filePath);
    this.archiveFile = path.join(dir, 'archive', `${this.project || defaultProjectName()}.json`);
  }

  async load() {
    try {
      if (!existsSync(this.filePath)) {
        return [];
      }
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
       // §2.6: legacy JSON records predate the CAS version field; backfill to 1
       // so the first patch bumps a well-defined baseline.
      const list = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      backfillLeaseFields(list);
      return list;
    } catch (err) {
      console.warn(`[kanban JsonStorage] load error: ${err.message} — starting empty`);
      return [];
    }
  }

  async save(tasks) {
    // Default project keeps the legacy `{ tasks: [...] }` shape so an existing
    // single-project file is byte-for-byte compatible. Named partitions embed
    // the project name so the partition is self-describing.
    const payload = this.isDefault
      ? { tasks }
      : { project: this.project, tasks };
    await writeAtomic(this.filePath, JSON.stringify(payload, null, 2));
  }

  async saveTask(task, allTasks) {
    await this.save(allTasks);
  }

  async deleteTask(task, survivors) {
    await this.save(survivors);
  }

  async loadArchive() {
    try {
      if (!existsSync(this.archiveFile)) return [];
      const parsed = JSON.parse(await readFile(this.archiveFile, 'utf-8'));
       // §2.6: backfill version 1 on legacy archived JSON records.
      const list = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      backfillLeaseFields(list);
      return list;
    } catch (err) {
      console.warn(`[kanban JsonStorage] loadArchive error: ${err.message} — starting empty`);
      return [];
    }
  }

  async saveArchive(tasks) {
    const payload = {
      project: this.project || defaultProjectName(),
      archived_at: new Date().toISOString(),
      tasks,
    };
    await writeAtomic(this.archiveFile, JSON.stringify(payload, null, 2));
  }
}

export class GitYamlStorage {
  constructor(dirPath, options = {}) {
    this.dir = dirPath;
    this.root = options.rootPath || dirPath;
    // this.project is the owning project; undefined means "write flat at root"
    // (the legacy / default behaviour).
    this.project = options.project;
    this.autoCommit = options.autoCommit !== false;
  }

  get ownedProject() {
    return this.project || defaultProjectName();
  }

  get isDefaultProject() {
    return !this.project || this.project === defaultProjectName();
  }

  async load() {
    try {
      await mkdir(this.dir, { recursive: true });
      const entries = await readdir(this.dir);
      const yamlFiles = entries.filter(
        (f) => (f.endsWith('.yml') || f.endsWith('.yaml')) && !f.startsWith('.')
      );

      const tasks = [];
      for (const file of yamlFiles) {
        try {
          const raw = await readFile(path.join(this.dir, file), 'utf-8');
          const parsed = yaml.parse(raw);
          if (parsed && parsed.id) {
            backfillLeaseFields([parsed]);
            tasks.push(parsed);
           }
        } catch (err) {
          console.warn(`[kanban GitYamlStorage] error reading ${file}: ${err.message}`);
        }
      }
      return tasks;
    } catch (err) {
      console.warn(`[kanban GitYamlStorage] load error: ${err.message}`);
      return [];
    }
  }

  async loadArchive() {
    const archDir = path.join(this.root, 'archive', this.ownedProject);
    try {
      await mkdir(archDir, { recursive: true });
      const entries = await readdir(archDir);
      const files = entries.filter(
        (f) => (f.endsWith('.yml') || f.endsWith('.yaml')) && !f.startsWith('.')
      );
      const tasks = [];
      for (const file of files) {
        try {
          const raw = await readFile(path.join(archDir, file), 'utf-8');
          const parsed = yaml.parse(raw);
          if (parsed && parsed.id) {
            backfillLeaseFields([parsed]);
            tasks.push(parsed);
            }
         } catch (err) {
          console.warn(`[kanban GitYamlStorage] archive read ${file}: ${err.message}`);
         }
       }
      return tasks;
     } catch (err) {
      console.warn(`[kanban GitYamlStorage] loadArchive error: ${err.message}`);
      return [];
     }
   }

  async saveTask(task) {
    await mkdir(this.dir, { recursive: true });
    if (!Number.isInteger(task.round) || task.round < 1) {
      throw new Error('Git-backed task persistence requires a positive integer round');
    }
    const filename = `${task.id}.yml`;
    const filePath = path.resolve(this.dir, filename);
    // Traversal guard, extended to the intermediate `<project>` directory level:
    // the resolved path must remain inside the git root.
    const targetDir = path.resolve(this.root);
    if (!filePath.startsWith(targetDir + path.sep) && filePath !== targetDir) {
      throw new Error(`Path traversal attempt detected in task id: ${task.id}`);
    }

    const status = task.status;
    const cardData = this.serializeCard(task, status);
    const ymlContent = yaml.stringify(cardData);
    await writeAtomic(filePath, ymlContent);

    if (this.autoCommit) {
      await this._tryGitCommit(task, filename);
    }
  }

  serializeCard(task, status) {
    const cardData = {
      id: task.id,
      project: this.ownedProject,
      title: task.title,
      status: task.status,
      branch: task.branch || `task/${task.id}`,
      depends_on: task.depends_on || [],
      round: task.round,
      issues: task.issues || [],
      assigned_agent: task.assigned_agent ?? null,
      created_at: task.created_at || task.updated || new Date().toISOString(),
      completed_at: task.completed_at,
      updated: task.updated || new Date().toISOString(),
      description: task.description || '',
      priority: task.priority || 'medium',
      agent_logs: task.agent_logs || [],
      metadata: task.metadata || {},
        // §2.6: persist the CAS version; default to 1 for legacy cards.
      version: task.version ?? 1,
       // §2.4: persist lease + reclaim observability so a git card round-trips
      // them; default to null/0 for legacy cards.
      claim_expires_at: task.claim_expires_at ?? null,
      reclaim_count: task.reclaim_count ?? 0,
       };
    if (task.archived_at) cardData.archived_at = task.archived_at;
    return cardData;
  }

  async saveArchiveTask(task) {
    const p = this.ownedProject;
    const archDir = path.join(this.root, 'archive', p);
    await mkdir(archDir, { recursive: true });
    const filename = `${task.id}.yml`;
    const filePath = path.resolve(archDir, filename);
    const targetDir = path.resolve(this.root);
    if (!filePath.startsWith(targetDir + path.sep) && filePath !== targetDir) {
      throw new Error(`Path traversal attempt detected in archive task id: ${task.id}`);
    }
    const archived = Object.assign({}, task, { archived_at: task.archived_at || new Date().toISOString() });
    const ymlContent = yaml.stringify(this.serializeCard(archived, STATUSES.DONE));
    await writeAtomic(filePath, ymlContent);

    if (this.autoCommit) {
      // git rm the live card if it is tracked; the archive entry replaces it.
      try {
        if (existsSync(path.join(this.dir, filename))) {
          await execFileAsync('git', ['rm', '-f', '--ignore-unmatch', filename], { cwd: this.dir });
        }
      } catch {
        // Untracked / already removed: ignore, the archive write is authoritative.
      }
      const relativeArchive = path.join('archive', p, filename);
      await execFileAsync('git', ['add', relativeArchive], { cwd: this.root });
      const composite = this.isDefaultProject ? task.id : `${this.project}/${task.id}`;
      const commitMsg = `ops(archive): ${composite} DONE at ${archived.archived_at}`;
      await execFileAsync('git', ['commit', '-m', commitMsg], { cwd: this.root });
    }
  }

  async save(tasks) {
    for (const task of tasks) {
      await this.saveTask(task);
    }
  }

  async deleteTask(task) {
    await mkdir(this.dir, { recursive: true });
    const filename = `${task.id}.yml`;
    const filePath = path.resolve(this.dir, filename);
    // Traversal guard, mirroring saveTask/saveArchiveTask: the resolved path
    // must remain inside the git root.
    const targetDir = path.resolve(this.root);
    if (!filePath.startsWith(targetDir + path.sep) && filePath !== targetDir) {
      throw new Error(`Path traversal attempt detected in task id: ${task.id}`);
    }
    if (existsSync(filePath)) {
      await execFileAsync('git', ['rm', '-f', '--ignore-unmatch', filename], { cwd: this.dir });
    }
    if (this.autoCommit) {
      const composite = this.isDefaultProject ? task.id : `${this.project}/${task.id}`;
      const commitMsg = `ops(${composite}): kanban deleted`;
      await execFileAsync('git', ['commit', '-m', commitMsg], { cwd: this.root });
    }
  }

  async _tryGitCommit(task, filename) {
    try {
      await execFileAsync('git', ['add', filename], { cwd: this.dir });
      const composite = this.isDefaultProject ? task.id : `${this.project}/${task.id}`;
      const commitMsg = `ops(${composite}): kanban ${task.status}`;
      await execFileAsync('git', ['commit', '-m', commitMsg], { cwd: this.dir });
    } catch (err) {
      throw new Error(`Git-backed persistence commit failed: ${err.message}`, { cause: err });
    }
  }
}

// ============================================================================
// Store State & API
// ============================================================================

let storage = null;
let storeLoaded = false;    // true once loadStore() has completed (§health read-only)
let tasks = [];             // every live task across all projects
let archive = {};           // project -> Task[] (archived, not in `tasks`)
let listeners = [];
const index = new Map();    // `${project}/${id}` -> Task   (O(1) composite lookup)
const storageCache = new Map(); // project -> per-project storage instance
let mutationQueue = Promise.resolve();

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
let aggregatesDirty = true;
let cachedSummaries = null;   // sorted array result of getProjectSummaries()
let cachedMetricBases = null; // Map<project, baseMetric> (counts + sorted cycles)
let cachedAggregateCycleTime = null; // summarizeDurations(all cycle samples)

function invalidateAggregates() {
  aggregatesDirty = true;
}

// ---------------------------------------------------------------------------
// Storage factory (per-project, cached)
// ---------------------------------------------------------------------------

function gitRoot() {
  return (
    process.env.KANBAN_GIT_DIR ||
    process.env.KANBAN_DATA_DIR ||
    path.resolve(__dirname, '../../agent-based-investment/ops/kanban')
  );
}

function jsonDataDir() {
  return (
    process.env.KANBAN_DATA_DIR ||
    process.env.KANBAN_GIT_DIR ||
    path.resolve(__dirname, '../../agent-based-investment/ops/kanban')
  );
}

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
      const live = process.env.KANBAN_DATA_FILE || path.join(__dirname, 'tasks.json');
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

async function listJsonProjects() {
  const dir = path.join(jsonDataDir(), 'tasks');
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.json') && isValidProjectId(f.slice(0, -5)))
    .map((f) => f.slice(0, -5));
}

async function listGitProjects(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'archive') continue;
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

function rebuildIndex(loaded) {
  index.clear();
  tasks = loaded.slice();
  for (const t of tasks) {
    index.set(compositeKey(t.project, t.id), t);
  }
  invalidateAggregates();
}

function updateInMemoryTask(updatedTask) {
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

function removeFromMemory(project, id) {
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

function projectBucket(project, candidate) {
  const out = tasks.filter((t) => t.project === project);
  const idx = out.findIndex((t) => t.id === candidate.id);
  if (idx >= 0) out[idx] = candidate;
  else out.push(candidate);
  return out;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export async function loadStore() {
  const backend = process.env.KANBAN_STORAGE_BACKEND || 'json';
  const dp = defaultProjectName();
  const loaded = [];
  const projectSet = new Set([dp]);

  if (backend === 'git') {
    const root = gitRoot();
    const defaultLive = await getStorage(dp).load();
    loaded.push(...defaultLive);
    for (const p of await listGitProjects(root)) {
      if (p === dp) continue;
      projectSet.add(p);
      const live = await getStorage(p).load();
      loaded.push(...live);
    }
  } else {
    const defaultLive = await getStorage(dp).load();
    loaded.push(...defaultLive);
    for (const p of await listJsonProjects()) {
      if (p === dp) continue;
      projectSet.add(p);
      const live = await getStorage(p).load();
      loaded.push(...live);
    }
  }

  // Legacy backfill: every record gains a canonical project + age anchors so the
  // index and archive ageing are total on legacy data.
  const nowIso = new Date().toISOString();
  for (const t of loaded) {
    t.project = t.project && isValidProjectId(t.project) ? t.project : dp;
    if (!t.created_at) t.created_at = t.updated || nowIso;
    if (t.status === STATUSES.DONE && !t.completed_at) {
      t.completed_at = t.updated || t.created_at || nowIso;
     }
     // §2.6: legacy records that predate versioning start at version 1 so the
     // CAS guard is total and a first patch bumps to 2.
     if (!Number.isInteger(t.version)) t.version = 1;
     // §2.4: backfill lease fields so the reaper math is total on legacy data.
     if (t.claim_expires_at === undefined) t.claim_expires_at = null;
     if (t.reclaim_count === undefined) t.reclaim_count = 0;
     }

  rebuildIndex(loaded);

  // Load per-project archives.
  archive = {};
  for (const p of projectSet) {
    try {
      const a = await getStorage(p).loadArchive();
      if (a && a.length) archive[p] = a;
    } catch (err) {
      console.warn(`[kanban] archive load error for ${p}: ${err.message}`);
    }
  }

  await runArchiveSweep();
  storeLoaded = true;
  notify();
}

/**
 * Read-only liveness signal: true once `loadStore()` has completed. The health
 * endpoint derives `store_loaded` from this without mutating anything.
 */
export function isStoreLoaded() {
  return storeLoaded;
}

// §2.2 diff-event layer: on each notify(), compute created/updated/removed vs the
// previous snapshot, then dispatch {kind, task, prev?, project} events to
// diffListeners. Backward-compat: full-snapshot `onChange` listeners still see
// every mutation, unmodified.
let diffListeners = [];
let prevTaskMap = new Map(); // `${project}/${id}` -> Task (previous snapshot)
let diffListenersInitialized = false;

/**
 * §2.2 — register a diff listener. Receives `{ kind, task, prev?, project }` on
 * every mutation where something changed. `kind` is one of
 * 'created' | 'updated' | 'removed' | 'archived'. Returns unsubscribe.
 */
export function onDiff(listener) {
  diffListeners.push(listener);
  return () => {
    diffListeners = diffListeners.filter((l) => l !== listener);
   };
}

/**
 * §2.9 — structured audit-log entry for every committed mutation. Shape:
 *   { ts, kind, project, task, prev?, actor, reason? }
 * `kind` mirrors the diff layer. `actor` is the mutating agent (system for
 * reaper/unlock/archive). `reason` carries a short human-readable cause (e.g.
 * 'lease_expired', 'unblocked', 'archived'...). This is the substrate for
 * §2.9 metrics + audit; today it's just a console line.
 */
let auditListeners = [];
export function onAudit(fn) {
  if (typeof fn !== 'function') throw new Error('onAudit listener must be a function');
  auditListeners.push(fn);
  return () => {
    auditListeners = auditListeners.filter((f) => f !== fn);
   };
}

export function emitAudit(entry) {
  for (const fn of [...auditListeners]) {
    try {
      fn(entry);
    } catch (err) {
      console.error('[kanban audit] listener error:', err);
    }
  }
  // Default: console line. Best-effort, must not throw.
  try {
    console.log(
      `[kanban audit] ${entry.ts} ${entry.kind} ${entry.project}/${entry.task ? entry.task.id : 'n/a'} ` +
        `actor=${entry.actor || 'anon'}${entry.reason ? ' reason=' + entry.reason : ''}`
     );
  } catch {/* ignore */}
}

// Dispatch structured diff events computed from the previous vs current task
// map. `opts.semantic` is a Map of `${project}/${id}` -> { kind, reason, actor }
// used to override the inferred kind for a specific mutated task (e.g. a claim
// surfaces as 'claimed' not 'updated'). One event per changed task, never two.
function dispatchDiffEvents({ actor = 'user', reason = null, semantic = null } = {}) {
  if (!diffListenersInitialized) {
    prevTaskMap = new Map(tasks.map((t) => [
      compositeKey(t.project, t.id), t,
      ]));
    diffListenersInitialized = true;
    return;
    }
  const now = new Map(tasks.map((t) => [
    compositeKey(t.project, t.id), t,
    ]));
  const tsMs = Date.now();

  const fire = (key, kind, task, prev, evActor, evReason) => {
    const event = {
      kind, task, prev: prev || null, project: task?.project,
      actor: evActor || actor, reason: evReason ?? reason, ts: tsMs,
      };
    for (const l of [...diffListeners]) {
      try { l(event); } catch (err) {
        console.error('[kanban diff] listener error:', err);
        }
      }
    emitAudit({
      ts: new Date(tsMs).toISOString(), kind,
      project: task?.project, task, prev: prev || null,
      actor: evActor || actor, reason: evReason ?? reason,
      });
   };

    // Removed: present previously, gone now. The archive sweep drops rows from
    // the live set, so an archived task lands here — a semantic override is the
    // only way it can surface as 'archived' rather than a bare 'removed'.
   for (const [key, prevTask] of prevTaskMap) {
    if (!now.has(key)) {
      const sev = semantic && semantic.get(key);
      if (sev) {
        fire(key, sev.kind, sev.task || prevTask, prevTask, sev.actor, sev.reason);
        continue;
        }
      fire(key, 'removed', prevTask, prevTask, actor, reason);
      }
    }
    // Created + updated: present now.
   for (const [key, task] of now) {
    const prevTask = prevTaskMap.get(key) || null;
     // A supplied semantic override wins for this exact task.
    const sev = semantic && semantic.get(key);
    if (sev) {
      fire(key, sev.kind, task, prevTask, sev.actor, sev.reason);
      continue;
     }
    // Unchanged rows must stay silent: without this, every mutation fanned out
    // one 'updated' per task in the store. Mutation paths are copy-on-write
    // (setTaskInMemory swaps the object), so identity is the change signal —
    // and a semantic override above already fired unconditionally, so the
    // claim/renew/unblock/reclaim paths never depend on this check.
    if (prevTask === task) continue;
    // 'archived' is never inferred here: archiving removes the row from the
    // live set, so it is emitted from the removed branch via a semantic
    // override. Inferring it from a DONE->DONE transition mislabelled every
    // ordinary edit of a done task.
    const kind = prevTask ? 'updated' : 'created';
    fire(key, kind, task, prevTask, actor, reason);
   }
  prevTaskMap = now;
}

/**
 * §2.2/§2.9 — notify snapshot listeners (unchanged shape, backward-compat) and
 * layer the structured diff + audit. Optional semantic metadata:
 *   actor  — who caused this mutation ('builder-x', 'system', ...)
 *   reason — short human cause ('lease_expired', 'unblocked', 'archived')
 *   semantic — Map`${project}/${id}` -> { kind, actor, reason } to override the
 *              inferred kind for a specific mutated task (claim -> 'claimed',
 *              reclaim -> 'reclaimed', unlock -> 'unblocked').
 */
export function notify(opts = {}) {
  const snapshot = tasks;
   for (const listener of listeners) {
    try {
      listener(snapshot);
      } catch (err) {
       console.error('[kanban] listener error:', err);
       }
     }
   dispatchDiffEvents(opts);
}

/**
 * Live listener counts. Exists so a leak is testable: the SSE handler
 * subscribes per connection and unsubscribes on `req.on('close')`, and the
 * §2.10 project switcher re-subscribes on every project change — so
 * open/close has to balance or a long session accumulates dead sockets.
 */
export function listenerCounts() {
  return {
    snapshot: listeners.length,
    diff: diffListeners.length,
    audit: auditListeners.length,
  };
}

export function onChange(listener) {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
   };
}

export function getTasks(project) {
  // No filter -> all live projects (preserves current single-project behavior).
  if (project === undefined || project === null || project === '') return tasks;
  if (!isValidProjectId(project)) return [];
  return tasks.filter((t) => t.project === project);
}

export function getTask(id, project) {
  const { project: resolved, shortId } = resolveProjectScope(id, project);
  return index.get(compositeKey(resolved, shortId)) ?? null;
}

export function getArchivedTasks(project) {
  if (project === undefined || project === null || project === '') {
    let out = [];
    for (const list of Object.values(archive)) out = out.concat(list);
    return out;
  }
  return archive[project] || [];
}

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
  aggregatesDirty = false;
}

export function getProjectSummaries() {
  rebuildAggregates();
  return cachedSummaries;
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

function recordClaimContention(project) {
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
 * `expected_version` field or an `If-Match` header (Etag-style bare int).
 * Returns a 409 version-conflict payload when the supplied version differs
 * from the task's current version, or `null` when no guard was supplied so
 * callers that omit a version keep working unchanged.
 *
 * The conflict error reads "Version mismatch" so it is distinguishable from
 * the claim-contention 409 ("… already claimed by …"): a version conflict is a
 * *stale read* while a contention conflict is *lost a race the caller knew
 * about*. Both carry a details object with the current vs. supplied version.
 */
function versionConflict(task, rawExpected) {
  if (rawExpected === undefined || rawExpected === null || rawExpected === '') return null;
  const current = Number.isInteger(task.version) ? task.version : 1;
  const provided = Number(rawExpected);
  if (Number.isNaN(provided) || provided !== current) {
    return {
      error: 'Version mismatch',
      status: 409,
      details: { expected: current, provided: Number.isNaN(provided) ? rawExpected : provided },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Creations & mutations (project-scoped)
// ---------------------------------------------------------------------------

/**
 * Creates a task (spec Sec 9.4.3 + §2.1 namespacing).
 * Uniqueness is composite (project/id); storage write is partition-scoped.
 */
export async function createTask(data = {}, projectArg) {
  return withMutationLock(async () => {
    if (!data.id || !data.title) {
      return { error: 'id and title are required', status: 400 };
    }

    // Project resolution: body.project > body.workspace_id (alias) > query/header arg.
    const rawProject = data.project ?? data.workspace_id ?? projectArg;
    let project;
    if (rawProject === undefined || rawProject === null || rawProject === '') {
      project = defaultProjectName();
    } else {
      project = rawProject;
      if (!isValidProjectId(project)) {
        return {
          error: `Invalid project id: ${project}`,
          status: 400,
        };
      }
    }

    if (!isValidTaskId(data.id)) {
      return {
        error: 'Invalid task id: must contain only alphanumeric characters, underscores, and hyphens',
        status: 400,
      };
    }

    // Composite uniqueness: two projects may share a short id.
    if (index.has(compositeKey(project, data.id))) {
      return { error: `Task ${compositeKey(project, data.id)} already exists`, status: 409 };
    }

    const status = normalizeStatus(data.status);
    if (!status) {
      return { error: `Invalid status: ${data.status}`, status: 400 };
    }
    if (!Number.isInteger(data.round) || data.round < 1) {
      return { error: 'round must be a positive integer', status: 400 };
    }

    const now = new Date().toISOString();
    const newTask = {
      id: data.id,
      project,
      title: escapeHtml(data.title),
      description: escapeHtml(data.description || ''),
      status,
      priority: data.priority || 'medium',
      branch: data.branch || `task/${data.id}`,
      depends_on: Array.isArray(data.depends_on) ? data.depends_on : [],
      round: data.round,
      issues: Array.isArray(data.issues) ? data.issues : [],
      assigned_agent: data.assigned_agent !== undefined ? data.assigned_agent : null,
      agent_logs: Array.isArray(data.agent_logs) ? data.agent_logs : [],
      metadata: data.metadata || {},
      created_at: now,
      completed_at: status === STATUSES.DONE ? now : undefined,
      updated: now,
      // §2.6: every task starts at version 1; committed mutations bump it.
      version: 1,
     };
    // workspace_id is an input alias only and must never be persisted.
    delete newTask.workspace_id;
     // Omit undefined fields from the persisted/returned record.
    if (newTask.completed_at === undefined) delete newTask.completed_at;

    // KB-05: mutate in memory only after the partition write lands.
    await getStorage(project).saveTask(newTask, projectBucket(project, newTask));
    updateInMemoryTask(newTask);
    notify();
    return { task: newTask, status: 201 };
  });
}

/**
 * Patches a task with state machine (KB-01) and role ownership (KB-02) checks.
 * `project` scopes the lookup; the task's own project is used when unspecified.
 * `project` itself is not mutable (400).
 */
export async function patchTask(id, patch, { caller = {}, project: projectArg } = {}) {
  return withMutationLock(async () => {
    const task = getTask(id, projectArg);
    if (!task) return { error: 'Task not found', status: 404 };

    if (patch && typeof patch === 'object' && 'project' in patch) {
      return { error: 'project is not mutable', status: 400 };
      }

      // §2.6: enforce the expected-version guard BEFORE building the candidate
      // so a stale read rejects without touching storage. The route injects the
      // If-Match header as `patch.expected_version`; a body-supplied field is
      // equivalent. A "Version mismatch" 409 is distinct from a claim-contention
      // 409 ("… already claimed by …").
    const conflict = versionConflict(task, patch.expected_version);
    if (conflict) return conflict;

    const candidate = structuredClone(task);
    const role = caller.role || patch.role || null;
       // §2.5: detect a *transition into DONE* so we can fire the completion hook
       // after this write commits. The pre-write status is the live task's status
       // (updateInMemoryTask has not run yet, so `task` still carries the old one).
    const wasStatus = task.status;
    if ('status' in patch) {
      const nextStatus = normalizeStatus(patch.status);
      if (!nextStatus) {
        return { error: `Invalid status: ${patch.status}`, status: 400 };
       }

      // KB-01: State machine transition check
      if (!canTransition(candidate.status, nextStatus)) {
        return {
          error: `Invalid state transition from ${candidate.status} to ${nextStatus}`,
          status: 409,
        };
      }

      // KB-02: Role ownership check
      if (!canRoleTransition(role, candidate.status, nextStatus)) {
        return {
          error: `Role '${role}' is not authorized to transition task from ${candidate.status} to ${nextStatus}`,
          status: 403,
        };
      }
      candidate.status = nextStatus;
     }

     // §2.8: anchor completion time on the transition into DONE.
    if (candidate.status === STATUSES.DONE && !candidate.completed_at) {
     candidate.completed_at = new Date().toISOString();
    }

    const allowed = [
      'title',
      'description',
      'priority',
      'branch',
      'depends_on',
      'round',
      'issues',
      'metadata',
    ];

    for (const key of allowed) {
      if (key in patch) {
        if ((key === 'title' || key === 'description') && typeof patch[key] === 'string') {
          candidate[key] = escapeHtml(patch[key]);
        } else {
          candidate[key] = patch[key];
        }
      }
    }

    candidate.updated = new Date().toISOString();
      // §2.6: a committed patch advances version by exactly one.
    candidate.version = nextVersionFor(task);
      // expected_version is a request-time guard only; never persist it.
    delete candidate.expected_version;

    const storage = getStorage(candidate.project);
    await storage.saveTask(candidate, projectBucket(candidate.project, candidate));
    updateInMemoryTask(candidate);
    notify();

    // §2.5 optional event-driven auto-promote: on a *transition into DONE*,
    // unlock any BLOCKED dependents whose last remaining dependency just
    // completed. Runs inside the same lock (so it is serialized with the other
    // writers), AFTER the main write has fully committed, and is best-effort —
    // an unlock/persistence failure is swallowed here so it can never reject or
    // roll back the completed write (the main write above is authoritative).
    // Toggleable via KANBAN_AUTO_PROMOTE. This is a documented system override
    // (like the reaper): BLOCKED -> BACKLOG is legal in canTransition but the
    // external patchTask allowlist cannot clear ownership/lease, hence the
    // dedicated unlockTask inner.
    const enteredDone = candidate.status === STATUSES.DONE && wasStatus !== STATUSES.DONE;
    if (enteredDone && isAutoPromoteEnabled()) {
      try {
        await maybeUnlockDependentsInner(candidate.id, Date.now());
       } catch (err) {
        console.error('[kanban] auto-promote unlock failed:', err && err.message);
      }
    }
    if (enteredDone) runCompletionHooks(candidate.id);

    return { task: candidate, status: 200 };
     });
}

// ---------------------------------------------------------------------------
// §2.4/§2.5/§2.7 — claim lease, dependency gate, fair queue
// ---------------------------------------------------------------------------

// Roles that may renew *any* task's lease (they administer the board), beyond
// the holder. builder/reviewer/tester are holders when they own the task.
const PRIVILEGED_ROLE_SET = new Set(['runner', 'system', 'human', 'admin']);

function isPrivilegedRole(role) {
  return typeof role === 'string' && PRIVILEGED_ROLE_SET.has(role.toLowerCase());
}

/**
 * §2.5 dependency gate. A dep is *satisfied* iff it resolves to a live task that
 * is DONE. A dangling dep id fails closed (treated as unresolved). Empty
 * `depends_on` ⇒ { ok: true }.
 */
export function dependencyGate(task) {
  const deps = Array.isArray(task.depends_on) ? task.depends_on : [];
  if (deps.length === 0) return { ok: true, unresolved: [] };
  const unresolved = [];
  for (const dep of deps) {
    const depTask = getTask(dep, task.project);
    if (!depTask || depTask.status !== STATUSES.DONE) unresolved.push(dep);
  }
  return { ok: unresolved.length === 0, unresolved };
}

/**
 * §2.7 priority rank for the fair claim queue: high < medium < low (ascending).
 * Unknown / absent priority defaults to medium (matching create-time default).
 */
export function priorityRank(priority) {
  if (priority === 'high' || priority === 'HIGH') return 0;
  if (priority === 'low' || priority === 'LOW') return 2;
  return 1;
}

/**
 * §2.4/§2.5/§2.7 shared claim core. Assumes the caller already holds the
 * mutation lock. Performs (in order):
 *   1. contention — a held task (assigned_agent !== agentId) is rejected with a
 *      plain 409 ("… already claimed by …"). This runs FIRST, so a held task
 *      returns the contention 409 even when its deps are also unsatisfied.
 *   2. dependency gate — a reason-tagged 409 (`reason: 'dependency_unsatisfied'`
 *      + `unresolved_dependencies[]`) distinct from contention.
 *   3. the write: set assigned_agent + claim_expires_at (now + TTL), lift
 *      BACKLOG → BUILDING, seed reclaim_count, push the claim log, persist.
 *
 * Pass `{ renew: true }` for a lease renewal: skip contention when the caller is
 * privileged (they may renew any lease), skip the dependency gate (the lease was
 * earned at a satisfied gate), do not move status, and push no log (no spam).
 */
async function applyClaim(task, agentId, caller, nowMs, { renew = false } = {}) {
  const role = caller?.role || null;
  const isPriv = isPrivilegedRole(role);

  // (1) contention — first, so held tasks win the ordering over the dep gate.
  if (!(renew && isPriv)) {
    if (task.assigned_agent && task.assigned_agent !== agentId) {
      // Only a live lease means two agents genuinely raced. A lapsed-but-
      // unreaped assignment (or one that never had a lease) is a crashed agent,
      // not contention — and with the reaper disabled a polling agent retrying
      // against it would inflate the metric without bound.
      const holderExpiry = task.claim_expires_at ? Date.parse(task.claim_expires_at) : NaN;
      if (!Number.isNaN(holderExpiry) && holderExpiry > nowMs) {
        recordClaimContention(task.project);
      }
      return {
        error: `Task ${task.id} is already claimed by ${task.assigned_agent}`,
        status: 409,
      };
    }
  }

  // (2) dependency gate — only on a fresh claim.
  if (!renew) {
    const gate = dependencyGate(task);
    if (!gate.ok) {
      return {
        error: 'Task has unsatisfied dependencies',
        status: 409,
        reason: 'dependency_unsatisfied',
        unresolved_dependencies: gate.unresolved,
      };
    }
  }

  // (3) write the claim / renewal.
  const candidate = structuredClone(task);
  // A fresh claim assigns ownership; a renewal (renew=true) only extends the
  // lease and MUST NEVER reassign — a privileged heartbeat must not take the
  // task's owner from the real holder. So `assigned_agent` is set only on claim.
  if (!renew) candidate.assigned_agent = agentId;
  candidate.claim_expires_at = isoFromMs(nowMs + getClaimTtlMs());
  if (!Number.isInteger(candidate.reclaim_count)) candidate.reclaim_count = 0;
  if (!renew && candidate.status === STATUSES.BACKLOG) {
    candidate.status = STATUSES.BUILDING;
  }
  candidate.updated = isoFromMs(nowMs);
  candidate.version = nextVersionFor(task);
  if (!Array.isArray(candidate.agent_logs)) candidate.agent_logs = [];
  if (!renew) {
    candidate.agent_logs.push({
      timestamp: candidate.updated,
      message: `${agentId} claimed this task.`,
      agent_id: agentId,
    });
  }

  // KB-05: persist first, then mutate memory, then notify.
  await getStorage(candidate.project).saveTask(candidate, projectBucket(candidate.project, candidate));
  updateInMemoryTask(candidate);
   // §2.2/§2.9: surface a semantic event (claimed / renewed) + audit who/why.
   // The auth middleware populates req.caller as { agent_id, role } — reading
   // `caller.agentId` was always undefined, which attributed every renewal by a
   // real agent to 'system' in the very audit substrate §2.9 reads from.
  const actor = (renew ? caller?.agent_id : null) || agentId || 'system';
  notify({
    actor,
    reason: renew ? 'lease_renewed' : 'claimed',
    semantic: new Map([[
      compositeKey(candidate.project, candidate.id),
      { kind: renew ? 'renewed' : 'claimed', actor, reason: renew ? 'lease_renewed' : 'claimed' },
      ]]),
   });
  return { task: candidate, status: 200 };
}

// ---------------------------------------------------------------------------
// §2.5 optional event-driven auto-promote (BLOCKED -> BACKLOG)
// ---------------------------------------------------------------------------

let completionHooks = [];

/** Register a listener fired when a task reaches DONE. Returns an unsubscribe. */
export function onTaskCompleted(fn) {
  if (typeof fn !== 'function') throw new Error('onTaskCompleted listener must be a function');
  completionHooks.push(fn);
  return () => {
    completionHooks = completionHooks.filter((f) => f !== fn);
  };
}

// Best-effort: a listener error must NEVER poison the completing write.
function runCompletionHooks(id) {
  for (const h of [...completionHooks]) {
    try {
      const r = h(id);
      if (r && typeof r.catch === 'function') {
        r.catch((err) => console.error('[kanban] completion hook rejected:', err && err.message));
      }
    } catch (err) {
      console.error('[kanban] completion hook error:', err && err.message);
    }
  }
}

/**
 * §2.5 unlockTask inner — a documented system override (like the reaper):
 * BLOCKED → BACKLOG is a *legal* canTransition, but we use a dedicated function
 * so we can also clear ownership + lease, which patchTask's allowlist forbids.
 */
async function unlockTaskInner(task, nowMs, completedRef) {
  const candidate = structuredClone(task);
  candidate.status = STATUSES.BACKLOG;
  candidate.assigned_agent = null;
  candidate.claim_expires_at = null;
  candidate.updated = isoFromMs(nowMs);
  candidate.version = nextVersionFor(task);
  if (!Array.isArray(candidate.agent_logs)) candidate.agent_logs = [];
  candidate.agent_logs.push({
    timestamp: candidate.updated,
    message: `unblocked — all dependencies complete (${completedRef} DONE).`,
    agent_id: 'system',
    reason: 'unblocked',
  });
  await getStorage(candidate.project).saveTask(candidate, projectBucket(candidate.project, candidate));
  updateInMemoryTask(candidate);
    // §2.2/§2.9: unblocked event + audit for the auto-promote override.
  notify({
    actor: 'system',
    reason: 'unblocked',
    semantic: new Map([[
      compositeKey(candidate.project, candidate.id),
      { kind: 'unblocked', actor: 'system', reason: 'unblocked' },
       ]]),
     });
  return { task: candidate, status: 200 };
}

// Inner (no lock — caller already holds it via patchTask, or via the wrapper).
async function maybeUnlockDependentsInner(completedRef, nowMs) {
  const unblocked = [];
  for (const t of tasks.slice()) {
    if (t.status !== STATUSES.BLOCKED) continue;
    const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
    if (!deps.includes(completedRef)) continue;
      // Only unlock when *every* dep is now DONE (the last-dep-completes case).
    if (!dependencyGate(t).ok) continue;
    const r = await unlockTaskInner(t, nowMs, completedRef);
    if (!r.error) unblocked.push(t.id);
    }
  // Each unlock fired its own semantic event inside unlockTaskInner; this
     // extra snapshot notify is a no-op re-broadcast so downstream listeners
     // see the whole set in one tick.
  notify({ actor: 'system', reason: 'unblocked_batch' });
  return { unblocked };
}

/**
 * §2.5 maybeUnlockDependents — lock-wrapped, idempotent. Finds BLOCKED tasks
 * whose `completedRef` is a dependency and whose deps are now all DONE, and
 * unblocks them (clears owner + lease). Re-running finds no matching BLOCKED
 * task, so it is safe to call repeatedly.
 */
export async function maybeUnlockDependents(completedRef, { now } = {}) {
  return withMutationLock(async () => {
    const nowMs = typeof now === 'number' ? now : nowFn();
    return maybeUnlockDependentsInner(completedRef, nowMs);
  });
}

/**
 * Claims a task with contention protection (KB-03) + dependency gating (§2.5)
 * + lease (§2.4). `options.expected_version` (or the `If-Match` header the
 * route injects) adds a §2.6 CAS guard: a stale claim is rejected with a
 * "Version mismatch" 409, distinct from the "… already claimed by …" contention
 * 409 and the `dependency_unsatisfied` 409.
 */
export async function claimTask(id, agentId, project, { expected_version: expectedVersion } = {}) {
  return withMutationLock(async () => {
    const task = getTask(id, project);
    if (!task) return { error: 'Task not found', status: 404 };

    if (!agentId || typeof agentId !== 'string') {
      return { error: 'agent_id is required', status: 400 };
      }

       // §2.6: enforce the version guard before building the candidate.
    const conflict = versionConflict(task, expectedVersion);
    if (conflict) return conflict;

       // Contention + dep gate + write via the shared core.
    return applyClaim(task, agentId, {}, nowFn());
   });
}

/**
 * §2.4 renewLease — extend the lease on a held task. Runs in the mutation lock.
 * The HOLDER (builder/reviewer/tester that owns the task) or a PRIVILEGED role
 * (runner/system/human/admin) may renew; a non-privileged non-holder gets a
 * `not_lease_holder` 409. An unclaimed task yields a `not_claimed` 409.
 */
export async function renewLease(id, agentId, { caller = {}, project: projectArg } = {}) {
  return withMutationLock(async () => {
    const task = getTask(id, projectArg);
    if (!task) return { error: 'Task not found', status: 404 };

       // A task with no active claim cannot have its lease renewed.
    if (!task.assigned_agent) {
      return { error: 'Task is not claimed', status: 409, reason: 'not_claimed' };
     }

       // A non-privileged caller must be the current holder.
    if (!isPrivilegedRole(caller.role) && task.assigned_agent !== agentId) {
      return { error: 'Caller is not the lease holder', status: 409, reason: 'not_lease_holder' };
     }

       // Shared core in renew mode: extends the lease, no status move, no log.
       return applyClaim(task, agentId, caller, nowFn(), { renew: true });
       });
       }

       // ---------------------------------------------------------------------------
       // §2.4 stale-task reaper
       // ---------------------------------------------------------------------------

       /**
       * reclaimTask inner — a DOCUMENTED SYSTEM OVERRIDE (like the §2.5 unlock). It
       * forces an active claim (BUILDING / IN_REVIEW / IN_TEST) back to BACKLOG, which
       * is NOT a legal agent transition per canTransition (those states have no
       * → BACKLOG edge). The reaper is ownerless and exempt from the agent state
       * machine; this is the single sanctioned place that exemption exists. Clears
       * owner + lease, bumps reclaim_count, and logs the reclaim. Persist-first →
       * in-memory → notify (KB-05 fail-closed): a storage failure leaves the active
       * claim untouched.
       *
       * UNLOCKED: the caller must already hold the mutation lock. This is required
       * because reapExpiredClaims (a single locked sweep) calls it per-task; a
       * promise-queue lock cannot safely re-enter itself, so the reclaim body is
       * kept out of withMutationLock and the public reclaimTask wrapper supplies the
       * one lock.
       */
       async function reclaimTaskInner(task, { reason = 'lease_expired', nowMs } = {}) {
       const activeStatus = task.status === STATUSES.BUILDING
        || task.status === STATUSES.IN_REVIEW
        || task.status === STATUSES.IN_TEST;
       if (!task.assigned_agent && !activeStatus) {
        // Not currently held and not active — nothing to reclaim. Idempotent.
         return { task, status: 200, reclaimed: false };
         }
       const fromAgent = task.assigned_agent;
       const candidate = structuredClone(task);
       candidate.status = STATUSES.BACKLOG;
       candidate.assigned_agent = null;
       candidate.claim_expires_at = null;
       candidate.reclaim_count = (Number.isInteger(task.reclaim_count) ? task.reclaim_count : 0) + 1;
       candidate.updated = isoFromMs(nowMs);
       candidate.version = nextVersionFor(task);
       if (!Array.isArray(candidate.agent_logs)) candidate.agent_logs = [];
       candidate.agent_logs.push({
        timestamp: candidate.updated,
         message: !fromAgent
          ? 'Task had no owner — reclaimed to BACKLOG by system normalizer.'
          : (reason === 'lease_expired'
           ? 'LEASE EXPIRED — task reclaimed to BACKLOG by system reaper.'
           : `Task reclaimed to BACKLOG by system (${reason}).`),
         agent_id: 'system',
         reason: !fromAgent ? reason : 'lease_expired',
         reclaimed_from: fromAgent,
         });

         // KB-05: persist first, then mutate memory, then notify.
         await getStorage(candidate.project).saveTask(candidate, projectBucket(candidate.project, candidate));
         updateInMemoryTask(candidate);
         // §2.2/§2.9: surface a semantic 'reclaimed' event + audit who/why.
         notify({
         actor: 'system',
         reason: reason,
         semantic: new Map([[
           compositeKey(candidate.project, candidate.id),
           { kind: 'reclaimed', actor: 'system', reason, prevTask: task },
           ]]),
           });
         return { task: candidate, status: 200, reclaimed: true, reclaimed_from: fromAgent };
         }

        /**
        * reclaimTask(id, { reason, now }) — public, lock-wrapped reclaim. Delegates
        * to the unlocked inner so a caller that is already inside the lock
        * (reapExpiredClaims) does not deadlock on the promise-queue lock.
        */
       export async function reclaimTask(id, { reason = 'lease_expired', now, project } = {}) {
       return withMutationLock(async () => {
        const task = getTask(id, project);
        if (!task) return { error: 'Task not found', status: 404 };
        const nowMs = typeof now === 'number' ? now : nowFn();
        return reclaimTaskInner(task, { reason, nowMs });
         });
       }

       /**
       * reapExpiredClaims — sweep active claims whose lease has expired and reclaim
       * them. Runs in the mutation lock so it is serialized with every other writer
       * (a heartbeat that lands first commits before the sweep sees a fresh expiry).
       * `now` is injectable so tests can force expiry. Returns the reclaimed ids.
       * Calls the UNLOCKED reclaimTaskInner directly (it already holds the lock).
       */
       export async function reapExpiredClaims({ now } = {}) {
       return withMutationLock(async () => {
       const nowMs = typeof now === 'number' ? now : nowFn();
       const candidates = tasks.filter((t) => {
        const active = t.status === STATUSES.BUILDING
        || t.status === STATUSES.IN_REVIEW
        || t.status === STATUSES.IN_TEST;
       if (!active) return false;
       if (t.assigned_agent === null || t.claim_expires_at === null || t.claim_expires_at === undefined) {
         // Orphan: active with no owner/lease — structurally stuck, always reclaim.
         return true;
         }
       const expiresMs = Date.parse(t.claim_expires_at);
        if (Number.isNaN(expiresMs)) return false;
        return expiresMs <= nowMs;
         });
       let reclaimed = 0;
       const ids = [];
       for (const t of candidates) {
         // getTask MUST be given the candidate's own project: task ids are unique
         // only within a project, so the 1-arg form resolves against `default` and
         // either returns null (throwing, aborting the whole sweep) or — when the
         // same short id exists in `default` — reclaims the wrong task.
         const task = getTask(t.id, t.project);
         const reason = (task.assigned_agent === null || task.claim_expires_at == null)
          ? 'orphan_normalized'
          : 'lease_expired';
         const r = await reclaimTaskInner(task, { reason, nowMs });
         if (r && r.reclaimed) {
           reclaimed += 1;
           ids.push(compositeKey(t.project, t.id));
            }
           }
           if (reclaimed > 0) notify();
           return { reclaimed: ids, now: nowMs };
           });
       }

       /**
       * §2.7 nextClaim — atomically select the highest-priority, unclaimed,
       * dependency-satisfied BACKLOG task and claim it for `agentId`, all inside one
       * mutation-lock critical section. Priority order: high < medium < low, tie-broke
       * by creation order (array index, FIFO), then by id for total determinism.
       *
       * Only BACKLOG + unclaimed + gate-passing tasks are candidates, so the winner
       * never hits a dependency 409. Two concurrent calls get distinct winners (the
       * first claims it → the second sees it held and skips it). No 409 storm.
       *
       * Returns `{ task, status: 200 }` on a claim, or `{ unavailable: true,
       * status: 204 }` when nothing is claimable (a cheap poll target for agents).
       */
       export async function nextClaim({ agentId, role, project, now } = {}) {
       return withMutationLock(async () => {
       if (!agentId || typeof agentId !== 'string') {
         return { error: 'agent_id is required', status: 400 };
        }
        // `role` is validation-only (the route checks it against VALID_ROLES) and
        // is recorded on the claim, but it does not filter candidates.
       void role;

        // §2.1/§2.7: an agent bound to one project must never be handed another
        // project's card. An invalid project id matches nothing rather than
        // silently widening to the whole portfolio.
       const hasScope = project !== undefined && project !== null && project !== '';
       if (hasScope && !isValidProjectId(project)) {
         return { unavailable: true, status: 204 };
         }
       const scoped = hasScope ? project : null;

        const candidates = tasks.filter((t) => {
         if (scoped !== null && t.project !== scoped) return false;
         if (t.assigned_agent !== null) return false;
         if (t.status !== STATUSES.BACKLOG) return false;
         if (!dependencyGate(t).ok) return false;
         return true;
         });
       if (candidates.length === 0) {
         return { unavailable: true, status: 204 };
         }

          // Order by [priorityRank, arrayIndex, id]; arrayIndex is FIFO creation
         // order because the tasks array is append-ordered and reclaim/unlock
         // mutate in place (preserving index).
       const indexed = candidates.map((t, i) => [t, i]);
       indexed.sort((a, b) => {
         const ra = priorityRank(a[0].priority);
         const rb = priorityRank(b[0].priority);
         if (ra !== rb) return ra - rb;
         if (a[1] !== b[1]) return a[1] - b[1];
         return String(a[0].id).localeCompare(String(b[0].id));
         });

          const nowMs = typeof now === 'number' ? now : nowFn();
          const winner = indexed[0][0];

          // Re-gate at the instant of claim as defense-in-depth (the lock already
         // serializes, but this keeps the shared core total).
       const r = await applyClaim(winner, agentId, role ? { role } : {}, nowMs);
        if (r.error) return r;
        return { task: r.task, status: 200 };
        });
       }


/**
 * Appends log to task. `options.expected_version` (or the `If-Match` header
 * the route injects) adds a §2.6 CAS guard and bumps version on the write.
 */
export async function appendLog(id, agentId, message, project, { expected_version: expectedVersion } = {}) {
  return withMutationLock(async () => {
    const task = getTask(id, project);
    if (!task) return { error: 'Task not found', status: 404 };

    if (!agentId || !message) {
      return { error: 'agent_id and message are required', status: 400 };
       }

        // §2.6: enforce the version guard before building the candidate.
    const conflict = versionConflict(task, expectedVersion);
    if (conflict) return conflict;

    const candidate = structuredClone(task);
    candidate.updated = new Date().toISOString();
        // §2.6: a committed log append advances version by exactly one.
    candidate.version = nextVersionFor(task);
    if (!Array.isArray(candidate.agent_logs)) {
      candidate.agent_logs = [];
      }
    candidate.agent_logs.push({
      timestamp: candidate.updated,
      message: escapeHtml(message),
      agent_id: escapeHtml(agentId),
    });

    await getStorage(candidate.project).saveTask(candidate, projectBucket(candidate.project, candidate));
    updateInMemoryTask(candidate);
    notify();
    return { task: candidate, status: 200 };
  });
}

/**
 * Appends issue to task (KB-08). `options.expected_version` (or the `If-Match`
 * header the route injects) adds a §2.6 CAS guard and bumps version on the write.
 */
export async function addIssue(id, issueId, project, { expected_version: expectedVersion } = {}) {
  return withMutationLock(async () => {
    const task = getTask(id, project);
    if (!task) return { error: 'Task not found', status: 404 };

    if (!issueId || typeof issueId !== 'string') {
      return { error: 'issue_id is required', status: 400 };
       }

        // §2.6: enforce the version guard before building the candidate.
    const conflict = versionConflict(task, expectedVersion);
    if (conflict) return conflict;

    const safeIssueId = escapeHtml(issueId);

    const candidate = structuredClone(task);
    if (!Array.isArray(candidate.issues)) {
      candidate.issues = [];
      }
    if (!candidate.issues.includes(safeIssueId)) {
      candidate.issues.push(safeIssueId);
      }
    candidate.updated = new Date().toISOString();
        // §2.6: a committed issue append advances version by exactly one.
    candidate.version = nextVersionFor(task);

    await getStorage(candidate.project).saveTask(candidate, projectBucket(candidate.project, candidate));
    updateInMemoryTask(candidate);
    notify();
    return { issues: candidate.issues, status: 200 };
     });
}

// ---------------------------------------------------------------------------
// Archiving & Storage Hygiene (§2.8)
// ---------------------------------------------------------------------------

function getArchiveAfterDays() {
  const raw = process.env.KANBAN_ARCHIVE_AFTER_DAYS;
  if (raw === undefined || raw === '') return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0; // negative disables the sweep
  return n;
}

function isEligibleForArchive(task, days, nowMs) {
  if (task.status !== STATUSES.DONE) return false;
  if (task.archived_at) return false;
  const anchor = task.completed_at || task.created_at || task.updated;
  if (!anchor) return false;
  const ageMs = nowMs - Date.parse(anchor);
  if (Number.isNaN(ageMs)) return false;
  return ageMs >= days * 86400000;
}

/**
 * Moves DONE tasks older than KANBAN_ARCHIVE_AFTER_DAYS (keyed off completed_at,
 * then created_at, then updated) into their project's archive. Idempotent and
 * safe to run on every boot and lazily before reads. 0 disables the sweep.
 */
export async function runArchiveSweep() {
  return withMutationLock(async () => {
    const days = getArchiveAfterDays();
    if (days === 0) return 0;

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // Group live tasks by project; also track projects that already hold
    // archived rows (so their archive sink gets a consistent write even when
    // they have no live partition of their own, e.g. the default boot case).
    const byProject = new Map();
    for (const t of tasks) {
      if (!byProject.has(t.project)) byProject.set(t.project, []);
      byProject.get(t.project).push(t);
     }

    let moved = 0;
    const touchedProjects = new Set();
    const archivedSemantic = new Map();

    const runFor = async (project, liveList) => {
      const eligible = (liveList || []).filter((t) => isEligibleForArchive(t, days, nowMs));
      const storage = getStorage(project);
      const isGit = storage instanceof GitYamlStorage;

      // No eligible tasks -> nothing to move, and (per the KB-05 fail-closed
      // invariant) no reason to touch any archive sink file on this pass.
      if (eligible.length === 0) return;

      // (a) Build the new archive entries + the surviving live partition WITHOUT
      // touching memory, so a persistence failure below leaves memory unchanged
      // (symmetric with the single-task path at store.js:399-400, KB-05).
      const newArchived = eligible.map((t) => {
        const archived = structuredClone(t);
        archived.archived_at = nowIso;
        return archived;
      });
      const eligibleIds = new Set(eligible.map((t) => t.id));

      // (b) Persist FIRST: the live partition minus the moved rows, and the
      // merged archive sink. Only when persistence fully succeeds do we mutate
      // memory, so a throw fails closed and the task survives in the live set.
      if (isGit) {
        // saveArchiveTask git-rms the live card and writes + commits the
        // archive card; the archive sink has no separate file for git.
        for (const archived of newArchived) {
          await storage.saveArchiveTask(archived);
        }
      } else {
        // Live partition rewrite: the project had live rows, so the dropped
        // ones must be reflected on disk. (Archive-only projects hit the
        // early return above and never reach this branch.)
        const survivors = (liveList || []).filter((t) => !eligibleIds.has(t.id));
        await storage.save(survivors);
        // Archive sink rewrite is gated on a real move (FIX 3): no churn when
        // this project moved nothing, and we merge onto any existing rows.
        const merged = [...(archive[project] || []), ...newArchived];
        await storage.saveArchive(merged);
      }

      // (c) Only after every persistence call succeeded: drop the moved rows
      // from the in-memory live set/index and append them to the live archive.
      for (const t of eligible) {
        removeFromMemory(project, t.id);
      }
      const list = archive[project] || (archive[project] = []);
      for (const archived of newArchived) {
        list.push(archived);
      }
      for (const archived of newArchived) {
        archivedSemantic.set(compositeKey(project, archived.id), {
          kind: 'archived', actor: 'system', reason: 'archived', task: archived,
          });
        }
      moved += eligible.length;
      touchedProjects.add(project);
      };

    // Run for every project that currently has live tasks.
    for (const [project, liveList] of byProject) {
      await runFor(project, liveList);
     }

    // A project whose only record is an archive list is re-processed here, but
    // the early return in runFor makes it a no-op unless it actually has
    // eligible rows to move (so no archive sink churn when nothing moved).
    for (const project of Object.keys(archive)) {
      if (!byProject.has(project)) {
        await runFor(project, []);
      }
    }

    if (moved > 0) {
      notify({ actor: 'system', reason: 'archived', semantic: archivedSemantic });
      }
    return moved;
   });
}

// ---------------------------------------------------------------------------
// Admin delete & bulk purge (§admin-purge)
// ---------------------------------------------------------------------------

/**
 * Admin-only delete of a single task. Persists FIRST (fail-closed, KB-05):
 * the JSON backend rewrites the project partition minus this task; the Git
 * backend git-rms the card file + commits. Only then is the task dropped from
 * memory. Requires a privileged role (runner/system/human/admin).
 */
export async function deleteTask(id, { caller = {}, project } = {}) {
  return withMutationLock(async () => {
    const task = getTask(id, project);
    if (!task) return { error: 'Task not found', status: 404 };

    if (!isPrivilegedRole(caller.role)) {
      return { error: 'Forbidden: admin role required to delete tasks', status: 403 };
    }

    const storage = getStorage(task.project);
    if (storage instanceof GitYamlStorage) {
      await storage.deleteTask(task);
    } else {
      const survivors = getProjectBucket(task.project).filter((t) => t.id !== task.id);
      await storage.deleteTask(task, survivors);
    }

    removeFromMemory(task.project, task.id);
    notify({
      actor: caller.agent_id || 'admin',
      reason: 'deleted',
      semantic: new Map([[
        compositeKey(task.project, task.id),
        { kind: 'deleted', actor: caller.agent_id || 'admin', reason: 'deleted', task },
      ]]),
    });
    return { task, status: 200 };
  });
}

/**
 * Admin-only bulk purge of tasks by explicit ids (composite-aware) or a filter.
 * Persists FIRST per affected project, then drops the rows from memory and
 * emits one consolidated deletion event. Requires a privileged role.
 */
export async function purgeTasks({ caller = {}, project, ids, filter } = {}) {
  return withMutationLock(async () => {
    if (!isPrivilegedRole(caller.role)) {
      return { error: 'Forbidden: admin role required to delete tasks', status: 403 };
    }

    const scoped = project === undefined || project === null || project === ''
      ? tasks
      : tasks.filter((t) => t.project === project);

    let candidates;
    if (Array.isArray(ids) && ids.length > 0) {
      const idSet = new Set(ids);
      candidates = scoped.filter((t) => {
        if (idSet.has(t.id)) return true;
        if (project === undefined || project === null || project === '') {
          return idSet.has(compositeKey(t.project, t.id));
        }
        return false;
      });
    } else if (filter && typeof filter === 'object') {
      const status = filter.status !== undefined ? normalizeStatus(filter.status) : undefined;
      const fp = filter.project;
      const ageDays = filter.older_than_days;
      const ageThresholdMs =
        typeof ageDays === 'number' && Number.isFinite(ageDays)
          ? ageDays * 86400000
          : null;
      const nowMs = Date.now();
      candidates = scoped.filter((t) => {
        if (status !== undefined && status !== null && t.status !== status) return false;
        if (fp !== undefined && fp !== null && fp !== '' && t.project !== fp) return false;
        if ('assigned_agent' in filter) {
          if (filter.assigned_agent === null) {
            if (t.assigned_agent != null) return false;
          } else if (t.assigned_agent !== filter.assigned_agent) {
            return false;
          }
        }
        if (ageThresholdMs !== null) {
          const anchor = t.completed_at || t.created_at || t.updated;
          if (!anchor) return false;
          const ageMs = nowMs - Date.parse(anchor);
          if (Number.isNaN(ageMs) || ageMs < ageThresholdMs) return false;
        }
        return true;
      });
    } else {
      return { error: 'purge requires ids[] or filter', status: 400 };
    }

    if (candidates.length === 0) {
      return { deleted: [], count: 0, status: 200 };
    }

    // Group by project so each partition is rewritten exactly once (persist-first).
    const byProject = new Map();
    for (const t of candidates) {
      if (!byProject.has(t.project)) byProject.set(t.project, []);
      byProject.get(t.project).push(t);
    }

    const semantic = new Map();
    const deleted = [];

    for (const [p, list] of byProject) {
      const storage = getStorage(p);
      if (storage instanceof GitYamlStorage) {
        for (const t of list) {
          await storage.deleteTask(t);
        }
      } else {
        const deleteIds = new Set(list.map((t) => t.id));
        const survivors = getProjectBucket(p).filter((t) => !deleteIds.has(t.id));
        await storage.deleteTask(list[0], survivors);
      }
      for (const t of list) {
        removeFromMemory(p, t.id);
        const key = compositeKey(p, t.id);
        deleted.push(key);
        semantic.set(key, {
          kind: 'deleted', actor: caller.agent_id || 'admin', reason: 'deleted', task: t,
        });
      }
    }

    notify({
      actor: caller.agent_id || 'admin',
      reason: 'deleted',
      semantic,
    });

    return { deleted, count: deleted.length, status: 200 };
  });
}

// Re-export for convenience / tests
export { defaultProjectName as getDefaultProject };

// ---------------------------------------------------------------------------
// §2.4 reaper timer — started ONLY in startServer (never in createApp, so the
// HTTP-contract tests never spawn a timer). The timer is unref()'d so an idle
// process can still exit, and startReaper/stopReaper let a caller control it.
// ---------------------------------------------------------------------------
let reapTimer = null;

export function startReaper() {
  if (reapTimer) return reapTimer;
  reapTimer = setInterval(() => {
     // Fire-and-forget; the lock serializes it with the other writers. Swallow
     // so a sweep throw can never kill the interval or the process.
    reapExpiredClaims().catch((err) => {
      console.error('[kanban reaper] sweep failed:', err && err.message);
     });
   }, getReapIntervalMs());
      // An unref'd timer must not keep a (possibly test-driven) process alive.
    reapTimer.unref();
    console.log(`[kanban reaper] started (interval=${getReapIntervalMs()}ms)`);
    return reapTimer;
   }

export function stopReaper() {
  if (reapTimer) {
    clearInterval(reapTimer);
    reapTimer = null;
    return true;
   }
  return false;
}

export function isReaperRunning() {
  return reapTimer !== null;
}

// ---------------------------------------------------------------------------
// §2.7 periodic backup — opt-in snapshot of the live JSON data file(s) into a
// sibling `backups/` directory, rotated to a bounded count. OFF unless
// KANBAN_BACKUP_ENABLED is set. Read-only: never takes the mutation lock.
// ---------------------------------------------------------------------------
function getBackupIntervalMs() {
  const raw = process.env.KANBAN_BACKUP_INTERVAL_MS;
  if (raw === undefined || raw === '') return 600000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 600000;
}

function getBackupKeep() {
  const raw = process.env.KANBAN_BACKUP_KEEP;
  if (raw === undefined || raw === '') return 10;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10;
}

function isBackupEnabled() {
  const raw = process.env.KANBAN_BACKUP_ENABLED;
  if (raw === undefined || raw === '') return false;
  return raw !== 'false' && raw !== '0';
}

function sanitizeTimestamp(iso) {
  return iso.replace(/[:.]/g, '-');
}

function backupSourceDir() {
  if (process.env.KANBAN_DATA_DIR) return process.env.KANBAN_DATA_DIR;
  const defaultLive = process.env.KANBAN_DATA_FILE || path.join(__dirname, 'tasks.json');
  return path.dirname(defaultLive);
}

function defaultBackupRoot() {
  return path.join(backupSourceDir(), 'backups');
}

async function runBackup() {
  const root = defaultBackupRoot();
  const stamp = sanitizeTimestamp(new Date().toISOString());
  const destDir = path.join(root, stamp);
  await mkdir(destDir, { recursive: true });

  const dataDir = process.env.KANBAN_DATA_DIR;
  if (dataDir && existsSync(dataDir)) {
    await copyDirTree(dataDir, destDir);
  } else {
    const defaultLive = process.env.KANBAN_DATA_FILE || path.join(__dirname, 'tasks.json');
    if (existsSync(defaultLive)) {
      await copyFile(defaultLive, path.join(destDir, path.basename(defaultLive)));
    }
    const jsonDir = jsonDataDir();
    const tasksDir = path.join(jsonDir, 'tasks');
    const archiveDir = path.join(jsonDir, 'archive');
    if (existsSync(tasksDir)) await copyDirTree(tasksDir, path.join(destDir, 'tasks'));
    if (existsSync(archiveDir)) await copyDirTree(archiveDir, path.join(destDir, 'archive'));
  }

  await rotateBackups(root);
}

async function copyDirTree(src, dest) {
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'backups') continue;
      await copyDirTree(s, d);
    } else {
      await copyFile(s, d);
    }
  }
}

async function rotateBackups(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const stamps = entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  const keep = getBackupKeep();
  for (const stale of stamps.slice(keep)) {
    await rm(path.join(root, stale), { recursive: true, force: true });
  }
}

let backupTimer = null;

export function startBackup() {
  if (backupTimer) return backupTimer;
  if (!isBackupEnabled()) return null;
  backupTimer = setInterval(() => {
    runBackup().catch((err) => {
      console.error('[kanban backup] run failed:', err && err.message);
    });
  }, getBackupIntervalMs());
  backupTimer.unref();
  console.log(`[kanban backup] started (interval=${getBackupIntervalMs()}ms, keep=${getBackupKeep()})`);
  return backupTimer;
}

export function stopBackup() {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
    return true;
  }
  return false;
}

export function isBackupRunning() {
  return backupTimer !== null;
}

export async function runBackupNow() {
  await runBackup();
}
