import type { Task, ProjectSummary, MetricsResponse } from './types'
import { authHeaders, readStoredToken } from './lib/authToken'

// Same-origin `/api`: the deployed server serves the client bundle AND the API
// on one origin, so a relative base works everywhere (local dev proxies it via
// vite.config.ts, Render serves it directly). `VITE_API_BASE` remains an escape
const API_BASE = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE) || '/api'

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
 * §2.3c (ENH-01) — headers for a READ. Reads are open by default, but when the
 * server sets KANBAN_READ_AUTH=token every GET must present the bearer token.
 * Sending it unconditionally is harmless (an open-read server ignores it), so
 * the same header set is used whether or not the deployment gates reads.
 */
function readHeaders(): Record<string, string> {
  return { ...authHeaders(readStoredToken()) }
}

/**
 * Headers for EVERY mutating request. Single choke point on purpose: the server
 * rejects a mutation without both a token (401) and a valid role (403), so a new
 * mutation that built its own headers would silently fail auth. Carries the
 * §2.6 version guard too — an `If-Match` (Etag-style bare int) when a `version`
 * is supplied; routes also accept an `expected_version` body field.
 */
function mutationHeaders(opts: MutationOptions = {}): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const v = opts.version ?? opts.expected_version
  if (v !== undefined) headers['If-Match'] = String(v)
  return { ...headers, ...authHeaders(readStoredToken()) }
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
  const res = await fetch(withProject(`${API_BASE}/tasks`, project), { headers: readHeaders() })
  return handleResponse<Task[]>(res)
}

export async function getTask(id: string, project?: string): Promise<Task> {
  const res = await fetch(withProject(`${API_BASE}/tasks/${id}`, project), { headers: readHeaders() })
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
    headers: mutationHeaders(opts),
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
    headers: mutationHeaders(opts),
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
    headers: mutationHeaders(opts),
    body: JSON.stringify({ agent_id: agentId, message, ...(opts.expected_version !== undefined ? { expected_version: opts.expected_version } : {}) }),
   })
  return handleVersionedResponse<Task>(res)
}

/**
 * v2.5.0 — append a comment to a card's discussion thread (mirrors appendLog).
 */
export async function addComment(
  id: string,
  agentId: string,
  message: string,
  opts: MutationOptions = {},
): Promise<Task> {
  const project = opts.project
  const res = await fetch(withProject(`${API_BASE}/tasks/${id}/comments`, project), {
    method: 'POST',
    headers: mutationHeaders(opts),
    body: JSON.stringify({ agent_id: agentId, message, ...(opts.expected_version !== undefined ? { expected_version: opts.expected_version } : {}) }),
   })
  return handleVersionedResponse<Task>(res)
}

/**
 * §2.4 — renew the lease on a held task. The holder (or a privileged role)
 * extends `claim_expires_at` by the server's `KANBAN_CLAIM_TTL_MS`. A 409 with a
 * `reason` (`not_lease_holder` / `not_claimed`) signals a non-holder or an
 * unclaimed task; callers surface it and stop reusing the lease.
 */
export async function heartbeatTask(
  id: string,
  agentId: string,
  opts: MutationOptions = {},
): Promise<Task> {
  const project = opts.project
  const res = await fetch(withProject(`${API_BASE}/tasks/${id}/heartbeat`, project), {
    method: 'POST',
    headers: mutationHeaders(opts),
    body: JSON.stringify({ agent_id: agentId }),
   })
  if (!res.ok) {
    let body: any = null
    try {
      body = await res.json()
     } catch {
      body = null
     }
     // A lease 409 carries a `reason` so callers can tell "not the holder" from
     // "not claimed" apart from a contention 409.
    const detail = body ? ` (${body.reason || body.error || res.statusText})` : ` (${res.statusText})`
    throw new Error(`heartbeat failed (${res.status})${detail}`)
   }
  return handleResponse<Task>(res)
}

/**
 * §2.7 — atomically claim the highest-priority, unclaimed, dependency-satisfied
 * BACKLOG task. Returns the claimed `Task`, or `null` when nothing is claimable
 * (204). A `reason`-tagged 409 (e.g. `dependency_unsatisfied`) is surfaced as an
 * Error so the caller can branch on it; a contention 409 is also an Error.
 */
export async function nextClaim(
  agentId: string,
  opts: { role?: string; project?: string } = {},
): Promise<Task | null> {
  // agent_id and role travel in the body, not the query: the route falls back to
  // req.body / req.caller for both, and putting identifiers in a URL only serves
  // to copy them into every access log.
  const params = new URLSearchParams()
  if (opts.project) params.set('project', opts.project)
  const query = params.toString()
  const res = await fetch(`${API_BASE}/tasks/next-claim${query ? `?${query}` : ''}`, {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify({ agent_id: agentId, ...(opts.role ? { role: opts.role } : {}) }),
    })
   if (res.status === 204) {
    return null
   }
  if (!res.ok) {
    let body: any = null
    try {
      body = await res.json()
     } catch {
      body = null
     }
     const detail = body ? ` (${body.reason || body.error || res.statusText})` : ` (${res.statusText})`
    throw new Error(`next-claim failed (${res.status})${detail}`)
   }
  return handleResponse<Task>(res)
}

