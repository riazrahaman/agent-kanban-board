import { useState } from 'react'
import ColumnColorsControl from './ColumnColorsControl'
import { SEVERITY_COLORS, type SeverityFilter, type SeverityColor } from '../lib/ownership'
import { readStoredMobileFiltersOpen, writeStoredMobileFiltersOpen } from '../lib/uiSettings'

const SEVERITY_BUBBLES: Array<{ key: SeverityColor; tooltip: string }> = [
  {
    key: 'green',
    tooltip: 'GREEN: separation held — active stages covered by 2+ different agents',
  },
  {
    key: 'amber',
    tooltip: 'AMBER: solo-run — one agent held 2–3 active stages of the same card',
  },
  {
    key: 'red',
    tooltip: 'RED: solo-run severe — same agent walked 4+ active stages — built, reviewed, validated and/or closed its own work',
  },
]

type Props = {
  search: string
  onSearchChange: (search: string) => void
  priority: string
  onPriorityChange: (priority: string) => void
  assignee: string
  onAssigneeChange: (assignee: string) => void
  assignees: string[]
  totalCount: number
  filteredCount: number
  onReset: () => void
  onExport?: () => void
  sort: 'priority' | 'updated' | 'id'
  onSortChange: (sort: 'priority' | 'updated' | 'id') => void
  showMetrics?: boolean
  onToggleMetrics?: () => void
  /** v2.5.0: per-project column colors control. */
  columnColors?: import('../lib/columnColors').ColumnColors | null
  onColumnColorsChange?: (colors: import('../lib/columnColors').ColumnColors) => void
  onColumnColorsReset?: () => void
  /** v2.18.0: active solo-run severity filter (multi-select; empty = show all). */
  severity: SeverityFilter[]
  onSeverityChange: (severity: SeverityFilter[]) => void
}

function SeverityFilterBubbles({
  severity,
  onChange,
}: {
  severity: SeverityFilter[]
  onChange: (severity: SeverityFilter[]) => void
}) {
  const toggle = (key: SeverityColor) => {
    if (severity.includes(key)) {
      onChange(severity.filter((s) => s !== key))
    } else {
      onChange([...severity, key])
    }
  }

  const clear = () => onChange([])

  return (
    <div className="flex items-center gap-1.5">
      {SEVERITY_BUBBLES.map(({ key, tooltip }) => {
        const selected = severity.includes(key)
        return (
          <span key={key} className="inline-flex pointer-coarse:p-2.5 pointer-coarse:-m-2.5">
            <button
              type="button"
              onClick={() => toggle(key)}
              aria-pressed={selected}
              title={tooltip}
              className={[
                'flex h-4 w-4 items-center justify-center rounded-[50%] transition-transform active:scale-[0.92]',
                selected ? 'ring-2 ring-offset-1 ring-ink ring-offset-surface' : '',
              ].join(' ')}
              style={{ backgroundColor: SEVERITY_COLORS[key] }}
            >
              <span className="sr-only">{tooltip}</span>
            </button>
          </span>
        )
      })}
      <span className="inline-flex pointer-coarse:p-2.5 pointer-coarse:-m-2.5">
        <button
          type="button"
          onClick={clear}
          aria-pressed={severity.length === 0}
          title="Show all severities"
          className={[
            'flex h-4 w-4 items-center justify-center rounded-[50%] border border-line bg-muted-bg text-[9px] font-mono text-muted transition-transform active:scale-[0.92]',
            severity.length === 0 ? 'ring-2 ring-offset-1 ring-ink ring-offset-surface' : '',
          ].join(' ')}
        >
          <span aria-hidden="true">·</span>
          <span className="sr-only">Show all severities</span>
        </button>
      </span>
    </div>
  )
}

