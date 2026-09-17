import { useEffect, useMemo, useState } from 'react'
import type { ProjectSummary, Task } from './types'
import { getProjects, getTasks, subscribeToEvents } from './api'
import Board from './components/Board'
import Portfolio from './components/Portfolio'
import SignalRail from './components/SignalRail'
import TaskSheet from './components/TaskSheet'
import ErrorBoundary from './components/ErrorBoundary'
import { useClaimCoordinator } from './lib/useClaimCoordinator'

/** Sentinel for "every project" in the switcher; '' is not a valid project id. */
const ALL_PROJECTS = ''

export default function App() {
   const [tasks, setTasks] = useState<Task[]>([])
    const [openTaskId, setOpenTaskId] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

     // §2.10: which board is shown, and whether we are on the portfolio view.
    const [project, setProject] = useState<string>(() => {
      if (typeof window === 'undefined') return ALL_PROJECTS
      return localStorage.getItem('kanban.project') ?? ALL_PROJECTS
       })
    const [view, setView] = useState<'board' | 'portfolio'>('board')
    const [projects, setProjects] = useState<ProjectSummary[]>([])

    const selectProject = (next: string) => {
      setProject(next)
      setOpenTaskId(null) // a task sheet from the old scope would be orphaned
      if (typeof window !== 'undefined') {
        if (next) localStorage.setItem('kanban.project', next)
        else localStorage.removeItem('kanban.project')
         }
       }

     // Phase 2.2: an operator can bind this browser to an agent id so the board
    // actively heartbeats + auto-claims on its behalf. Empty = monitor-only.
    // The binding is COMMITTED explicitly (blur or Enter), never per keystroke.
    // Driving the coordinator straight off the input meant typing "builder-1"
    // fired nine auto-claims, eight of them under partial ids ("b", "bu", ...),
    // each one moving a real task to BUILDING with a bogus owner and a live
    // lease. `agentDraft` is what the field shows; `agentId` is what claims.
    const initialAgent =
      typeof window === 'undefined' ? '' : localStorage.getItem('kanban.agentId') ?? ''
    const [agentId, setAgentId] = useState<string>(initialAgent)
    const [agentDraft, setAgentDraft] = useState<string>(initialAgent)
    const commitAgent = () => {
      const next = agentDraft.trim()
      if (next === agentId) return
      setAgentId(next)
      if (typeof window !== 'undefined') {
        if (next) localStorage.setItem('kanban.agentId', next)
        else localStorage.removeItem('kanban.agentId')
         }
       }

     // Drive lease heartbeats + auto-claim for the bound agent off the live
    // task stream. Pure decisions live in lib/claimCoordinator.ts.
    // Scoped to the visible board: an agent bound while viewing one project
    // should claim from that project, not from the whole portfolio.
    const coordinator = useClaimCoordinator({
      agentId: agentId || null,
      tasks,
      projects: project ? [project] : undefined,
       })

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

     // Re-runs on project change: the fetch AND the SSE subscription are both
    // scoped server-side (§2.2), so a scoped board never receives another
    // project's tasks in the first place.
    useEffect(() => {
    let cancelled = false
    const scope = project || undefined
    setLoading(true)

    getTasks(scope)
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
      }, { project: scope })

    return () => {
      cancelled = true
      unsubscribe()
      }
     }, [project])

     // The switcher needs every project, so this stays unscoped. Refreshed off
    // the live task stream rather than a timer.
    useEffect(() => {
    let cancelled = false
    getProjects()
      .then((data) => {
        if (!cancelled) setProjects(data)
        })
      .catch(() => {/* the switcher degrades to the current scope */})
    return () => {
      cancelled = true
      }
     }, [tasks.length])

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
            <select
             value={project}
             onChange={(e) => selectProject(e.target.value)}
             aria-label="Filter the board to one project"
             title="Scope the board, the live stream and auto-claim to one project"
             className="border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink focus:outline-none"
            >
              <option value={ALL_PROJECTS}>all projects</option>
              {projects.map((p) => (
                <option key={p.project} value={p.project}>
                  {p.project} ({p.live_count})
                </option>
              ))}
              {project && !projects.some((p) => p.project === project) && (
                <option value={project}>{project}</option>
              )}
            </select>
            <button
             type="button"
             onClick={() => setView((v) => (v === 'board' ? 'portfolio' : 'board'))}
             className="border border-line bg-surface px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg active:scale-[0.98]"
             aria-pressed={view === 'portfolio'}
             title={view === 'board' ? 'Show the cross-project portfolio' : 'Back to the board'}
            >
              {view === 'board' ? 'Portfolio' : 'Board'}
            </button>
            <input
             type="text"
             value={agentDraft}
             onChange={(e) => setAgentDraft(e.target.value)}
             onBlur={commitAgent}
             onKeyDown={(e) => {
               if (e.key === 'Enter') commitAgent()
               }}
             placeholder="agent id (auto-claim)"
             aria-label="Bind this board to an agent id for auto-claim"
             title="Bind this browser to an agent id to heartbeat + auto-claim its tasks. Press Enter or click away to bind. Empty = monitor only."
             className="border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink placeholder:text-muted focus:outline-none"
           />
           {agentDraft.trim() !== agentId && (
             <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
              unbound · press enter
             </span>
            )}
           {agentId && agentDraft.trim() === agentId && (
             <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
              claim: {coordinator.lastClaimedId ?? '—'}
               {coordinator.lastError ? ` · ${coordinator.lastError}` : ''}
             </span>
            )}
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
           {view === 'portfolio' && (
             <Portfolio
               refreshKey={tasks.length}
               onSelectProject={(next) => {
                 selectProject(next)
                 setView('board')
                 }}
             />
           )}
           {view === 'board' && loading && (
             <div className="flex h-full flex-1 items-center justify-center font-mono text-xs text-muted">
              Loading tasks…
             </div>
           )}
           {view === 'board' && !loading && error && (
             <div className="flex h-full flex-1 items-center justify-center font-mono text-xs text-fail">
               {error}
             </div>
           )}
           {view === 'board' && !loading && !error && (
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