/**
 * §health — deployed server version + liveness. Open GET.
 * GET /health
 */
export async function getHealth(): Promise<{ version: string; status: string }> {
  const res = await fetch(`${API_BASE}/health`, { headers: readHeaders() })
  return handleResponse<{ version: string; status: string }>(res)
}

/**
 * §2.1 — portfolio of projects with live/done/archived counts.
 * GET /projects
 */
export async function getProjects(): Promise<ProjectSummary[]> {
  const res = await fetch(`${API_BASE}/projects`, { headers: readHeaders() })
  return handleResponse<ProjectSummary[]>(res)
}

/**
 * §2.9 — per-project + aggregate observability. Open GET.
 * GET /metrics[?project=]
 */
export async function getMetrics(project?: string): Promise<MetricsResponse> {
  const res = await fetch(withProject(`${API_BASE}/metrics`, project), { headers: readHeaders() })
  return handleResponse<MetricsResponse>(res)
}

/**
 * §2.8 — archived (DONE, aged-out) tasks. Open GET.
 * GET /tasks/archive[?project=]
 */
export async function getArchivedTasks(project?: string): Promise<Task[]> {
  const res = await fetch(withProject(`${API_BASE}/tasks/archive`, project), { headers: readHeaders() })
  return handleResponse<Task[]>(res)
}

// ---------------------------------------------------------------------------
// v2.5.0 — per-project display settings (column colors)
// ---------------------------------------------------------------------------

export type SettingsResponse = {
  project: string | null
  column_colors: Record<string, string>
}

/** Read the resolved column colors (stock -> board default -> project override). */
export async function getSettings(project?: string): Promise<SettingsResponse> {
  const res = await fetch(withProject(`${API_BASE}/settings`, project), { headers: readHeaders() })
  return handleResponse<SettingsResponse>(res)
}

/** Persist a project's column_colors override. Any authenticated token may. */
export async function saveSettings(
  project: string | undefined,
  columnColors: Record<string, string>,
): Promise<SettingsResponse> {
  const res = await fetch(withProject(`${API_BASE}/settings`, project), {
    method: 'PUT',
    headers: mutationHeaders({ project }),
    body: JSON.stringify({ column_colors: columnColors }),
  })
  return handleResponse<SettingsResponse>(res)
}

/**
 * §2.3c (ENH-01) — mint a short-lived single-use stream ticket so an EventSource
 * can authenticate (it cannot set request headers). Only attempted when a token
 * is stored; a deployment with KANBAN_READ_AUTH off simply leaves the stream
 * open and this resolves null.
 */
