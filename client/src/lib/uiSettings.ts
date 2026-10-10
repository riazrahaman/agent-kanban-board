// v2.14.4 — persistent main page display settings and filters.
//
// All interactive display settings (search query, priority filter, assignee filter,
// metrics dashboard visibility, view mode, signal rail open state, mobile filters disclosure)
// are persisted to localStorage so they survive browser refreshes.

export type AppView = 'board' | 'portfolio' | 'about'

export interface StoredFilters {
  search: string
  priority: string
  assignee: string
}

export const DEFAULT_FILTERS: StoredFilters = Object.freeze({
  search: '',
  priority: 'all',
  assignee: 'all',
})

export const FILTERS_STORAGE_KEY = 'kanban.filters'
export const METRICS_STORAGE_KEY = 'kanban.showMetrics'
export const VIEW_STORAGE_KEY = 'kanban.view'
export const RAIL_STORAGE_KEY = 'kanban.railOpen'
export const MOBILE_FILTERS_STORAGE_KEY = 'kanban.mobileFiltersOpen'
export const HEADER_STORAGE_KEY = 'kanban.headerOpen'

export function isValidView(val: unknown): val is AppView {
  return val === 'board' || val === 'portfolio' || val === 'about'
}

/** Read persisted filters (search, priority, assignee). */
export function readStoredFilters(): StoredFilters {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_FILTERS }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_FILTERS }
    return {
      search: typeof parsed.search === 'string' ? parsed.search : DEFAULT_FILTERS.search,
      priority: typeof parsed.priority === 'string' ? parsed.priority : DEFAULT_FILTERS.priority,
      assignee: typeof parsed.assignee === 'string' ? parsed.assignee : DEFAULT_FILTERS.assignee,
    }
  } catch {
    return { ...DEFAULT_FILTERS }
  }
}

/** Persist updated filters to localStorage. */
export function writeStoredFilters(filters: Partial<StoredFilters>): void {
  try {
    const current = readStoredFilters()
    const next: StoredFilters = {
      search: filters.search !== undefined ? filters.search : current.search,
      priority: filters.priority !== undefined ? filters.priority : current.priority,
      assignee: filters.assignee !== undefined ? filters.assignee : current.assignee,
    }
    if (next.search === '' && next.priority === 'all' && next.assignee === 'all') {
      localStorage.removeItem(FILTERS_STORAGE_KEY)
    } else {
      localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(next))
    }
  } catch {
    // Non-fatal
  }
}

/** Clear all stored filters back to defaults. */
export function resetStoredFilters(): void {
  try {
    localStorage.removeItem(FILTERS_STORAGE_KEY)
  } catch {
    // Non-fatal
  }
}

/** Read persisted metrics dashboard toggle. */
export function readStoredShowMetrics(): boolean {
  try {
    return localStorage.getItem(METRICS_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/** Persist metrics dashboard visibility. */
export function writeStoredShowMetrics(show: boolean): void {
  try {
    if (show) localStorage.setItem(METRICS_STORAGE_KEY, 'true')
    else localStorage.removeItem(METRICS_STORAGE_KEY)
  } catch {
    // Non-fatal
  }
}

/** Read persisted view mode ('board' | 'portfolio' | 'about'), falling back to URL search param. */
export function readStoredView(): AppView {
  try {
    if (typeof window !== 'undefined' && window.location?.search) {
      const fromUrl = new URLSearchParams(window.location.search).get('view')
      if (isValidView(fromUrl)) return fromUrl
    }
    const raw = localStorage.getItem(VIEW_STORAGE_KEY)
    return isValidView(raw) ? raw : 'board'
  } catch {
    return 'board'
  }
}

/** Persist active view mode. */
export function writeStoredView(view: AppView): void {
  try {
    if (view === 'board') localStorage.removeItem(VIEW_STORAGE_KEY)
    else localStorage.setItem(VIEW_STORAGE_KEY, view)
  } catch {
    // Non-fatal
  }
}

/** Read persisted signal rail toggle. */
export function readStoredRailOpen(): boolean {
  try {
    return localStorage.getItem(RAIL_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/** Persist signal rail open/closed state. */
export function writeStoredRailOpen(open: boolean): void {
  try {
    if (open) localStorage.setItem(RAIL_STORAGE_KEY, 'true')
    else localStorage.removeItem(RAIL_STORAGE_KEY)
  } catch {
    // Non-fatal
  }
}

/** Read mobile filters disclosure state. */
export function readStoredMobileFiltersOpen(): boolean {
  try {
    return localStorage.getItem(MOBILE_FILTERS_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/** Persist mobile filters disclosure state. */
export function writeStoredMobileFiltersOpen(open: boolean): void {
  try {
    if (open) localStorage.setItem(MOBILE_FILTERS_STORAGE_KEY, 'true')
    else localStorage.removeItem(MOBILE_FILTERS_STORAGE_KEY)
  } catch {
    // Non-fatal
  }
}

/** Read persisted header disclosure open state. */
export function readStoredHeaderOpen(): boolean {
  try {
    return localStorage.getItem(HEADER_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/** Persist header disclosure open state. */
export function writeStoredHeaderOpen(open: boolean): void {
  try {
    if (open) localStorage.setItem(HEADER_STORAGE_KEY, 'true')
    else localStorage.removeItem(HEADER_STORAGE_KEY)
  } catch {
    // Non-fatal
  }
}
