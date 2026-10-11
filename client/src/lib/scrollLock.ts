import { useEffect } from 'react'

// Phone layout (v3.2.4): on a touch phone below `md` the DOCUMENT is the
// vertical scroller (see the phone-layout block in index.css) so iOS Safari
// renders the page behind its translucent floating toolbar like any normal
// website. Keep this query in sync with that block and with Tailwind's
// `max-md:pointer-coarse:` variant (max-md = width < 48rem).
export const PHONE_LAYOUT_QUERY = '(max-width: 47.99rem) and (pointer: coarse)'

/** Class put on <html> while an overlay locks the document (index.css). */
export const SCROLL_LOCK_CLASS = 'scroll-locked'

type DocLike = {
  documentElement: { classList: { add(c: string): void; remove(c: string): void } }
  body: { style: { top: string } }
}
type WinLike = {
  scrollY: number
  scrollTo(x: number, y: number): void
}

let lockCount = 0
let savedY = 0

/**
 * Freezes the document scroll while an overlay (TaskSheet, BugReportDialog,
 * the phone Signal Rail drawer) is open, and restores the exact scroll
 * position afterwards. iOS Safari ignores `overflow: hidden` for touch
 * scrolling in some versions, so the lock pins <body> with
 * `position: fixed; top: -scrollY` (via the class + inline top), which keeps
 * the page visually where it was — no jump — and cannot be touch-scrolled.
 * Reference-counted so stacked overlays release only when the last closes.
 * Returns the release function.
 */
export function lockDocumentScroll(doc: DocLike = document, win: WinLike = window): () => void {
  if (lockCount === 0) {
    savedY = win.scrollY
    doc.body.style.top = `-${savedY}px`
    doc.documentElement.classList.add(SCROLL_LOCK_CLASS)
  }
  lockCount++
  let released = false
  return () => {
    if (released) return
    released = true
    lockCount--
    if (lockCount === 0) {
      doc.documentElement.classList.remove(SCROLL_LOCK_CLASS)
      doc.body.style.top = ''
      win.scrollTo(0, savedY)
    }
  }
}

/** Test hook: current reference count. */
export function scrollLockCount(): number {
  return lockCount
}

/**
 * Locks the document scroll while `active`, but only in the phone layout —
 * everywhere else the document never scrolls (the shell scrolls internally),
 * so there is nothing to lock and <body> is left untouched.
 */
export function useDocumentScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    if (!(window.matchMedia?.(PHONE_LAYOUT_QUERY).matches ?? false)) return
    return lockDocumentScroll()
  }, [active])
}
