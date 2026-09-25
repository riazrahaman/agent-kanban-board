import ColumnColorsControl from './ColumnColorsControl'

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
}: Props) {
  const isFiltered = search.trim() !== '' || priority !== 'all' || assignee !== 'all'

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface/40 px-3 py-2 sm:px-4">
      <div className="relative flex min-w-[180px] max-w-xs flex-1 items-center">
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Filter by title, desc, id…"
          aria-label="Filter tasks by search term"
          className="w-full border border-line bg-surface px-2.5 py-1 pr-6 font-mono text-[11px] text-ink placeholder:text-muted focus:outline-none"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 font-mono text-xs text-muted hover:text-ink"
            title="Clear search"
          >
            ×
          </button>
        )}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <select
          value={priority}
          onChange={(e) => onPriorityChange(e.target.value)}
          aria-label="Filter tasks by priority"
          title="Filter by priority"
          className="max-w-full border border-line bg-surface px-2 py-1.5 font-mono text-[11px] text-ink focus:outline-none sm:py-1"
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
          className="max-w-full border border-line bg-surface px-2 py-1.5 font-mono text-[11px] text-ink focus:outline-none sm:py-1"
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
          className="max-w-full border border-line bg-surface px-2 py-1.5 font-mono text-[11px] text-ink focus:outline-none sm:py-1"
        >
          <option value="priority">Sort: Priority</option>
          <option value="updated">Sort: Recently Updated</option>
          <option value="id">Sort: Task ID</option>
        </select>

        {isFiltered && (
          <button
            type="button"
            onClick={onReset}
            aria-label="Reset all filters"
            title="Clear all active filters"
            className="border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:bg-muted-bg hover:text-ink active:scale-[0.98] sm:py-1"
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
            className="border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:bg-muted-bg hover:text-ink active:scale-[0.98] sm:py-1"
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
              'border px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors active:scale-[0.98] sm:py-1',
              showMetrics
                ? 'border-ink bg-muted-bg text-ink font-semibold'
                : 'border-line bg-surface text-muted hover:bg-muted-bg hover:text-ink',
            ].join(' ')}
          >
            Metrics
          </button>
        )}
      </div>

      <div className="ml-auto w-full text-right font-mono text-[10px] uppercase tracking-wider text-muted sm:w-auto">
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
