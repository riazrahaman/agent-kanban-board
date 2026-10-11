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
  documentElement: {
    classList: { add(c: string): void; remove(c: string): void }
    style: { setProperty(name: string, value: string): void; removeProperty(name: string): void }
  }
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
 * `startY` overrides the position to pin at (used when re-locking after a
 * rotation, when the window has already lost it). Returns the release
 * function: `release()` restores the saved position; `release(false)`
 * unpins without scrolling (a breakpoint change, not a close). Either way it
 * returns the saved position.
 */
export type ScrollLockRelease = (restore?: boolean) => number

export function lockDocumentScroll(doc: DocLike = document, win: WinLike = window, startY?: number): ScrollLockRelease {
  if (lockCount === 0) {
    savedY = startY ?? win.scrollY
    doc.body.style.top = `-${savedY}px`
    // Lets the sticky header be shifted back into view while locked (index.css).
    doc.documentElement.style.setProperty('--scroll-lock-y', `${savedY}px`)
    doc.documentElement.classList.add(SCROLL_LOCK_CLASS)
  }
  lockCount++
  let released = false
  return (restore = true) => {
    if (released) return savedY
    released = true
    lockCount--
    if (lockCount === 0) {
      doc.documentElement.classList.remove(SCROLL_LOCK_CLASS)
      doc.documentElement.style.removeProperty('--scroll-lock-y')
      doc.body.style.top = ''
      if (restore) win.scrollTo(0, savedY)
    }
    return savedY
  }
}

/** Test hook: current reference count. */
export function scrollLockCount(): number {
  return lockCount
}

type MediaQueryLike = {
  matches: boolean
  addEventListener?(type: 'change', listener: () => void): void
  removeEventListener?(type: 'change', listener: () => void): void
}

/**
 * Holds a scroll lock exactly while `mq` (the phone-layout query) matches,
 * following live changes — e.g. rotating the device across the 768px
 * breakpoint while an overlay is open:
 * - leaving the phone layout unpins <body> (never left fixed at a negative
 *   top in the desktop layout) but KEEPS the saved position instead of
 *   restoring it — the desktop layout can't scroll, so restoring there would
 *   silently lose it;
 * - re-entering the phone layout with the overlay still open re-pins at that
 *   same saved position;
 * - entering it for an overlay first opened in landscape applies the lock;
 * - only the real close (dispose) restores the position — via the held lock,
 *   or via `restore` if the overlay closes while unpinned.
 */
export function bindScrollLockToQuery(
  mq: MediaQueryLike | undefined,
  lock: (startY?: number) => ScrollLockRelease,
  restore: (y: number) => void = () => {},
): () => void {
  let release: ScrollLockRelease | null = null
  let carriedY: number | undefined
  const sync = () => {
    const want = mq?.matches ?? false
    if (want && !release) {
      release = lock(carriedY)
      carriedY = undefined
    } else if (!want && release) {
      carriedY = release(false)
      release = null
    }
  }
  sync()
  mq?.addEventListener?.('change', sync)
  return () => {
    mq?.removeEventListener?.('change', sync)
    if (release) release(true)
    else if (carriedY !== undefined) restore(carriedY)
    release = null
    carriedY = undefined
  }
}

/**
 * Locks the document scroll while `active`, but only while the phone layout
 * applies — everywhere else the document never scrolls (the shell scrolls
 * internally), so there is nothing to lock and <body> is left untouched.
 */
export function useDocumentScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    return bindScrollLockToQuery(
      window.matchMedia?.(PHONE_LAYOUT_QUERY),
      (startY) => lockDocumentScroll(document, window, startY),
      (y) => window.scrollTo(0, y),
    )
  }, [active])
}
