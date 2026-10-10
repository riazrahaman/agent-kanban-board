import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Task } from '../types'
import { getVisibleColumns, groupTasks } from '../board-model.js'
import Column from './Column'
import { resolveColumnAccent, type ColumnColors } from '../lib/columnColors'

type Props = {
  tasks: Task[]
  onOpen: (id: string) => void
  /** Show each card's owning project — useful on the unscoped "all projects" board. */
  showProject?: boolean
  /** v2.5.0: resolved per-project column colors (accent overrides). */
  columnColors?: ColumnColors | null
}

// One column is w-72 (18rem = 288px) + the 1rem gap on desktop; on phones it
// is 85vw, so page by the first column's actual width when we can measure it.
const COLUMN_STEP = 304

export default function Board({ tasks, onOpen, showProject = false, columnColors }: Props) {
  const grouped = useMemo(() => groupTasks(tasks), [tasks])
  const visibleColumns = useMemo(() => getVisibleColumns(grouped), [grouped])
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
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0
    }
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

  const scrollBy = (dir: 1 | -1) => {
    const el = scrollRef.current
    if (!el) return
    // Page by the real column pitch (width + gap) when a child is measurable,
    // so the mobile 85vw columns snap cleanly; fall back to the desktop step.
    const first = el.children[0] as HTMLElement | undefined
    const step =
      first && first.offsetWidth > 0 ? first.offsetWidth + 16 : COLUMN_STEP
    el.scrollBy({ left: dir * step, behavior: 'smooth' })
  }

  return (
    <div className="relative flex h-full min-w-0 flex-1 items-stretch">
      {/* Explicit affordance for pointer users: the styled scrollbar below is
          always visible, but a trackpad-less mouse can't easily drag it, and
          these also make "there is more to the right" unmistakable.
          Placing the buttons outside the scroller ensures they never overlay
          card content in the peeking columns at any viewport width. */}
      <button
        type="button"
        onClick={() => scrollBy(-1)}
        disabled={!canLeft}
        aria-label="Scroll columns left"
        title="Scroll columns left"
        className="z-20 hidden h-11 w-8 shrink-0 self-center items-center justify-center border-2 border-ink bg-surface font-mono text-lg font-bold text-ink transition-colors hover:bg-ink hover:text-surface active:scale-[0.95] md:flex pointer-coarse:hidden ml-2 disabled:pointer-events-none disabled:opacity-0"
      >
        ‹
      </button>

      <div className="relative flex h-full min-w-0 flex-1">
        {canLeft && (
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r from-bg to-transparent" />
        )}
        <div
          ref={scrollRef}
          className="board-scroll flex h-full w-full snap-x snap-proximity scroll-pl-4 gap-4 overflow-x-auto p-2 pb-2 sm:p-4 overscroll-x-contain"
        >
          {visibleColumns.map((col) => (
            <Column
              key={col.status}
              status={col.status}
              title={col.title}
              stepNumber={col.stepNumber}
              tasks={grouped[col.status] || []}
              onOpen={onOpen}
              showProject={showProject}
              accentClass={resolveColumnAccent(col.status, columnColors)}
            />
          ))}
        </div>
        {canRight && (
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l from-bg to-transparent" />
        )}
      </div>

      <button
        type="button"
        onClick={() => scrollBy(1)}
        disabled={!canRight}
        aria-label="Scroll columns right"
        title="Scroll columns right"
        className="z-20 hidden h-11 w-8 shrink-0 self-center items-center justify-center border-2 border-ink bg-surface font-mono text-lg font-bold text-ink transition-colors hover:bg-ink hover:text-surface active:scale-[0.95] md:flex pointer-coarse:hidden mr-2 disabled:pointer-events-none disabled:opacity-0"
      >
        ›
      </button>
    </div>
  )
}
