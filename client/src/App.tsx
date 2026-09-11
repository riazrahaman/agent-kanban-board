import { useEffect, useMemo, useState } from 'react'
import type { Task } from './types'
import { getTasks, subscribeToEvents } from './api'
import Board from './components/Board'
import SignalRail from './components/SignalRail'
import TaskSheet from './components/TaskSheet'
import ErrorBoundary from './components/ErrorBoundary'

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('theme')
      if (saved === 'light' || saved === 'dark') {
        return saved
      }
    }
    return 'dark'
  })

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
    localStorage.setItem('theme', theme)
  }, [theme])

  useEffect(() => {
    let cancelled = false

    getTasks()
      .then((data) => {
        if (!cancelled) setTasks(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load tasks')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    const unsubscribe = subscribeToEvents((nextTasks) => {
      setTasks(nextTasks)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const openTask = useMemo(
    () => tasks.find((t) => t.id === openTaskId) ?? null,
    [tasks, openTaskId],
  )

  return (
    <div className="flex h-screen flex-col bg-bg text-ink">
      <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="h-2 w-2 bg-live animate-pulse" aria-label="Live connection" />
          <div className="flex items-baseline gap-2">
            <h1 className="font-serif text-lg font-normal tracking-tight text-ink">
              Agent Kanban Board
            </h1>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
              loop ops
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs tabular-nums text-ink px-2 py-0.5 border border-line bg-muted-bg">
            {tasks.length} tasks
          </span>
          <button
            type="button"
            onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
            className="border border-line bg-surface px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg active:scale-[0.98]"
            aria-label="Toggle theme"
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </header>

      <main className="flex flex-1 overflow-hidden">
        <ErrorBoundary>
          {loading && (
            <div className="flex h-full flex-1 items-center justify-center font-mono text-xs text-muted">
              Loading tasks…
            </div>
          )}
          {!loading && error && (
            <div className="flex h-full flex-1 items-center justify-center font-mono text-xs text-fail">
              {error}
            </div>
          )}
          {!loading && !error && (
            <>
              <div className="min-w-0 flex-1 overflow-hidden">
                <Board tasks={tasks} onOpen={setOpenTaskId} />
              </div>
              <SignalRail tasks={tasks} onOpen={setOpenTaskId} />
            </>
          )}
        </ErrorBoundary>
      </main>

      <TaskSheet task={openTask} onClose={() => setOpenTaskId(null)} />
    </div>
  )
}
