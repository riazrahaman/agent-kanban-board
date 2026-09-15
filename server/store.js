import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
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
      for (const t of list) {
        if (!Number.isInteger(t.version)) t.version = 1;
        }
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

  async loadArchive() {
    try {
      if (!existsSync(this.archiveFile)) return [];
      const parsed = JSON.parse(await readFile(this.archiveFile, 'utf-8'));
       // §2.6: backfill version 1 on legacy archived JSON records.
      const list = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      for (const t of list) {
        if (!Number.isInteger(t.version)) t.version = 1;
         }
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
          if (parsed && parsed.id) tasks.push(parsed);
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
let tasks = [];             // every live task across all projects
let archive = {};           // project -> Task[] (archived, not in `tasks`)
let listeners = [];
const index = new Map();    // `${project}/${id}` -> Task   (O(1) composite lookup)
const storageCache = new Map(); // project -> per-project storage instance
let mutationQueue = Promise.resolve();

function withMutationLock(operation) {
  const run = mutationQueue.then(operation, operation);
  mutationQueue = run.catch(() => undefined);
  return run;
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
}

function removeFromMemory(project, id) {
  index.delete(compositeKey(project, id));
  const idx = tasks.findIndex((t) => t.id === id && t.project === project);
  if (idx >= 0) tasks.splice(idx, 1);
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
  notify();
}

export function notify() {
  const snapshot = tasks;
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (err) {
      console.error('[kanban] listener error:', err);
    }
  }
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

export function getProjectSummaries() {
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
  return [...map.values()].sort((a, b) => a.project.localeCompare(b.project));
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
    return { task: candidate, status: 200 };
    });
}

/**
 * Claims a task with contention protection (KB-03).
 * `options.expected_version` (or the `If-Match` header the route injects)
 * adds a §2.6 CAS guard: a stale claim is rejected with a "Version mismatch"
 * 409, distinct from the "… already claimed by …" contention 409.
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

     // KB-03: Claim contention — held task returns 409 unless caller is holder
    if (task.assigned_agent && task.assigned_agent !== agentId) {
      return {
        error: `Task ${id} is already claimed by ${task.assigned_agent}`,
        status: 409,
       };
     }

    const candidate = structuredClone(task);
    candidate.assigned_agent = agentId;

     // Moving from BACKLOG to BUILDING on claim
    if (candidate.status === STATUSES.BACKLOG) {
      candidate.status = STATUSES.BUILDING;
     }

    candidate.updated = new Date().toISOString();
       // §2.6: a committed claim advances version by exactly one.
    candidate.version = nextVersionFor(task);
    if (!Array.isArray(candidate.agent_logs)) {
      candidate.agent_logs = [];
     }
    candidate.agent_logs.push({
      timestamp: candidate.updated,
      message: `${agentId} claimed this task.`,
      agent_id: agentId,
    });

    await getStorage(candidate.project).saveTask(candidate, projectBucket(candidate.project, candidate));
    updateInMemoryTask(candidate);
    notify();
    return { task: candidate, status: 200 };
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

    const candidate = structuredClone(task);
    if (!Array.isArray(candidate.issues)) {
      candidate.issues = [];
      }
    if (!candidate.issues.includes(issueId)) {
      candidate.issues.push(issueId);
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

    if (moved > 0) notify();
    return moved;
   });
}

// Re-export for convenience / tests
export { defaultProjectName as getDefaultProject };