export default function BoardFilters({
  search,
  onSearchChange,
  priority,
  onPriorityChange,
  assignee,
  onAssigneeChange,
  assignees,
  totalCount,
  filteredCount,
  onReset,
  onExport,
  sort,
  onSortChange,
  showMetrics,
  onToggleMetrics,
  columnColors,
  onColumnColorsChange,
  onColumnColorsReset,
  severity,
  onSeverityChange,
}: Props) {
  const isFiltered = search.trim() !== '' || priority !== 'all' || assignee !== 'all' || severity.length > 0
  // v2.9.1: below sm the priority/assignee/sort/export/colors/metrics controls
  // collapse behind a Filters disclosure. Left to free-wrap they stacked into
  // ~5 rows and squeezed the board to a sliver (mobile-rendering-issues.md
  // Issue 1). Search + the task count stay visible because they are the
  // highest-frequency controls.
  const [filtersOpen, setFiltersOpen] = useState<boolean>(() => readStoredMobileFiltersOpen())

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface/40 px-3 py-2 sm:px-4">
      <div className="relative flex min-w-[180px] max-w-xs flex-1 items-center">
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Filter tasks…"
          aria-label="Filter tasks by search term"
          className="w-full border border-line bg-surface px-2.5 py-1.5 pr-6 font-mono text-[11px] text-ink placeholder:text-muted focus:outline-none sm:py-1 pointer-coarse:min-h-11 pointer-coarse:pr-11"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 font-mono text-xs text-muted hover:text-ink pointer-coarse:right-0 pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:items-center pointer-coarse:justify-center"
            title="Clear search"
          >
            ×
          </button>
        )}
      </div>

      {/* phone-only disclosure for the secondary filter/action controls */}
      <button
        type="button"
        onClick={() => {
          setFiltersOpen((v) => {
            const next = !v
            writeStoredMobileFiltersOpen(next)
            return next
          })
        }}
        aria-pressed={filtersOpen}
        aria-expanded={filtersOpen}
        aria-label="Toggle filters and actions"
        title="Show/hide filters and actions"
        className="border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:bg-muted-bg hover:text-ink active:scale-[0.98] pointer-coarse:min-h-11 sm:hidden"
      >
        {isFiltered ? 'Filters •' : 'Filters'}
      </button>

      <div
        data-testid="filter-controls"
        className={`min-w-0 flex-wrap items-center gap-2 sm:flex ${
          filtersOpen ? 'flex w-full basis-full' : 'hidden'
        }`}
      >
        <select
          value={priority}
          onChange={(e) => onPriorityChange(e.target.value)}
          aria-label="Filter tasks by priority"
          title="Filter by priority"
          className="max-w-full border border-line bg-surface px-2 py-1.5 font-mono text-[11px] text-ink focus:outline-none sm:py-1 pointer-coarse:min-h-11"
        >
          <option value="all">All Priorities</option>
          <option value="high">High (P0 / P1)</option>
          <option value="medium">Medium (P2)</option>
          <option value="low">Low (P3)</option>
        </select>

        <select
          value={assignee}
          onChange={(e) => onAssigneeChange(e.target.value)}
          aria-label="Filter tasks by assignee"
          title="Filter by assignee"
          className="max-w-full border border-line bg-surface px-2 py-1.5 font-mono text-[11px] text-ink focus:outline-none sm:py-1 pointer-coarse:min-h-11"
        >
          <option value="all">All Assignees</option>
          <option value="unassigned">Unassigned</option>
          {assignees.map((agent) => (
            <option key={agent} value={agent.toLowerCase()}>
              {agent}
            </option>
          ))}
        </select>

        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as 'priority' | 'updated' | 'id')}
          aria-label="Sort tasks within columns"
          title="Column ordering (persisted for this browser)"
          className="max-w-full border border-line bg-surface px-2 py-1.5 font-mono text-[11px] text-ink focus:outline-none sm:py-1 pointer-coarse:min-h-11"
        >
          <option value="priority">Sort: Priority</option>
          <option value="updated">Sort: Recently Updated</option>
          <option value="id">Sort: Task ID</option>
        </select>

        <SeverityFilterBubbles severity={severity} onChange={onSeverityChange} />

        {isFiltered && (
          <button
            type="button"
            onClick={onReset}
            aria-label="Reset all filters"
            title="Clear all active filters"
            className="border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:bg-muted-bg hover:text-ink active:scale-[0.98] sm:py-1 pointer-coarse:min-h-11"
          >
            Reset
          </button>
        )}

        {onExport && (
          <button
            type="button"
            onClick={onExport}
            aria-label="Export tasks as JSON"
            title="Export tasks to JSON"
            className="border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:bg-muted-bg hover:text-ink active:scale-[0.98] sm:py-1 pointer-coarse:min-h-11"
          >
            Export
          </button>
        )}

        {onColumnColorsChange && onColumnColorsReset && (
          <ColumnColorsControl
            colors={columnColors ?? null}
            onChange={onColumnColorsChange}
            onReset={onColumnColorsReset}
          />
        )}

        {onToggleMetrics && (
          <button
            type="button"
            onClick={onToggleMetrics}
            aria-pressed={showMetrics}
            aria-label="Toggle metrics dashboard"
            title="Toggle summary metrics dashboard"
            className={[
              'border px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors active:scale-[0.98] sm:py-1 pointer-coarse:min-h-11',
              showMetrics
                ? 'border-ink bg-muted-bg text-ink font-semibold'
                : 'border-line bg-surface text-muted hover:bg-muted-bg hover:text-ink',
            ].join(' ')}
          >
            Metrics
          </button>
        )}
      </div>

      <div className="ml-auto shrink-0 text-right font-mono text-[10px] uppercase tracking-wider text-muted sm:w-auto">
        {isFiltered ? (
          <span>
            {filteredCount} of {totalCount} tasks
          </span>
        ) : (
          <span>{totalCount} tasks</span>
        )}
      </div>
    </div>
  )
}
