import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'tasks.json');

const VALID_STATUSES = ['backlog', 'todo', 'in_progress', 'blocked', 'done'];

let tasks = [];
let listeners = [];

export async function loadStore() {
  try {
    const raw = await readFile(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    // Self-heal: a malformed/partial payload must not crash the board.
    if (!tasks || tasks.length === 0) throw new Error('empty task list');
    notify();
   } catch (err) {
    // First boot or corrupted file: start from an empty board and persist it so
    // subsequent loads have something to read.
    console.warn(`[kanban] loadStore: ${(err.message)} — starting empty board at ${DATA_FILE}`);
    tasks = [];
    await persist();
    }
 }

async function persist() {
  await writeFile(DATA_FILE, JSON.stringify({ tasks }, null, 2), 'utf-8');
}

function notify() {
  const snapshot = tasks;
  for (const listener of listeners) listener(snapshot);
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

export function isValidStatus(status) {
  return VALID_STATUSES.includes(status);
}

export async function patchTask(id, patch) {
  const task = getTask(id);
  if (!task) return null;

  const allowed = ['title', 'description', 'status', 'priority', 'assigned_agent', 'metadata'];
  for (const key of allowed) {
    if (key in patch) task[key] = patch[key];
  }

  await persist();
  notify();
  return task;
}

export async function claimTask(id, agentId) {
  const task = getTask(id);
  if (!task) return null;

  task.assigned_agent = agentId;
  task.status = 'in_progress';
  task.agent_logs.push({
    timestamp: new Date().toISOString(),
    message: `${agentId} claimed this task and started executing.`,
    agent_id: agentId,
  });

  await persist();
  notify();
  return task;
}

export async function appendLog(id, agentId, message) {
  const task = getTask(id);
  if (!task) return null;

  task.agent_logs.push({
    timestamp: new Date().toISOString(),
    message,
    agent_id: agentId,
  });

  await persist();
  notify();
  return task;
}

export async function createTask(task) {
  const newTask = {
    id: task.id,
    title: task.title || '',
    description: task.description || '',
    status: task.status || 'backlog',
    priority: task.priority || 'medium',
    assigned_agent: task.assigned_agent || null,
    agent_logs: task.agent_logs || [],
    metadata: task.metadata || {}
  };
  const idx = tasks.findIndex((t) => t.id === newTask.id);
  if (idx >= 0) {
    tasks[idx] = { ...tasks[idx], ...newTask };
  } else {
    tasks.push(newTask);
  }
  await persist();
  notify();
  return newTask;
}

