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
 * Returns the release function.
 */
export function lockDocumentScroll(doc: DocLike = document, win: WinLike = window): () => void {
  if (lockCount === 0) {
    savedY = win.scrollY
    doc.body.style.top = `-${savedY}px`
    // Lets the sticky header be shifted back into view while locked (index.css).
    doc.documentElement.style.setProperty('--scroll-lock-y', `${savedY}px`)
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
      doc.documentElement.style.removeProperty('--scroll-lock-y')
      doc.body.style.top = ''
      win.scrollTo(0, savedY)
    }
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
 * breakpoint while an overlay is open. Leaving the phone layout releases the
 * lock (which always restores the scroll position, so <body> is never left
 * fixed at a negative top in the desktop layout); entering it (an overlay
 * opened in landscape, then rotated to portrait) applies it. Returns a
 * dispose function that releases any held lock.
 */
export function bindScrollLockToQuery(mq: MediaQueryLike | undefined, lock: () => () => void): () => void {
  let release: (() => void) | null = null
  const sync = () => {
    const want = mq?.matches ?? false
    if (want && !release) release = lock()
    else if (!want && release) {
      release()
      release = null
    }
  }
  sync()
  mq?.addEventListener?.('change', sync)
  return () => {
    mq?.removeEventListener?.('change', sync)
    release?.()
    release = null
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
    return bindScrollLockToQuery(window.matchMedia?.(PHONE_LAYOUT_QUERY), () => lockDocumentScroll())
  }, [active])
}
