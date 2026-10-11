// Phone-layout board helpers (v3.2.4). In the phone layout (index.css,
// lib/scrollLock.ts PHONE_LAYOUT_QUERY) the DOCUMENT scrolls and every column
// shares that one vertical scroll position, so a very tall column (the live
// board has ~300 DONE cards) would make the page enormous and leave short
// columns as empty space once you swipe to them. These pure helpers back the
// three mitigations in Board.tsx / Column.tsx: a per-column card cap with a
// "Show N more" button, tracking which column is snapped into view, and
// re-aligning the page to that column's top when it changes.

/** Cards rendered per column on phones before "Show N more". */
export const PHONE_CARD_LIMIT = 25

/** Splits a column's cards into the rendered slice and the hidden remainder. */
export function capCards<T>(tasks: T[], limit: number | undefined, expanded: boolean): { shown: T[]; hidden: number } {
  if (expanded || limit === undefined || tasks.length <= limit) return { shown: tasks, hidden: 0 }
  return { shown: tasks.slice(0, limit), hidden: tasks.length - limit }
}

/** Index of the column snapped into view in the horizontal strip. */
export function snappedColumnIndex(scrollLeft: number, pitch: number, count: number): number {
  if (count <= 0 || !(pitch > 0)) return 0
  return Math.min(count - 1, Math.max(0, Math.round(scrollLeft / pitch)))
}

/**
 * Where to scroll the document after the snapped column changed, or null to
 * leave it. `columnTop` is the column's viewport-relative top; `stickyOffset`
 * is the height of the sticky chrome above it (page header + column bar).
 * If the column's top is hidden under that chrome (the user is scrolled into
 * the board, possibly past the end of this column), bring it to just under
 * the chrome so its header and first card are visible.
 */
export function columnAlignTarget(columnTop: number, stickyOffset: number, scrollY: number): number | null {
  if (columnTop >= stickyOffset - 1) return null
  return Math.max(0, Math.round(scrollY + columnTop - stickyOffset))
}
