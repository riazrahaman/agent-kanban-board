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
// Pluggable Storage Backends (KB-09)
// ============================================================================

export class JsonStorage {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async load() {
    try {
      if (!existsSync(this.filePath)) {
        return [];
      }
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.tasks) ? parsed.tasks : [];
    } catch (err) {
      console.warn(`[kanban JsonStorage] load error: ${err.message} — starting empty`);
      return [];
    }
  }

  async save(tasks) {
    const data = JSON.stringify({ tasks }, null, 2);
    await writeAtomic(this.filePath, data);
  }

  async saveTask(task, allTasks) {
    await this.save(allTasks);
  }
}

export class GitYamlStorage {
  constructor(dirPath, options = {}) {
    this.dir = dirPath;
    this.autoCommit = options.autoCommit !== false;
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

  async saveTask(task) {
    await mkdir(this.dir, { recursive: true });
    if (!Number.isInteger(task.round) || task.round < 1) {
      throw new Error('Git-backed task persistence requires a positive integer round');
    }
    const filename = `${task.id}.yml`;
    const filePath = path.resolve(this.dir, filename);
    const targetDir = path.resolve(this.dir);
    if (!filePath.startsWith(targetDir + path.sep) && filePath !== targetDir) {
      throw new Error(`Path traversal attempt detected in task id: ${task.id}`);
    }

    // Spec Sec 3.2 schema ordering
    const cardData = {
      id: task.id,
      title: task.title,
      status: task.status,
      branch: task.branch || `task/${task.id}`,
      depends_on: task.depends_on || [],
      round: task.round,
      issues: task.issues || [],
      assigned_agent: task.assigned_agent ?? null,
      updated: task.updated || new Date().toISOString(),
      description: task.description || '',
      priority: task.priority || 'medium',
      agent_logs: task.agent_logs || [],
      metadata: task.metadata || {},
    };

    const ymlContent = yaml.stringify(cardData);
    await writeAtomic(filePath, ymlContent);

    if (this.autoCommit) {
      await this._tryGitCommit(task, filename);
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
      const commitMsg = `ops(${task.id}): kanban ${task.status}`;
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
let tasks = [];
let listeners = [];
let mutationQueue = Promise.resolve();

function withMutationLock(operation) {
  const run = mutationQueue.then(operation, operation);
  mutationQueue = run.catch(() => undefined);
  return run;
}

export function getStorage() {
  if (!storage) {
    const backend = process.env.KANBAN_STORAGE_BACKEND || 'git';
    if (backend === 'git') {
      const gitDir =
        process.env.KANBAN_GIT_DIR ||
        process.env.KANBAN_DATA_DIR ||
        path.resolve(__dirname, '../../agent-based-investment/ops/kanban');
      const autoCommit = process.env.KANBAN_GIT_COMMIT !== 'false';
      storage = new GitYamlStorage(gitDir, { autoCommit });
    } else {
      const jsonFile =
        process.env.KANBAN_DATA_FILE || path.join(__dirname, 'tasks.json');
      storage = new JsonStorage(jsonFile);
    }
  }
  return storage;
}

export function setStorage(newStorage) {
  storage = newStorage;
}

export async function loadStore() {
  const storeInstance = getStorage();
  tasks = await storeInstance.load();
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

export function getTasks() {
  return tasks;
}

export function getTask(id) {
  return tasks.find((t) => t.id === id) ?? null;
}

function updateInMemoryTask(updatedTask) {
  const idx = tasks.findIndex((t) => t.id === updatedTask.id);
  if (idx >= 0) {
    tasks[idx] = updatedTask;
  } else {
    tasks.push(updatedTask);
  }
}

const TASK_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isValidTaskId(id) {
  return typeof id === 'string' && TASK_ID_RE.test(id);
}

/**
 * Creates a task (spec Sec 9.4.3)
 */
export async function createTask(data) {
  return withMutationLock(async () => {
    if (!data.id || !data.title) {
    return { error: 'id and title are required', status: 400 };
    }

    if (!isValidTaskId(data.id)) {
    return {
      error: 'Invalid task id: must contain only alphanumeric characters, underscores, and hyphens',
      status: 400,
    };
    }

    if (getTask(data.id)) {
      return { error: `Task ${data.id} already exists`, status: 409 };
    }

  const status = normalizeStatus(data.status);
    if (!status) {
      return { error: `Invalid status: ${data.status}`, status: 400 };
    }
    if (!Number.isInteger(data.round) || data.round < 1) {
      return { error: 'round must be a positive integer', status: 400 };
    }

  const existing = getTask(data.id);
  const now = new Date().toISOString();

  const newTask = {
    id: data.id,
    title: escapeHtml(data.title),
    description: escapeHtml(data.description || existing?.description || ''),
    status,
    priority: data.priority || existing?.priority || 'medium',
    branch: data.branch || existing?.branch || `task/${data.id}`,
    depends_on: Array.isArray(data.depends_on)
      ? data.depends_on
      : existing?.depends_on || [],
    round: data.round,
    issues: Array.isArray(data.issues)
      ? data.issues
      : existing?.issues || [],
    assigned_agent: data.assigned_agent !== undefined
      ? data.assigned_agent
      : existing?.assigned_agent || null,
    agent_logs: Array.isArray(data.agent_logs)
      ? data.agent_logs
      : existing?.agent_logs || [],
    metadata: data.metadata || existing?.metadata || {},
    updated: now,
  };

  const nextTasks = tasks.some((t) => t.id === newTask.id)
    ? tasks.map((t) => (t.id === newTask.id ? newTask : t))
    : [...tasks, newTask];

  // KB-05: mutate in memory only after the write lands
  await getStorage().saveTask(newTask, nextTasks);
  updateInMemoryTask(newTask);
  notify();
    return { task: newTask, status: 201 };
  });
}

/**
 * Patches a task with state machine (KB-01) and role ownership (KB-02) checks.
 */
export async function patchTask(id, patch, { caller = {} } = {}) {
  return withMutationLock(async () => {
    const task = getTask(id);
    if (!task) return { error: 'Task not found', status: 404 };

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

  const nextTasks = tasks.map((t) => (t.id === id ? candidate : t));

  // KB-05: Atomic write then mutate in-memory
  await getStorage().saveTask(candidate, nextTasks);
  updateInMemoryTask(candidate);
  notify();
    return { task: candidate, status: 200 };
  });
}

/**
 * Claims a task with contention protection (KB-03).
 */
export async function claimTask(id, agentId) {
  return withMutationLock(async () => {
    const task = getTask(id);
    if (!task) return { error: 'Task not found', status: 404 };

  if (!agentId || typeof agentId !== 'string') {
    return { error: 'agent_id is required', status: 400 };
  }

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
  if (!Array.isArray(candidate.agent_logs)) {
    candidate.agent_logs = [];
  }
  candidate.agent_logs.push({
    timestamp: candidate.updated,
    message: `${agentId} claimed this task.`,
    agent_id: agentId,
  });

  const nextTasks = tasks.map((t) => (t.id === id ? candidate : t));

  await getStorage().saveTask(candidate, nextTasks);
  updateInMemoryTask(candidate);
  notify();
    return { task: candidate, status: 200 };
  });
}

/**
 * Appends log to task.
 */
export async function appendLog(id, agentId, message) {
  return withMutationLock(async () => {
    const task = getTask(id);
    if (!task) return { error: 'Task not found', status: 404 };

  if (!agentId || !message) {
    return { error: 'agent_id and message are required', status: 400 };
  }

  const candidate = structuredClone(task);
  candidate.updated = new Date().toISOString();
  if (!Array.isArray(candidate.agent_logs)) {
    candidate.agent_logs = [];
  }
  candidate.agent_logs.push({
    timestamp: candidate.updated,
    message: escapeHtml(message),
    agent_id: escapeHtml(agentId),
  });

  const nextTasks = tasks.map((t) => (t.id === id ? candidate : t));

  await getStorage().saveTask(candidate, nextTasks);
  updateInMemoryTask(candidate);
  notify();
    return { task: candidate, status: 200 };
  });
}

/**
 * Appends issue to task (KB-08).
 */
export async function addIssue(id, issueId) {
  return withMutationLock(async () => {
    const task = getTask(id);
    if (!task) return { error: 'Task not found', status: 404 };

  if (!issueId || typeof issueId !== 'string') {
    return { error: 'issue_id is required', status: 400 };
  }

  const candidate = structuredClone(task);
  if (!Array.isArray(candidate.issues)) {
    candidate.issues = [];
  }
  if (!candidate.issues.includes(issueId)) {
    candidate.issues.push(issueId);
  }
  candidate.updated = new Date().toISOString();

  const nextTasks = tasks.map((t) => (t.id === id ? candidate : t));

  await getStorage().saveTask(candidate, nextTasks);
  updateInMemoryTask(candidate);
  notify();
    return { issues: candidate.issues, status: 200 };
  });
}
