import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Task, TaskStatus } from '../types'
import { groupTasks } from '../board-model.js'
import Column from './Column'

const COLUMNS: { status: TaskStatus; title: string }[] = [
  { status: 'BACKLOG', title: 'Backlog' },
  { status: 'BUILDING', title: 'Building' },
  { status: 'IN_REVIEW', title: 'In Review' },
  { status: 'IN_TEST', title: 'In Test' },
  { status: 'BLOCKED', title: 'Blocked' },
  { status: 'DONE', title: 'Done' },
  { status: 'UNKNOWN', title: 'Unknown' },
  { status: 'ISSUES', title: 'Issues' },
]

type Props = {
  tasks: Task[]
  onOpen: (id: string) => void
  /** Show each card's owning project — useful on the unscoped "all projects" board. */
  showProject?: boolean
}

// One column is w-72 (18rem = 288px) + the 1rem gap; step a shade under a full
// column so a tap always reveals a sliver of the next one.
const COLUMN_STEP = 304

export default function Board({ tasks, onOpen, showProject = false }: Props) {
  const grouped = useMemo(() => groupTasks(tasks), [tasks])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)

  const updateEdges = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    setCanLeft(el.scrollLeft > 1)
    setCanRight(el.scrollLeft < max - 1)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    updateEdges()
    el.addEventListener('scroll', updateEdges, { passive: true })
    const ro = new ResizeObserver(updateEdges)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    window.addEventListener('resize', updateEdges)
    return () => {
      el.removeEventListener('scroll', updateEdges)
      ro.disconnect()
      window.removeEventListener('resize', updateEdges)
    }
  }, [updateEdges])

  // Column count is fixed, but a task mutation can change a column's height and
  // (at the extremes) nudge scrollWidth; cheap to re-check after each update.
  useEffect(() => {
    updateEdges()
  }, [grouped, updateEdges])

  const scrollBy = (dir: 1 | -1) =>
    scrollRef.current?.scrollBy({ left: dir * COLUMN_STEP, behavior: 'smooth' })

  return (
    <div className="relative flex h-full min-w-0 flex-1">
      {canLeft && (
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-bg to-transparent" />
      )}
      <div
        ref={scrollRef}
        className="board-scroll flex h-full w-full gap-4 overflow-x-auto p-4"
      >
        {COLUMNS.map((col) => (
          <Column
            key={col.status}
            status={col.status}
            title={col.title}
            tasks={grouped[col.status] || []}
            onOpen={onOpen}
            showProject={showProject}
          />
        ))}
      </div>
      {canRight && (
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-bg to-transparent" />
      )}

      {/* Explicit affordance for pointer users: the styled scrollbar below is
          always visible, but a trackpad-less mouse can't easily drag it, and
          these also make "there is more to the right" unmistakable. */}
      {canLeft && (
        <button
          type="button"
          onClick={() => scrollBy(-1)}
          aria-label="Scroll columns left"
          title="Scroll columns left"
          className="absolute left-2 top-1/2 z-20 flex h-9 w-6 -translate-y-1/2 items-center justify-center border border-line bg-surface font-mono text-sm text-ink shadow-md transition-colors hover:bg-muted-bg active:scale-[0.96]"
        >
          ‹
        </button>
      )}
      {canRight && (
        <button
          type="button"
          onClick={() => scrollBy(1)}
          aria-label="Scroll columns right"
          title="Scroll columns right"
          className="absolute right-2 top-1/2 z-20 flex h-9 w-6 -translate-y-1/2 items-center justify-center border border-line bg-surface font-mono text-sm text-ink shadow-md transition-colors hover:bg-muted-bg active:scale-[0.96]"
        >
          ›
        </button>
      )}
    </div>
  )
}
