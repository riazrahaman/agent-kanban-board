import { useState } from 'react'
import type { Task } from '../types'
import { appendLog } from '../api'
import { normalizePriority } from '../priority'

const PRIORITY_BADGE: Record<Task['priority'], string> = {
  high: 'bg-red-500/10 dark:bg-red-500/15 text-red-600 dark:text-red-400 border-red-200 dark:border-red-500/30',
  medium: 'bg-amber-500/10 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-500/30',
  low: 'bg-zinc-500/10 dark:bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-500/30',
}

type Props = {
  task: Task | null
  onClose: () => void
}

function formatTimestamp(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function TaskSheet({ task, onClose }: Props) {
  const [agentId, setAgentId] = useState('Human')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = !!task

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!task || !message.trim()) return

    setSubmitting(true)
    setError(null)
    try {
      await appendLog(task.id, agentId.trim() || 'Human', message.trim())
      setMessage('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit log')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div
        className={[
          'fixed inset-0 z-40 bg-black/40 dark:bg-black/60 transition-opacity',
          open ? 'opacity-100 pointer-events-auto' : 'pointer-events-none opacity-0',
        ].join(' ')}
        onClick={onClose}
      />

      <aside
        className={[
          'fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col',
          'border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xl transition-transform duration-200',
          open ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
      >
        {task && (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-zinc-200 dark:border-zinc-800 p-4">
              <div>
                <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{task.title}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                   <span
                     className={`rounded-full border px-2.5 py-0.5 text-[11px] capitalize ${PRIORITY_BADGE[normalizePriority(task.priority)]}`}
                    >
                    {task.priority}
                  </span>
                  <span className="rounded-full border border-zinc-200 dark:border-zinc-700 px-2 py-0.5 text-[11px] capitalize text-zinc-600 dark:text-zinc-400">
                    {task.status.replace('_', ' ')}
                  </span>
                  {task.assigned_agent && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-700 dark:text-zinc-300">
                      <span aria-hidden>👤</span>
                      {task.assigned_agent}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="rounded-md p-1 text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Description
                </h3>
                <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
                  {task.description || 'No description provided.'}
                </p>
              </section>

              <section className="mt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Metadata
                </h3>
                <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/60 p-2 text-xs text-zinc-600 dark:text-zinc-400">
                  {JSON.stringify(task.metadata ?? {}, null, 2)}
                </pre>
              </section>

              <section className="mt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Agent Log
                </h3>
                <div className="mt-2 space-y-2">
                  {[...task.agent_logs]
                    .sort(
                      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
                    )
                    .map((log, i) => (
                      <div
                        key={`${log.timestamp}-${i}`}
                        className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40 p-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="rounded-full bg-zinc-200 dark:bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-700 dark:text-zinc-300">
                            {log.agent_id}
                          </span>
                          <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                            {formatTimestamp(log.timestamp)}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-zinc-800 dark:text-zinc-300">{log.message}</p>
                      </div>
                    ))}
                  {task.agent_logs.length === 0 && (
                    <p className="text-sm text-zinc-400 dark:text-zinc-600">No log entries yet.</p>
                  )}
                </div>
              </section>
            </div>

            <form
              onSubmit={handleSubmit}
              className="space-y-2 border-t border-zinc-200 dark:border-zinc-800 p-4"
            >
              <input
                type="text"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="Agent ID"
                className="w-full rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800 px-2 py-1.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 focus:border-zinc-400 dark:focus:border-zinc-600 focus:outline-none"
              />
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Add a log message..."
                rows={3}
                className="w-full resize-none rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800 px-2 py-1.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 focus:border-zinc-400 dark:focus:border-zinc-600 focus:outline-none"
              />
              {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={submitting || !message.trim()}
                className="w-full rounded-md bg-zinc-900 dark:bg-zinc-100 px-3 py-1.5 text-sm font-medium text-white dark:text-zinc-900 transition-colors hover:bg-zinc-800 dark:hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Submitting…' : 'Add log entry'}
              </button>
            </form>
          </>
        )}
      </aside>
    </>
  )
}
