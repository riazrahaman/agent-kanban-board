import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { ProjectSummary, Task } from './types'
import { getHealth, getProjects, getTasks, subscribeToEvents } from './api'
import { isDark, nextTheme, resolveTheme, THEME_STORAGE_KEY } from './lib/theme'
import Board from './components/Board'
import BoardFilters from './components/BoardFilters'
import About from './components/About'
import Portfolio from './components/Portfolio'
import ProjectPicker from './components/ProjectPicker'
import SignalRail from './components/SignalRail'
import TaskSheet from './components/TaskSheet'
import HeaderHelp from './components/HeaderHelp'
import ErrorBoundary from './components/ErrorBoundary'
import { useClaimCoordinator } from './lib/useClaimCoordinator'
import { readStoredToken, writeStoredToken } from './lib/authToken'
import { filterTasks } from './lib/filterTasks'
import { normalizePriority, PRIORITY_WEIGHT } from './priority'

/** Sentinel for "every project" in the switcher; '' is not a valid project id. */
const ALL_PROJECTS = ''

/**
 * Deep-link support: a `?project=<id>` query (as sent in reclaim alert links)
 * wins over the last-used scope, so opening an alert lands on the board already
 * scoped to that task's project. Falls back to the persisted scope, then to
 * "all projects". The stale-scope recovery below still runs, so a link to a
 * project that no longer exists resets cleanly instead of showing an empty board.
 */
function initialProject(): string {
  if (typeof window === 'undefined') return ALL_PROJECTS
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('project')
    if (fromUrl) return fromUrl
  } catch {
    // Malformed/unavailable URL — fall through to the persisted scope.
  }
  return localStorage.getItem('kanban.project') ?? ALL_PROJECTS
}

