import type { Task, ProjectSummary } from './types'

const API_BASE = (import.meta.env.VITE_API_BASE ?? 'http://localhost:4000/api')

/**
 * §2.6 optimistic-concurrency surface.
 *
 * A 409 VersionConflict tells a caller its held `version` is stale: the server
 * advanced past the version the caller read. The error carries `currentVersion`
 * (and `details { expected, provided }`) so a caller can re-fetch the task and
 * re-apply its patch against the fresh base instead of clobbering it. `status:
 * 409` plus `isConflict === true` distinguishes this from a claim-contention 409
 * ("… already claimed by …"), which has no `currentVersion`.
 */
export class ConflictError extends Error {
  readonly status = 409
  readonly code = 'VERSION_CONFLICT'
  readonly isConflict = true
  readonly currentVersion: number
  readonly details?: { expected: number; provided: number }

  constructor(message: string, opts: { currentVersion: number; details?: { expected: number; provided: number } } = { currentVersion: -1 }) {
    super(message)
    this.name = 'ConflictError'
    this.currentVersion = opts.currentVersion ?? -1
    this.details = opts.details
  }
}

interface MutationOptions {
  /** §2.6: expected CAS version; sent as the `If-Match` header when set. */
  version?: number
  /** §2.1: optional project scope (sent as `?project=`). */
  project?: string
  /** §2.6: body-supplied expected version, equivalent to `version`/`If-Match`. */
  expected_version?: number
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Request failed (${res.status}): ${text}`)
  }
  return res.json() as Promise<T>
}

function withProject(base: string, project?: string): string {
  return project ? `${base}?project=${encodeURIComponent(project)}` : base
}

/**
 * Builds the version-guard request payload: an `If-Match` header (Etag-style bare
 * int) when a `version` is supplied, and an `expected_version` body field when
 * `expected_version` is supplied — the route accepts either.
 */
function versionGuardHeaders(opts: MutationOptions): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const v = opts.version ?? opts.expected_version
  if (v !== undefined) headers['If-Match'] = String(v)
  return headers
}

/**
 * Throws a `ConflictError` on a 409 version-conflict so callers can re-fetch +
 * re-apply. A contention 409 or any other error falls through to `handleResponse`'s
 * generic throw.
 */
async function handleVersionedResponse<T>(res: Response): Promise<T> {
  if (res.status === 409) {
    let body: any = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    // A version conflict carries currentVersion / details; a contention 409 does
    // not, so it is not surfaced as a ConflictError.
    if (body && (body.currentVersion !== undefined || body.details)) {
      throw new ConflictError(
        body.error || 'Version mismatch',
        { currentVersion: body.currentVersion, details: body.details },
      )
    }
    // Non-version 409 (e.g. claim contention): keep the original semantics.
    const text = (body ? JSON.stringify(body) : res.statusText) as string
    throw new Error(`Request failed (409): ${text}`)
  }
  return handleResponse<T>(res)
}

export async function getTasks(project?: string): Promise<Task[]> {
  const res = await fetch(withProject(`${API_BASE}/tasks`, project))
  return handleResponse<Task[]>(res)
}

export async function getTask(id: string, project?: string): Promise<Task> {
  const res = await fetch(withProject(`${API_BASE}/tasks/${id}`, project))
  return handleResponse<Task>(res)
}

/**
 * §2.6: pass `opts.version` (or `opts.expected_version`) to CAS-guard this
 * PATCH. A stale guard rejects with a `ConflictError` carrying `currentVersion`
 * so the caller can re-fetch and re-apply instead of clobbering.
 */
export async function patchTask(
  id: string,
  patch: Partial<Task>,
  opts: MutationOptions = {},
): Promise<Task> {
  const project = opts.project
  const res = await fetch(withProject(`${API_BASE}/tasks/${id}`, project), {
    method: 'PATCH',
    headers: versionGuardHeaders(opts),
    body: JSON.stringify({ ...patch, ...(opts.expected_version !== undefined ? { expected_version: opts.expected_version } : {}) }),
  })
  return handleVersionedResponse<Task>(res)
}

export async function claimTask(
  id: string,
  agentId: string,
  opts: MutationOptions = {},
): Promise<Task> {
  const project = opts.project
  const res = await fetch(withProject(`${API_BASE}/tasks/${id}/claim`, project), {
    method: 'POST',
    headers: versionGuardHeaders(opts),
    body: JSON.stringify({ agent_id: agentId, ...(opts.expected_version !== undefined ? { expected_version: opts.expected_version } : {}) }),
  })
  return handleVersionedResponse<Task>(res)
}

export async function appendLog(
  id: string,
  agentId: string,
  message: string,
  opts: MutationOptions = {},
): Promise<Task> {
  const project = opts.project
  const res = await fetch(withProject(`${API_BASE}/tasks/${id}/logs`, project), {
    method: 'POST',
    headers: versionGuardHeaders(opts),
    body: JSON.stringify({ agent_id: agentId, message, ...(opts.expected_version !== undefined ? { expected_version: opts.expected_version } : {}) }),
  })
  return handleVersionedResponse<Task>(res)
}

/**
 * §2.1 — portfolio of projects with live/done/archived counts.
 * GET /projects
 */
export async function getProjects(): Promise<ProjectSummary[]> {
  const res = await fetch(`${API_BASE}/projects`)
  return handleResponse<ProjectSummary[]>(res)
}

/**
 * §2.8 — archived (DONE, aged-out) tasks. Open GET.
 * GET /tasks/archive[?project=]
 */
export async function getArchivedTasks(project?: string): Promise<Task[]> {
  const res = await fetch(withProject(`${API_BASE}/tasks/archive`, project))
  return handleResponse<Task[]>(res)
}

/**
 * Subscribes to the server's SSE task stream and invokes `onTasks` every time
 * the server broadcasts the full task array. Returns an unsubscribe function
 * that closes the underlying EventSource.
 */
export function subscribeToEvents(onTasks: (tasks: Task[]) => void): () => void {
  const source = new EventSource(`${API_BASE}/events`)

  const handler = (evt: MessageEvent<string>) => {
    try {
      const tasks = JSON.parse(evt.data) as Task[]
      onTasks(tasks)
    } catch (err) {
      console.error('Failed to parse SSE tasks payload', err)
    }
  }

  source.addEventListener('tasks', handler as EventListener)

  source.onerror = (err) => {
    // EventSource auto-reconnects on its own; just log for visibility.
    console.error('SSE connection error', err)
  }

  return () => {
    source.removeEventListener('tasks', handler)
    source.close()
  }
}