async function mintStreamTicket(project?: string): Promise<string | null> {
  if (!readStoredToken()) return null
  try {
    const res = await fetch(`${API_BASE}/auth/stream-ticket`, {
      method: 'POST',
      headers: mutationHeaders({ project }),
      body: JSON.stringify({ ...(project ? { project } : {}) }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { ticket?: string }
    return body.ticket ?? null
  } catch {
    return null
  }
}

function streamUrl(path: string, project: string | undefined, ticket: string | null): string {
  const params = new URLSearchParams()
  if (project) params.set('project', project)
  if (ticket) params.set('ticket', ticket)
  const query = params.toString()
  return `${API_BASE}${path}${query ? `?${query}` : ''}`
}

/**
 * Subscribes to the server's SSE task stream and invokes `onTasks` every time
 * the server broadcasts the full task array. Returns an unsubscribe function
 * that closes the underlying EventSource.
 */
export function subscribeToEvents(
  onTasks: (tasks: Task[]) => void,
  { project }: { project?: string } = {},
): () => void {
  let source: EventSource | null = null
  let cancelled = false

  const open = (ticket: string | null) => {
    if (cancelled) return
    source = new EventSource(streamUrl('/events', project, ticket))
    source.addEventListener('tasks', handler as EventListener)
    source.onerror = () => {
      // EventSource auto-reconnects; a ticket is single-use so a reconnect to a
      // read-gated stream would 401. Log only — the operator can refresh.
      console.error('SSE connection error')
    }
  }

  const handler = (evt: MessageEvent<string>) => {
    try {
      const tasks = JSON.parse(evt.data) as Task[]
      onTasks(tasks)
    } catch (err) {
      console.error('Failed to parse SSE tasks payload', err)
    }
  }

  mintStreamTicket(project).then((ticket) => open(ticket))

  return () => {
    cancelled = true
    if (source) {
      source.removeEventListener('tasks', handler as EventListener)
      source.close()
    }
  }
}

/** The per-task event kinds the server's diff stream can emit (§2.2). */
export const DIFF_KINDS = [
  'created', 'updated', 'removed', 'archived',
  'claimed', 'renewed', 'unblocked', 'reclaimed',
] as const

export type DiffKind = (typeof DIFF_KINDS)[number]

/**
 * v2.5.0 — subscribe to the SSE `settings` event (resolved column colors).
 * Opens its own EventSource; returns an unsubscribe function.
 */
export function subscribeToSettings(
  onSettings: (settings: SettingsResponse) => void,
  { project }: { project?: string } = {},
): () => void {
  let source: EventSource | null = null
  let cancelled = false

  const handler = (evt: MessageEvent<string>) => {
    try {
      onSettings(JSON.parse(evt.data) as SettingsResponse)
    } catch (err) {
      console.error('Failed to parse SSE settings payload', err)
    }
  }

  const open = (ticket: string | null) => {
    if (cancelled) return
    source = new EventSource(streamUrl('/events', project, ticket))
    source.addEventListener('settings', handler as EventListener)
    source.onerror = () => {
      // EventSource auto-reconnects; settings are display-only so stay quiet.
    }
  }

  mintStreamTicket(project).then((ticket) => open(ticket))

  return () => {
    cancelled = true
    if (source) {
      source.removeEventListener('settings', handler as EventListener)
      source.close()
    }
  }
}

export interface DiffEvent {
  kind: DiffKind
  task: Task
  /** The previous revision; null for a creation. */
  prev: Task | null
  project: string
  /** The agent that caused the mutation, or 'system' for reaper/unlock/archive. */
  actor: string
  reason: string | null
  ts: number
}

/**
 * Subscribes to the server's per-task diff stream (§2.2, now the DEFAULT mode
 * via PERF-01), optionally scoped to one project. Unlike `subscribeToEvents` —
 * which re-broadcasts the whole task array on every mutation — this delivers
 * exactly one event per changed task. An optional `onSettings` callback
 * receives the `event: settings` frames the combined stream now carries
 * (PERF-01c). Returns an unsubscribe that closes the EventSource.
 */
export function subscribeToDiffs(
  onEvent: (event: DiffEvent) => void,
  opts: { project?: string; onSettings?: (settings: SettingsResponse) => void } = {},
): () => void {
  let source: EventSource | null = null
  let cancelled = false
  let attached: Array<readonly [string, (evt: MessageEvent<string>) => void]> = []

  const open = (ticket: string | null) => {
    if (cancelled) return
    const params = new URLSearchParams({ mode: 'diff' })
    if (opts.project) params.set('project', opts.project)
    if (ticket) params.set('ticket', ticket)
    source = new EventSource(`${API_BASE}/events?${params.toString()}`)

    attached = DIFF_KINDS.map((kind) => {
      const handler = (evt: MessageEvent<string>) => {
        try {
          onEvent(JSON.parse(evt.data) as DiffEvent)
        } catch (err) {
          console.error(`Failed to parse SSE task.${kind} payload`, err)
        }
      }
      source!.addEventListener(`task.${kind}`, handler as EventListener)
      return [`task.${kind}`, handler] as const
    })

    if (opts.onSettings) {
      const settingsHandler = (evt: MessageEvent<string>) => {
        try {
          opts.onSettings!(JSON.parse(evt.data) as SettingsResponse)
        } catch (err) {
          console.error('Failed to parse SSE settings payload', err)
        }
      }
      source.addEventListener('settings', settingsHandler as EventListener)
      attached = [...attached, ['settings', settingsHandler] as const]
    }

    source.onerror = (err) => {
      // EventSource auto-reconnects on its own; just log for visibility.
      console.error('SSE diff connection error', err)
    }
  }

  mintStreamTicket(opts.project).then((ticket) => open(ticket))

  return () => {
    cancelled = true
    for (const [name, handler] of attached) {
      source?.removeEventListener(name, handler as EventListener)
    }
    source?.close()
  }
}

/**
 * PERF-01 — combined diff + settings board subscription. The default SSE mode
 * is now `diff` (no `?mode=snapshot`), and the server carries `event: settings`
 * on the same stream. This opens ONE EventSource that (i) applies `task.<kind>`
 * events to the local tasks array via `onDiffEvent`, and (ii) receives
 * `event: settings` via `onSettings`. The client relies on its own
 * `getTasks()` fetch for initial priming (no `?prime=1`).
 */
export function subscribeToBoard(
  onDiffEvent: (event: DiffEvent) => void,
  onSettings: (settings: SettingsResponse) => void,
  { project }: { project?: string } = {},
): () => void {
  return subscribeToDiffs(onDiffEvent, { project, onSettings })
}
