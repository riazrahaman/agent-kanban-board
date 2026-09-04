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
    <div className="flex h-screen flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-emerald-600 dark:bg-emerald-500" />
          <h1 className="text-sm font-semibold tracking-wide text-zinc-900 dark:text-zinc-100">
            Agent Kanban Board
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">{tasks.length} tasks</span>
          <button
            type="button"
            onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
            className="flex items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-200 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            aria-label="Toggle theme"
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? (
              <>
                <span aria-hidden>☀️</span>
                <span>Light</span>
              </>
            ) : (
              <>
                <span aria-hidden>🌙</span>
                <span>Dark</span>
              </>
            )}
          </button>
        </div>
      </header>

        <main className="flex flex-1 overflow-hidden">
       <ErrorBoundary>
          {loading && (
            <div className="flex h-full flex-1 items-center justify-center text-sm text-zinc-500">
             Loading tasks…
            </div>
          )}
          {!loading && error && (
            <div className="flex h-full flex-1 items-center justify-center text-sm text-red-600 dark:text-red-400">
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