export default function App() {
   const [tasks, setTasks] = useState<Task[]>([])
    const [openTaskId, setOpenTaskId] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

     // §2.10: which board is shown, and whether we are on the portfolio view.
    const [project, setProject] = useState<string>(initialProject)
    const [view, setView] = useState<'board' | 'portfolio' | 'about'>('board')
    const [projects, setProjects] = useState<ProjectSummary[]>([])
    // True once the (unscoped) project list has settled, so the stale-scope
    // recovery below never fires against an empty, not-yet-loaded list.
    const [projectsLoaded, setProjectsLoaded] = useState(false)
    // Phones hide the signal rail to leave room for the board; this control
    // lets it slide in as an overlay on demand. Desktop ignores it (rail is
    // always docked from md up).
    const [railOpen, setRailOpen] = useState(false)
    // Deployed server version, shown in the header so operators can tell at a
    // glance which build is live. Sourced from /api/health (server/package.json).
    const [version, setVersion] = useState<string | null>(null)

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

     // The server rejects every mutation without a token, so the operator supplies
    // one here. Deliberately not a build-time env var: Vite inlines those into the
    // published bundle, which would ship the shared write secret to every visitor.
    const [tokenDraft, setTokenDraft] = useState<string>(() => readStoredToken())
    const [tokenSaved, setTokenSaved] = useState<boolean>(() => readStoredToken() !== '')
    const commitToken = () => {
      writeStoredToken(tokenDraft)
      setTokenSaved(tokenDraft.trim() !== '')
       }
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
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      return resolveTheme(localStorage.getItem(THEME_STORAGE_KEY), prefersDark)
      }
    return 'dark'
      })

    // Apply the class before paint so the first frame already matches the
    // resolved theme (no light flash for dark users, no dark flash for light).
    useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', isDark(theme))
    localStorage.setItem(THEME_STORAGE_KEY, theme)
     }, [theme])

     // Re-runs on project change: the fetch AND the SSE subscription are both
    // scoped server-side (§2.2), so a scoped board never receives another
    // project's tasks in the first place.
    useEffect(() => {
    let cancelled = false
    const scope = project || undefined
    setLoading(true)
    // Clear the previous failure too: without this, one failed load left the
    // board showing a stale error forever, because the render guard is
    // `!loading && error` and nothing else ever reset it — so a later
    // successful fetch loaded tasks that were never displayed.
    setError(null)

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
      .finally(() => {
        if (!cancelled) setProjectsLoaded(true)
        })
    return () => {
      cancelled = true
      }
     }, [tasks.length])

     // Stale-scope auto-recovery (§client bugfix): a persisted project id that
    // no longer exists on this board (e.g. `test-kanbann` from an older
    // deployment) would scope both the fetch and the SSE stream to nothing, so
    // the board showed 0 tasks with no explanation. Once the project list has
    // loaded, reset the scope to "all projects" (which also clears the stale
    // localStorage key via selectProject).
    useEffect(() => {
      if (!projectsLoaded) return
      if (project && !projects.some((p) => p.project === project)) {
        selectProject(ALL_PROJECTS)
      }
      }, [projectsLoaded, project, projects])

  // Persist a deep-linked `?project=` scope and drop the query param, so a
  // later reload keeps the operator's choice without re-applying a stale link.
  // Runs once on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const fromUrl = new URLSearchParams(window.location.search).get('project')
    if (!fromUrl) return
    selectProject(fromUrl)
    window.history.replaceState(null, '', window.location.pathname)
  }, [])


  // Fetch the deployed version once on mount; failure just hides the chip.
  useEffect(() => {
    let cancelled = false
    getHealth()
      .then((h) => {
        if (!cancelled) setVersion(h.version)
      })
      .catch(() => {/* the header simply omits the version */})
    return () => {
      cancelled = true
    }
  }, [])

  const [searchQuery, setSearchQuery] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('all')
  const [assigneeFilter, setAssigneeFilter] = useState('all')

  const assignees = useMemo(() => {
    const set = new Set<string>()
    for (const t of tasks) {
      if (t.assigned_agent) set.add(t.assigned_agent)
    }
    return Array.from(set).sort()
  }, [tasks])

  const filteredTasks = useMemo(() => {
    const list = filterTasks(tasks, {
      search: searchQuery,
      priority: priorityFilter,
      assignee: assigneeFilter,
    })
    return [...list].sort((a, b) => {
      const wa = PRIORITY_WEIGHT[normalizePriority(a.priority)] ?? 1
      const wb = PRIORITY_WEIGHT[normalizePriority(b.priority)] ?? 1
      return wa - wb
    })
  }, [tasks, searchQuery, priorityFilter, assigneeFilter])

  const resetFilters = useCallback(() => {
    setSearchQuery('')
    setPriorityFilter('all')
    setAssigneeFilter('all')
  }, [])

  const openTask = useMemo(
     () => tasks.find((t) => t.id === openTaskId) ?? null,
     [tasks, openTaskId],
  )

  const handleOpen = useCallback((id: string) => setOpenTaskId(id), [])

  return (
     <div className="flex h-screen flex-col bg-bg text-ink">
       <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-3 py-2.5 sm:px-4">
         <div className="flex shrink-0 items-center gap-3">
           <span className="h-2 w-2 bg-live animate-pulse" aria-label="Live connection" />
           <div className="flex items-baseline gap-2">
            <h1 className="whitespace-nowrap font-serif text-lg font-normal tracking-tight text-ink">
              Agent Kanban Board
            </h1>
            {version && (
              <span
                className="font-mono text-[10px] text-muted"
                title={`Deployed server version (${version})`}
              >
                v{version}
              </span>
            )}
           </div>
         </div>
         <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 md:gap-3">
            <ProjectPicker value={project} projects={projects} onChange={selectProject} />
            <div
             role="group"
             aria-label="Switch between the board, the portfolio and the about page"
             className="flex items-stretch border border-line bg-surface"
            >
              {([
                ['board', 'Board', 'Show the task board'],
                ['portfolio', 'Portfolio', 'Show the cross-project portfolio'],
                ['about', 'About', 'About this project'],
              ] as const).map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setView(value)}
                  aria-pressed={view === value}
                  title={hint}
                  className={`px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors active:scale-[0.98] ${
                    view === value ? 'bg-muted-bg text-ink' : 'text-muted hover:bg-muted-bg hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
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
             className="w-32 border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink placeholder:text-muted focus:outline-none sm:w-40"
            />
            <input
             type="password"
             value={tokenDraft}
             onChange={(e) => setTokenDraft(e.target.value)}
             onBlur={commitToken}
             onKeyDown={(e) => {
               if (e.key === 'Enter') commitToken()
               }}
             placeholder="api token"
             aria-label="API token for mutating requests"
             title="Required for claim, heartbeat and log writes. Stored in this browser only; sent as an Authorization header, never in a URL. With per-project tokens configured, use the token for the project you are working in."
             autoComplete="off"
             spellCheck={false}
             className="w-28 border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink placeholder:text-muted focus:outline-none"
           />
            <HeaderHelp />
            {!tokenSaved && (
             <span
              className="hidden font-mono text-[10px] uppercase tracking-wider text-muted sm:inline"
              title="Reads work without a token; claim, heartbeat and log writes will return 401."
             >
              read-only
             </span>
            )}
           {agentDraft.trim() !== agentId && (
             <span className="hidden font-mono text-[10px] uppercase tracking-wider text-muted lg:inline">
              unbound · press enter
             </span>
           )}
           {agentId && agentDraft.trim() === agentId && (
             <span className="hidden font-mono text-[10px] uppercase tracking-wider text-muted lg:inline">
              claim: {coordinator.lastClaimedId ?? '—'}
               {coordinator.lastError ? ` · ${coordinator.lastError}` : ''}
             </span>
           )}
           <span className="hidden font-mono text-xs tabular-nums text-ink px-2 py-0.5 border border-line bg-muted-bg sm:inline">
             {tasks.length} tasks
           </span>
           <button
            type="button"
            onClick={() => setRailOpen((v) => !v)}
            aria-pressed={railOpen}
            aria-label="Toggle signal rail"
            title="Show/hide the signal overview + activity rail"
            className="border border-line bg-surface px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg active:scale-[0.98] md:hidden"
           >
             Signal
           </button>
           <button
            type="button"
             onClick={() => setTheme(nextTheme)}
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
            {view === 'about' && <About version={version} />}
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
            {view === 'board' && !loading && !error && tasks.length === 0 && (
              <div className="flex h-full flex-1 flex-col items-center justify-center gap-1 font-mono text-xs text-muted">
                {project ? (
                  <>
                    <span>No tasks in “{project}”.</span>
                    <span>Pick “all projects” from the switcher, or add a task via the API.</span>
                  </>
                ) : (
                  <>
                    <span>No tasks yet.</span>
                    <span>Add one via the API (see ONBOARDING.md), or bind an agent id to auto-claim.</span>
                  </>
                )}
              </div>
            )}
            {view === 'board' && !loading && !error && tasks.length > 0 && (
              <>
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  <BoardFilters
                    search={searchQuery}
                    onSearchChange={setSearchQuery}
                    priority={priorityFilter}
                    onPriorityChange={setPriorityFilter}
                    assignee={assigneeFilter}
                    onAssigneeChange={setAssigneeFilter}
                    assignees={assignees}
                    totalCount={tasks.length}
                    filteredCount={filteredTasks.length}
                    onReset={resetFilters}
                  />
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <Board tasks={filteredTasks} onOpen={handleOpen} showProject={!project} />
                  </div>
                </div>
                {/* Desktop: docked rail. Mobile: it would eat the whole board,
                    so it becomes an on-demand overlay toggled from the header. */}
                <div className="hidden md:flex">
                  <SignalRail tasks={tasks} onOpen={handleOpen} />
                </div>
                {railOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-30 bg-ink/40 md:hidden"
                      onClick={() => setRailOpen(false)}
                      aria-hidden="true"
                    />
                    <div className="fixed right-0 top-0 z-40 flex h-full border-l border-line bg-surface md:hidden">
                      <SignalRail tasks={tasks} onOpen={handleOpen} />
                    </div>
                  </>
                )}
             </>
           )}
         </ErrorBoundary>
       </main>

       <TaskSheet task={openTask} onClose={() => setOpenTaskId(null)} />
     </div>
   )
}
