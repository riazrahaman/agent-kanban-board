import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { ProjectSummary, Task } from './types'
import { getBugReportConfig, getHealth, getProjects, getSettings, getTasks, saveSettings, subscribeToBoard } from './api'
import type { DiffEvent } from './api'
import type { ColumnColors } from './lib/columnColors'
import { isStockPalette, readStoredColumnColors, writeStoredColumnColors } from './lib/columnColors'
import {
  readStoredFilters,
  writeStoredFilters,
  resetStoredFilters,
  readStoredShowMetrics,
  writeStoredShowMetrics,
  readStoredView,
  writeStoredView,
  readStoredRailOpen,
  writeStoredRailOpen,
} from './lib/uiSettings'
import {
  isDark,
  modeLabel,
  nextMode,
  parseStoredMode,
  resolveMode,
  themeToggleTitle,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from './lib/theme'
import Board from './components/Board'
import BoardFilters from './components/BoardFilters'
import About from './components/About'
import Portfolio from './components/Portfolio'
import MetricsDashboard from './components/MetricsDashboard'
import ProjectPicker from './components/ProjectPicker'
import SignalRail from './components/SignalRail'
import TaskSheet from './components/TaskSheet'
import BugReportDialog from './components/BugReportDialog'
import HeaderHelp from './components/HeaderHelp'
import ErrorBoundary from './components/ErrorBoundary'
import { useClaimCoordinator } from './lib/useClaimCoordinator'
import { useVisitCount } from './lib/useVisitCount'
import { readStoredToken, writeStoredToken } from './lib/authToken'
import { filterTasks } from './lib/filterTasks'
import { readStoredSort, sortTasks, writeStoredSort, type BoardSort } from './lib/boardSort'

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
    const [view, setView] = useState<'board' | 'portfolio' | 'about'>(() => readStoredView())
    const [projects, setProjects] = useState<ProjectSummary[]>([])
    // True once the (unscoped) project list has settled, so the stale-scope
    // recovery below never fires against an empty, not-yet-loaded list.
    const [projectsLoaded, setProjectsLoaded] = useState(false)
    // Phones hide the signal rail to leave room for the board; this control
    // lets it slide in as an overlay on demand. Desktop ignores it (rail is
    // always docked from md up).
    const [railOpen, setRailOpen] = useState<boolean>(() => readStoredRailOpen())
  // v2.9.1: on phones the header's secondary controls collapse behind a "⋯"
  // disclosure. Left expanded they wrapped to ~8 rows and ate most of the
  // viewport, squeezing the board to an unusable sliver (see
  // mobile-rendering-issues.md Issue 1).
  const [headerOpen, setHeaderOpen] = useState(false)
    // Deployed server version, shown in the header so operators can tell at a
    // glance which build is live. Sourced from /api/health (server/package.json).
    const [version, setVersion] = useState<string | null>(null)
    // Visit counter runs at the app shell, not inside About: it must count every
    // site load (a board-first visitor may never open the About tab), and the
    // footer label ("Visit count so far") promises site traffic. Passed down to
    // About as props.
    const visit = useVisitCount()

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

    // v2.17.0 (theme-auto): tri-state — 'auto' follows the OS preference and
    // is the default for a visitor with no stored choice; 'light'/'dark' are
    // explicit and win outright. `themeMode` is what is stored; `theme` is
    // the resolved value actually applied to the DOM.
    const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
      if (typeof window === 'undefined') return 'auto'
      return parseStoredMode(localStorage.getItem(THEME_STORAGE_KEY))
    })
    // Live OS preference, kept current by the matchMedia listener below so
    // Auto mode re-paints the instant the OS setting changes — no reload
    // needed. Only read when themeMode is 'auto'; an explicit light/dark
    // choice ignores it entirely.
    const [prefersDark, setPrefersDark] = useState<boolean>(() =>
      typeof window === 'undefined'
        ? true
        : window.matchMedia('(prefers-color-scheme: dark)').matches,
    )
    const theme = resolveMode(themeMode, prefersDark)

    // Apply the class before paint so the first frame already matches the
    // resolved theme (no light flash for dark users, no dark flash for light).
    useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', isDark(theme))
    // Stored explicitly in all three modes, including 'auto' — see
    // lib/theme.ts's doc comment for why that is simpler than removing the
    // key, and client/index.html's pre-paint script for the matching read.
    localStorage.setItem(THEME_STORAGE_KEY, themeMode)
     }, [theme, themeMode])

    // Auto mode must live-update when the OS setting changes (not just on
    // next load). `change` fires on this MediaQueryList whenever
    // `prefers-color-scheme` flips while the page is open.
    useEffect(() => {
      if (typeof window === 'undefined') return
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const onChange = (e: MediaQueryListEvent) => setPrefersDark(e.matches)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }, [])

     // Re-runs on project change: the fetch AND the SSE subscription are both
    // scoped server-side (§2.2), so a scoped board never receives another
    // project's tasks in the first place.
    // PERF-01: the SSE stream is now diff+settings combined (ONE EventSource).
    // The client primes via GET /api/tasks, then applies per-task `task.<kind>`
    // events by upsert on the local tasks array, and receives `event: settings`
    // on the same stream.
    useEffect(() => {
    let cancelled = false
    const scope = project || undefined
    setLoading(true)
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

    // Apply a single diff event to the local tasks array by upsert.
    // Match on project + id; on removed/archived, drop it.
    const applyDiff = (evt: DiffEvent) => {
      if (cancelled) return
      setTasks((prev) => {
        const kind = evt.kind
        if (kind === 'removed' || kind === 'archived') {
          return prev.filter(
            (t) => !(t.id === evt.task.id && (t.project ?? '') === (evt.project ?? '')),
          )
        }
        // Upsert: replace if present (match project + id), else append.
        const idx = prev.findIndex(
          (t) => t.id === evt.task.id && (t.project ?? '') === (evt.project ?? ''),
        )
        if (idx >= 0) {
          const next = prev.slice()
          next[idx] = evt.task
          return next
        }
        return [...prev, evt.task]
      })
    }

    const applySettings = (s: { column_colors: Record<string, string> }) => {
      if (!cancelled && s?.column_colors) {
        const colors = s.column_colors as ColumnColors
        setColumnColors(colors)
        writeStoredColumnColors(project || undefined, colors)
      }
    }

    const unsubscribe = subscribeToBoard(applyDiff, applySettings, { project: scope })

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

  // v2.16.0 (opt-public-bug-reports): fetch once on mount, fail quiet. The
  // entry point (header + About CTA) only renders when the operator has
  // configured the feature; the dialog itself needs the public site key.
  const [bugReportEnabled, setBugReportEnabled] = useState(false)
  const [bugReportSiteKey, setBugReportSiteKey] = useState<string | null>(null)
  const [bugReportOpen, setBugReportOpen] = useState(false)
  useEffect(() => {
    let cancelled = false
    getBugReportConfig()
      .then((cfg) => {
        if (cancelled) return
        setBugReportEnabled(cfg.enabled)
        setBugReportSiteKey(cfg.siteKey ?? null)
      })
      .catch(() => {/* stays disabled; the entry point simply never appears */})
    return () => {
      cancelled = true
    }
  }, [])

  const initialFilters = useMemo(() => readStoredFilters(), [])
  const [searchQuery, setSearchQuery] = useState(initialFilters.search)
  const [priorityFilter, setPriorityFilter] = useState(initialFilters.priority)
  const [assigneeFilter, setAssigneeFilter] = useState(initialFilters.assignee)
  // Column ordering is an explicit, persisted control (default: priority).
  // Unlike the removed local reorder buttons, the choice survives SSE
  // snapshots and reloads, because it re-applies on every new tasks array.
  const [boardSort, setBoardSort] = useState<BoardSort>(readStoredSort)

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
    return sortTasks(list, boardSort)
  }, [tasks, searchQuery, priorityFilter, assigneeFilter, boardSort])

  const handleSearchChange = useCallback((next: string) => {
    setSearchQuery(next)
    writeStoredFilters({ search: next })
  }, [])

  const handlePriorityChange = useCallback((next: string) => {
    setPriorityFilter(next)
    writeStoredFilters({ priority: next })
  }, [])

  const handleAssigneeChange = useCallback((next: string) => {
    setAssigneeFilter(next)
    writeStoredFilters({ assignee: next })
  }, [])

  const handleSortChange = useCallback((next: BoardSort) => {
    setBoardSort(next)
    writeStoredSort(next)
  }, [])

  const resetFilters = useCallback(() => {
    setSearchQuery('')
    setPriorityFilter('all')
    setAssigneeFilter('all')
    resetStoredFilters()
  }, [])

  const handleExport = useCallback(() => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(tasks, null, 2))
    const downloadAnchor = document.createElement('a')
    downloadAnchor.setAttribute('href', dataStr)
    downloadAnchor.setAttribute(
      'download',
      `kanban-export-${project || 'all'}-${new Date().toISOString().slice(0, 10)}.json`,
    )
    document.body.appendChild(downloadAnchor)
    downloadAnchor.click()
    downloadAnchor.remove()
  }, [tasks, project])

  const openTask = useMemo(
     () => tasks.find((t) => t.id === openTaskId) ?? null,
     [tasks, openTaskId],
  )

  const [showMetrics, setShowMetrics] = useState<boolean>(() => readStoredShowMetrics())
  const handleToggleMetrics = useCallback(() => {
    setShowMetrics((v) => {
      const next = !v
      writeStoredShowMetrics(next)
      return next
    })
  }, [])
  const handleCloseMetrics = useCallback(() => {
    setShowMetrics(false)
    writeStoredShowMetrics(false)
  }, [])

  // v2.5.0: per-project column colors, resolved server-side. The initial fetch
  // loads the current palette on project change; live updates now arrive via
  // the combined diff+settings SSE stream (PERF-01) wired in the task effect
  // above, so no separate settings EventSource is opened. Saved optimistically
  // through PUT /api/settings and cached locally in localStorage (v2.14.4).
  const [columnColors, setColumnColors] = useState<ColumnColors | null>(() =>
    readStoredColumnColors(initialProject()),
  )
  useEffect(() => {
    let cancelled = false
    const local = readStoredColumnColors(project || undefined)
    if (local) setColumnColors(local)

    getSettings(project || undefined)
      .then((s) => {
        if (!cancelled && s?.column_colors) {
          const colors = s.column_colors as ColumnColors
          if (!isStockPalette(colors)) {
            setColumnColors(colors)
            writeStoredColumnColors(project || undefined, colors)
          } else if (local) {
            setColumnColors(local)
            saveSettings(project || undefined, local).catch(() => {})
          } else {
            setColumnColors(colors)
          }
        }
      })
      .catch(() => {
        // Display-only: leave the stock palette on failure.
      })
    return () => {
      cancelled = true
    }
  }, [project])
  const handleColumnColorsChange = useCallback((colors: ColumnColors) => {
    setColumnColors(colors)
    writeStoredColumnColors(project || undefined, colors)
    saveSettings(project || undefined, colors).catch(() => {
      // Revert silently is safest visually-neutral option: keep the optimistic
      // value but let the next SSE/fetch re-sync.
    })
  }, [project])
  const handleColumnColorsReset = useCallback(() => {
    setColumnColors(null)
    writeStoredColumnColors(project || undefined, null)
    saveSettings(project || undefined, {}).catch(() => {})
  }, [project])

  const handleOpen = useCallback((id: string) => setOpenTaskId(id), [])

  // v2.17.0 round 3 (tester-caught WebKit header-wrap defect — see the
  // icon+theme wrapper's JSX comment below for the full mechanism): the bug
  // icon's own footprint (27px mouse / 44px coarse pointer) has to come
  // from somewhere in the header-controls row or that row wraps one line
  // earlier with the icon on than off. CSS flex line-breaking decides wraps
  // using each item's unshrunk basis (its width property), so a min-width
  // floor on an already-shrinkable item changes nothing about WHERE the row
  // wraps (verified empirically with a fine-grained Chromium + WebKit width
  // sweep — a min-width floor never moved a wrap point in either engine).
  // Only an actual reduction of the specified width moves it, so the token
  // input (short placeholder, lots of slack vs its sm:w-36 box) absorbs it
  // instead of the agent id input (sm:w-64 is sized tight to its own
  // longer placeholder — responsive.test.mjs pins it for that reason).
  // Scoped to md (the row is only tight there) and reset at xl (agent id
  // drops to xl:w-52 and the row gap drops to xl:gap-2, so there is slack
  // again) — confirmed by the fine sweep in check-header-layout.mjs: no
  // reduction is needed at or above 1280px.
  const tokenInputBugIconClawback = bugReportEnabled
    ? 'md:w-[calc(9rem-27px)] md:pointer-coarse:w-[calc(9rem-44px)] xl:w-36'
    : ''

  return (
     <div className="flex h-screen flex-col bg-bg text-ink">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-surface px-3 py-2 sm:px-4 sm:py-2.5">
          <div className="flex shrink-0 items-center gap-3">
            <span className="h-2 w-2 bg-live animate-pulse" aria-label="Live connection" />
            <div className="flex items-baseline gap-2">
             <h1 className="whitespace-nowrap font-serif text-base font-normal tracking-tight text-ink sm:text-lg">
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
          {/* v2.9.1: phone-only disclosure. Collapses the header's secondary
              controls so they cannot wrap the board into a sliver. The view
              switcher below stays visible because navigation is primary. */}
          <button
            type="button"
            onClick={() => setHeaderOpen((v) => !v)}
            aria-pressed={headerOpen}
            aria-expanded={headerOpen}
            aria-label="Toggle board controls"
            title="Show/hide the board controls (project, identity, theme)"
            className="ml-auto border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg active:scale-[0.98] sm:py-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11 md:hidden"
          >
            {headerOpen ? 'Close' : '⋯'}
          </button>
          <div className="order-last flex w-full min-w-0 flex-wrap items-center gap-2 md:order-none md:ml-auto md:w-auto md:flex-nowrap md:gap-3 xl:gap-2">
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
                  onClick={() => {
                    setView(value)
                    writeStoredView(value)
                  }}
                  aria-pressed={view === value}
                  title={hint}
                  className={`px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors active:scale-[0.98] sm:py-1 pointer-coarse:min-h-11 ${
                    view === value ? 'bg-muted-bg text-ink' : 'text-muted hover:bg-muted-bg hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div
              data-testid="header-controls"
              className={`min-w-0 flex-wrap items-center gap-2 md:flex md:gap-3 xl:gap-2 ${
                headerOpen ? 'flex w-full basis-full' : 'hidden'
              }`}
            >
             <ProjectPicker value={project} projects={projects} onChange={selectProject} />
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
             className="w-36 border border-line bg-surface px-2 py-1.5 font-mono text-[11px] text-ink placeholder:text-muted focus:outline-none sm:w-64 xl:w-52 2xl:w-64 sm:py-1 pointer-coarse:min-h-11"
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
             className={`w-28 min-w-0 border border-line bg-surface px-2 py-1.5 font-mono text-[11px] text-ink placeholder:text-muted focus:outline-none sm:w-36 sm:py-1 pointer-coarse:min-h-11 ${tokenInputBugIconClawback}`}
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
            onClick={() => {
              setRailOpen((v) => {
                const next = !v
                writeStoredRailOpen(next)
                return next
              })
            }}
            aria-pressed={railOpen}
            aria-label="Toggle signal rail"
            title="Show/hide the signal overview + activity rail"
            className="border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg active:scale-[0.98] sm:py-1 pointer-coarse:min-h-11 md:hidden"
           >
             Signal
           </button>
           {/* v2.17.0: the bug icon sits immediately beside the theme toggle
               in one nowrap flex group (shrink-0) so the two are always
               adjacent and never split apart by the row's own wrapping —
               and so the pair's combined width is the ONE thing that has to
               clear scripts/check-header-layout.mjs's header-height guard,
               not two independently-wrapping controls. No gap and a shared
               border (the icon's own `border-r-0` butts flush against the
               theme button's left border) instead of two separately
               bordered-and-gapped boxes. The wrapper itself carries no
               border/padding of its own, so with the icon absent (flag off)
               the theme button renders exactly as it did before this
               feature existed — zero layout change.

               Tester-caught regression (v2.17.0 round 2): a plain `-ml-2`
               margin trick here only clawed back 8px — less than the
               icon's own footprint (27px mouse / 44px coarse, the latter
               from `pointer-coarse:min-w-11`) — so the header-controls row
               (data-testid="header-controls", a `flex-wrap` row) wrapped
               one row earlier with the icon ON than OFF in a real browser,
               in narrow bands invisible to check-header-layout.mjs's
               coarse-grained width list and to headless-Chrome-only
               verification (confirmed with Playwright WebKit iPhone
               emulation AND a fine Chromium width sweep — both engines, not
               WebKit-only). A margin claw-back that size would have to dig
               into the PRECEDING sibling's own box, not just the row gap,
               so it was dropped. The real fix is on the api-token input
               below: its width is cut by exactly this icon's footprint
               (pointer-type-aware) only across the md–lg band where the
               row is otherwise tight (see its comment) so the two headers
               stay byte-for-byte identical in height at every width. */}
           <div className="flex shrink-0 items-stretch">
             {bugReportEnabled && (
               <button
                 type="button"
                 onClick={() => setBugReportOpen(true)}
                 aria-label="Report a bug"
                 title="Report a bug"
                 className="flex items-center justify-center border border-r-0 border-line bg-surface px-1.5 py-1.5 text-muted transition-colors hover:bg-muted-bg hover:text-ink active:scale-[0.98] sm:py-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
               >
                 <svg
                   viewBox="0 0 16 16"
                   width="14"
                   height="14"
                   fill="none"
                   stroke="currentColor"
                   strokeWidth="1.3"
                   strokeLinecap="round"
                   strokeLinejoin="round"
                   aria-hidden="true"
                 >
                   <ellipse cx="8" cy="9.2" rx="3.4" ry="4.1" />
                   <path d="M8 5.1V3.2M5.6 4.4 4.4 3.1M10.4 4.4 11.6 3.1" />
                   <path d="M4.6 7.3h-2M4.6 9.6h-1.8M4.6 12h-2" />
                   <path d="M11.4 7.3h2M11.4 9.6h1.8M11.4 12h2" />
                   <path d="M5.2 6.3a2.9 2.9 0 0 1 5.6 0" />
                 </svg>
               </button>
             )}
             <button
               type="button"
               onClick={() => setThemeMode(nextMode)}
               className="w-16 shrink-0 border border-line bg-surface py-1.5 text-center font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg active:scale-[0.98] sm:py-1 pointer-coarse:min-h-11"
               aria-label="Toggle theme"
               title={themeToggleTitle(themeMode)}
             >
               {modeLabel(themeMode)}
             </button>
           </div>
            </div>
          </div>
        </header>

        <main className="flex flex-1 overflow-hidden">
          <ErrorBoundary>
            {view === 'about' && (
              <About version={version} visit={visit}
                bugReportEnabled={bugReportEnabled}
                onReportBug={() => setBugReportOpen(true)}
              />
            )}
            {view === 'portfolio' && (
             <Portfolio
               refreshKey={tasks.length}
               onSelectProject={(next) => {
                 selectProject(next)
                 setView('board')
                 writeStoredView('board')
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
                    onSearchChange={handleSearchChange}
                    priority={priorityFilter}
                    onPriorityChange={handlePriorityChange}
                    assignee={assigneeFilter}
                    onAssigneeChange={handleAssigneeChange}
                    assignees={assignees}
                    totalCount={tasks.length}
                    filteredCount={filteredTasks.length}
                    onReset={resetFilters}
                    onExport={handleExport}
                    sort={boardSort}
                    onSortChange={handleSortChange}
                    showMetrics={showMetrics}
                    onToggleMetrics={handleToggleMetrics}
                    columnColors={columnColors}
                    onColumnColorsChange={handleColumnColorsChange}
                    onColumnColorsReset={handleColumnColorsReset}
                  />
                  {showMetrics && (
                    <MetricsDashboard
                      tasks={tasks}
                      onClose={handleCloseMetrics}
                    />
                  )}
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <Board
                      tasks={filteredTasks}
                      onOpen={handleOpen}
                      showProject={!project}
                      columnColors={columnColors}
                    />
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
                      className="fixed inset-0 z-30 bg-black/40 dark:bg-black/60 md:hidden"
                      onClick={() => {
                        setRailOpen(false)
                        writeStoredRailOpen(false)
                      }}
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
       <BugReportDialog
         open={bugReportOpen}
         siteKey={bugReportSiteKey}
         onClose={() => setBugReportOpen(false)}
       />
     </div>
   )
}
