/**
 * Master password, client side: pure helpers for the "card details are locked"
 * state. No DOM, no fetch, so the click gating and the unlock storage rules are
 * unit-testable.
 *
 * The lock is DATA-DRIVEN: the server decides who may read card details and
 * marks the reduced shape with `details_locked: true`. The client never guesses
 * whether a master password is configured; it only reacts to that marker.
 */
import type { Task } from '../types.ts'

/** Tooltip on a card (or rail row) whose details this browser may not read. */
export const LOCKED_HINT = 'Enter the master password to view details'

/** True when the server sent this task without its details. */
export function isDetailsLocked(task: Pick<Task, 'details_locked'> | null | undefined): boolean {
  return task?.details_locked === true
}

/** True when any task on the board arrived without its details. */
export function boardDetailsLocked(tasks: ReadonlyArray<Pick<Task, 'details_locked'>>): boolean {
  return tasks.some((t) => t.details_locked === true)
}

/** The open-sheet key for a task: project + id, because ids repeat across projects. */
export function taskKey(project: string, id: string): string {
  return `${project}/${id}`
}

/**
 * The key to open for a click on `project/id`, or null when the click must do
 * nothing: the task is unknown, or its details are locked.
 */
export function openKeyFor(
  tasks: ReadonlyArray<Pick<Task, 'id' | 'project' | 'details_locked'>>,
  project: string,
  id: string,
): string | null {
  const task = tasks.find((t) => t.id === id && t.project === project)
  if (!task || isDetailsLocked(task)) return null
  return taskKey(project, id)
}

export type ActivityItem = {
  taskId: string
  project: string
  taskTitle: string
  agentId: string
  /** The log text; '' when the task's details are locked. */
  message: string
  timestamp: string
  locked: boolean
}

/**
 * The signal rail's activity feed: the newest log entries across the board.
 * A locked task contributes its `activity` summary (who and when, no text).
 */
export function railActivity(tasks: ReadonlyArray<Task>, limit = 20): ActivityItem[] {
  const items: ActivityItem[] = []
  for (const task of tasks) {
    const locked = isDetailsLocked(task)
    if (locked) {
      for (const entry of Array.isArray(task.activity) ? task.activity : []) {
        items.push({
          project: task.project,
          taskId: task.id,
          taskTitle: task.title,
          agentId: entry.agent_id ?? '',
          message: '',
          timestamp: entry.timestamp ?? '',
          locked: true,
        })
      }
      continue
    }
    for (const log of Array.isArray(task.agent_logs) ? task.agent_logs : []) {
      items.push({
        project: task.project,
        taskId: task.id,
        taskTitle: task.title,
        agentId: log.agent_id,
        message: log.message,
        timestamp: log.timestamp,
        locked: false,
      })
    }
  }
  return items
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit)
}

// ---------------------------------------------------------------------------
// Unlock storage. The browser keeps ONLY the server-issued unlock token and its
// expiry, in localStorage next to the API token ("stored in this browser
// only"). The master password itself is never stored anywhere.
// ---------------------------------------------------------------------------

export const UNLOCK_KEY = 'kanban.unlock'

export type StoredUnlock = { token: string; exp: number }

/** Parses a stored unlock; null when absent, malformed or expired. */
export function parseStoredUnlock(raw: string | null | undefined, now: number = Date.now()): StoredUnlock | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StoredUnlock>
    if (typeof parsed?.token !== 'string' || parsed.token === '') return null
    if (typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp) || parsed.exp <= now) return null
    return { token: parsed.token, exp: parsed.exp }
  } catch {
    return null
  }
}

export function readStoredUnlock(now: number = Date.now()): StoredUnlock | null {
  try {
    const unlock = parseStoredUnlock(localStorage.getItem(UNLOCK_KEY), now)
    if (!unlock) localStorage.removeItem(UNLOCK_KEY)
    return unlock
  } catch {
    return null
  }
}

export function writeStoredUnlock(unlock: StoredUnlock | null): void {
  try {
    if (unlock) localStorage.setItem(UNLOCK_KEY, JSON.stringify(unlock))
    else localStorage.removeItem(UNLOCK_KEY)
  } catch {
    // Private mode / blocked site data: the browser simply stays locked.
  }
}

/** Header carrying the unlock on reads. Never placed in a URL. */
export function unlockHeaders(unlock: StoredUnlock | null = readStoredUnlock()): Record<string, string> {
  return unlock ? { 'X-Kanban-Unlock': unlock.token } : {}
}

/** What the header box learned about the value the operator typed. */
export type UnlockOutcome =
  | { kind: 'unlocked'; unlock: StoredUnlock }
  | { kind: 'token' }
  | { kind: 'unrecognised' }
  | { kind: 'throttled'; retryAfterMs: number }
  | { kind: 'unverified' }

/** Shown beside the box when the server recognised the value as neither. */
export const UNRECOGNISED_NOTE = 'Not recognised: not saved'

/**
 * Classifies the server's answer to POST /api/auth/unlock. The box only ever
 * persists a value the server RECOGNISES: the master password (exchanged for
 * an unlock token) or a valid board credential (`credential: true`, stored as
 * the API token). Anything else, including a mistyped master password, is
 * `unrecognised` and nothing is stored: it must never be kept in this browser
 * or sent as a bearer token. A throttle or a failure stores nothing either.
 */
export function classifyUnlockResponse(status: number, body: unknown): UnlockOutcome {
  const b = (body ?? {}) as { unlocked?: unknown; credential?: unknown; token?: unknown; expires_at?: unknown; retry_after_ms?: unknown }
  if (status === 200 && b.unlocked === true && typeof b.token === 'string' && typeof b.expires_at === 'number') {
    return { kind: 'unlocked', unlock: { token: b.token, exp: b.expires_at } }
  }
  if (status === 200 && b.unlocked === false && b.credential === true) return { kind: 'token' }
  if (status === 200 && b.unlocked === false) return { kind: 'unrecognised' }
  if (status === 429) {
    return { kind: 'throttled', retryAfterMs: typeof b.retry_after_ms === 'number' ? b.retry_after_ms : 60000 }
  }
  return { kind: 'unverified' }
}

/** What the server says it will serve this browser (GET /api/auth/details). */
export type DetailStatus = { details: boolean; unlock: boolean }

/**
 * The header's lock indicator, from what the SERVER says rather than from what
 * is stored: a stored unlock the server no longer honours is not "unlocked",
 * even on an empty board with no tasks to infer it from. Until the server has
 * answered, only the task data can say "locked".
 */
export function lockIndicator(
  status: DetailStatus | null,
  hasStoredUnlock: boolean,
  tasksLocked: boolean,
): 'unlocked' | 'locked' | 'open' {
  if (status?.unlock === true && hasStoredUnlock && !tasksLocked) return 'unlocked'
  if (tasksLocked || status?.details === false) return 'locked'
  return 'open'
}
