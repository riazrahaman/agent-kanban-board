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

      <div className="flex items-center gap-2">
        <select
          value={priority}
          onChange={(e) => onPriorityChange(e.target.value)}
          aria-label="Filter tasks by priority"
          title="Filter by priority"
          className="border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink focus:outline-none"
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
          className="border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink focus:outline-none"
        >
          <option value="all">All Assignees</option>
          <option value="unassigned">Unassigned</option>
          {assignees.map((agent) => (
            <option key={agent} value={agent.toLowerCase()}>
              {agent}
            </option>
          ))}
        </select>

        {isFiltered && (
          <button
            type="button"
            onClick={onReset}
            aria-label="Reset all filters"
            title="Clear all active filters"
            className="border border-line bg-surface px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:bg-muted-bg hover:text-ink active:scale-[0.98]"
          >
            Reset
          </button>
        )}
      </div>

      <div className="ml-auto font-mono text-[10px] uppercase tracking-wider text-muted">
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
