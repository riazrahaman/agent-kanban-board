import type { Task } from './types'

const API_BASE = (import.meta.env.VITE_API_BASE ?? 'http://localhost:4000/api')

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Request failed (${res.status}): ${text}`)
  }
  return res.json() as Promise<T>
}

export async function getTasks(): Promise<Task[]> {
  const res = await fetch(`${API_BASE}/tasks`)
  return handleResponse<Task[]>(res)
}

export async function getTask(id: string): Promise<Task> {
  const res = await fetch(`${API_BASE}/tasks/${id}`)
  return handleResponse<Task>(res)
}

export async function patchTask(id: string, patch: Partial<Task>): Promise<Task> {
  const res = await fetch(`${API_BASE}/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return handleResponse<Task>(res)
}

export async function claimTask(id: string, agentId: string): Promise<Task> {
  const res = await fetch(`${API_BASE}/tasks/${id}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId }),
  })
  return handleResponse<Task>(res)
}

export async function appendLog(id: string, agentId: string, message: string): Promise<Task> {
  const res = await fetch(`${API_BASE}/tasks/${id}/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, message }),
  })
  return handleResponse<Task>(res)
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
    source.removeEventListener('tasks', handler as EventListener)
    source.close()
  }
}
