import { useState } from 'react'
import type { Task } from '../types'
import { appendLog } from '../api'
import { normalizePriority } from '../priority'
import { formatStageOwners } from '../lib/stageOwners'
import StatusBadge from './StatusBadge'

const PRIORITY_BADGE: Record<Task['priority'], string> = {
  high: 'bg-down-bg text-down border-line',
  medium: 'bg-warn-bg text-warn border-line',
  low: 'bg-muted-bg text-muted border-line',
}

type Props = {
  task: Task | null
  onClose: () => void
}

function formatTimestamp(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toISOString().replace('T', ' ').slice(0, 19) + 'Z'
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
          'fixed inset-0 z-40 bg-ink/30 dark:bg-ink/70 transition-opacity',
          open ? 'opacity-100 pointer-events-auto' : 'pointer-events-none opacity-0',
        ].join(' ')}
        onClick={onClose}
      />

      <aside
        className={[
          'fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col',
          'border-l border-line bg-surface transition-transform duration-200',
          open ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
      >
        {task && (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-line p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1.5">
                  {/* Identifier, not prose — one line, ellipsised, full value in
                      the tooltip. Same reasoning as TaskCard's header id. */}
                  <span
                    className="min-w-0 truncate font-mono text-xs tabular-nums text-ink tracking-wider"
                    title={task.id}
                  >
                    {task.id}
                  </span>
                </div>
                <h2 className="text-base font-semibold leading-snug text-ink break-words [overflow-wrap:anywhere]">
                  {task.title}
                </h2>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
                  <span
                    className={`border px-1.5 py-0.5 uppercase tracking-wider ${PRIORITY_BADGE[normalizePriority(task.priority)]}`}
                  >
                    {task.priority}
                  </span>
                  <StatusBadge status={task.status} />
                  {task.project && (
                    <span
                      className="min-w-0 max-w-[12rem] truncate border border-line bg-muted-bg px-1.5 py-0.5 text-muted"
                      title={`Project: ${task.project}`}
                    >
                      {task.project}
                    </span>
                  )}
                  {task.assigned_agent && (
                    <span
                      className="min-w-0 max-w-[14rem] truncate border border-line bg-muted-bg px-1.5 py-0.5 text-ink tabular-nums"
                      title={task.assigned_agent}
                    >
                      {task.assigned_agent}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="p-1 font-mono text-xs text-muted hover:text-ink transition-colors"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <section>
                <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                  Description
                </h3>
                <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-ink break-words [overflow-wrap:anywhere]">
                  {task.description || 'No description provided.'}
                </p>
              </section>

              {task.stage_owners && Object.keys(task.stage_owners).length > 0 && (
                <section>
                  <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                    Stage Owners
                  </h3>
                  <p
                    className="mt-1.5 min-w-0 truncate font-mono text-[11px] text-muted"
                    title={formatStageOwners(task.stage_owners)}
                  >
                    {formatStageOwners(task.stage_owners)}
                  </p>
                </section>
              )}

              {task.metadata && Object.keys(task.metadata).length > 0 && (
                <section>
                  <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                    Metadata
                  </h3>
                  <pre className="mt-1.5 max-h-48 overflow-auto border border-line bg-muted-bg p-2.5 font-mono text-xs tabular-nums text-ink">
                    {JSON.stringify(task.metadata, null, 2)}
                  </pre>
                </section>
              )}

              <section>
                <div className="flex items-center justify-between">
                  <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                    Agent Log
                  </h3>
                  <span className="font-mono text-[10px] tabular-nums text-muted">
                    {task.agent_logs.length} {task.agent_logs.length === 1 ? 'entry' : 'entries'}
                  </span>
                </div>
                <div className="mt-2 space-y-2">
                  {[...task.agent_logs]
                    .sort(
                      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
                    )
                    .map((log, i) => (
                      <div
                        key={`${log.timestamp}-${i}`}
                        className="border border-line bg-surface p-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          {/* Same flex-squash hazard: an identifier in a
                              justify-between row. min-w-0 + truncate keeps it one
                              line; the timestamp is pinned so it can't be squeezed. */}
                          <span
                            className="min-w-0 truncate border border-line bg-muted-bg px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink"
                            title={log.agent_id}
                          >
                            {log.agent_id}
                          </span>
                          <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink">
                            {formatTimestamp(log.timestamp)}
                          </span>
                        </div>
                        <p className="mt-1.5 text-xs leading-relaxed text-ink whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                          {log.message}
                        </p>
                      </div>
                    ))}
                  {task.agent_logs.length === 0 && (
                    <p className="font-mono text-xs text-muted py-2">No log entries yet.</p>
                  )}
                </div>
              </section>
            </div>

            <form
              onSubmit={handleSubmit}
              className="space-y-2 border-t border-line p-4 bg-surface"
            >
              <input
                type="text"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="Agent ID"
                className="w-full border border-line bg-bg px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-muted focus:border-ink focus:outline-none"
              />
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Add a log message..."
                rows={3}
                className="w-full resize-none border border-line bg-bg px-2.5 py-1.5 text-xs text-ink placeholder:text-muted focus:border-ink focus:outline-none"
              />
              {error && <p className="font-mono text-xs text-fail break-words [overflow-wrap:anywhere]">{error}</p>}
              <button
                type="submit"
                disabled={submitting || !message.trim()}
                className="w-full bg-ink text-bg px-3 py-2 font-mono text-xs font-medium uppercase tracking-wider transition-opacity hover:opacity-85 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
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
