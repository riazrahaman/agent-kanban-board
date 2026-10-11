import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Task } from '../types'
import { getVisibleColumns, groupTasks } from '../board-model.js'
import Column from './Column'
import { resolveColumnAccent, type ColumnColors } from '../lib/columnColors'
import { PHONE_LAYOUT_QUERY } from '../lib/scrollLock'
import { useMediaQuery } from '../lib/useMediaQuery'
import { PHONE_CARD_LIMIT, columnAlignTarget, snappedColumnIndex } from '../lib/phoneBoard'

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
  // v3.2.4 phone layout (document scroll; see index.css and lib/phoneBoard.ts).
  const isPhone = useMediaQuery(PHONE_LAYOUT_QUERY)
  const [activeIndex, setActiveIndex] = useState(0)
  const indicatorRef = useRef<HTMLDivElement>(null)

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

  // Phone layout: every column shares the document's one vertical scroll
  // position. Track which column is snapped into view (for the sticky column
  // bar), and when the snapped column CHANGES after the horizontal swipe
  // settles, bring that column's top to just under the sticky chrome if it
  // is hidden above it — otherwise swiping from deep in a long column lands
  // on empty space with the new column's header scrolled off. Skipped while
  // the user is scrolling vertically (any non-programmatic window scroll in
  // the last 250ms), so it never fights a vertical drag or momentum scroll.
  useEffect(() => {
    const el = scrollRef.current
    if (!isPhone || !el) return
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let lastUserVScroll = 0
    let programmaticUntil = 0
    let alignedIndex = -1
    const pitch = () => {
      const [a, b] = [el.children[0] as HTMLElement | undefined, el.children[1] as HTMLElement | undefined]
      if (a && b) return b.offsetLeft - a.offsetLeft
      return a ? a.offsetWidth + 16 : COLUMN_STEP
    }
    const current = () => snappedColumnIndex(el.scrollLeft, pitch(), el.children.length)
    alignedIndex = current()
    setActiveIndex(alignedIndex)
    const settle = () => {
      const idx = current()
      if (idx === alignedIndex) return
      alignedIndex = idx
      if (performance.now() - lastUserVScroll < 250) return
      const col = el.children[idx] as HTMLElement | undefined
      if (!col) return
      const header = document.querySelector<HTMLElement>('.app-header')
      const headerH = header && getComputedStyle(header).position === 'sticky' ? header.offsetHeight : 0
      const stickyOffset = headerH + (indicatorRef.current?.offsetHeight ?? 0)
      const target = columnAlignTarget(col.getBoundingClientRect().top, stickyOffset, window.scrollY)
      if (target === null) return
      programmaticUntil = performance.now() + 300
      window.scrollTo(0, target)
    }
    const onStripScroll = () => {
      setActiveIndex(current())
      clearTimeout(settleTimer)
      settleTimer = setTimeout(settle, 150)
    }
    const onWindowScroll = () => {
      if (performance.now() > programmaticUntil) lastUserVScroll = performance.now()
    }
    el.addEventListener('scroll', onStripScroll, { passive: true })
    window.addEventListener('scroll', onWindowScroll, { passive: true })
    return () => {
      clearTimeout(settleTimer)
      el.removeEventListener('scroll', onStripScroll)
      window.removeEventListener('scroll', onWindowScroll)
    }
  }, [isPhone, visibleColumns.length])

  const activeColumn = visibleColumns[Math.min(activeIndex, visibleColumns.length - 1)]

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
    <div className="board-root relative flex h-full min-w-0 flex-1 items-stretch">
      {/* Phone layout only: a sticky "which column am I in" bar under the
          sticky page header (`top: var(--app-header-h)`, index.css). The
          columns' own headers can't be sticky against the document — they
          sit inside the horizontal scroll container, which is the nearest
          scrolling ancestor sticky binds to. Counts are the full totals. */}
      {isPhone && activeColumn && (
        <div
          ref={indicatorRef}
          data-testid="column-indicator"
          aria-live="polite"
          className="column-indicator z-[15] flex items-center justify-between gap-2 border-b border-line bg-bg px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-ink"
        >
          <span className="min-w-0 truncate">
            {activeColumn.stepNumber && <span className="text-muted">{activeColumn.stepNumber} </span>}
            {activeColumn.title}
            <span className="text-muted"> · {(grouped[activeColumn.status] || []).length}</span>
          </span>
          <span className="shrink-0 tabular-nums text-muted">
            {Math.min(activeIndex, visibleColumns.length - 1) + 1}/{visibleColumns.length}
          </span>
        </div>
      )}
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

      <div className="board-viewport relative flex h-full min-w-0 flex-1">
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
              cardLimit={isPhone ? PHONE_CARD_LIMIT : undefined}
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
