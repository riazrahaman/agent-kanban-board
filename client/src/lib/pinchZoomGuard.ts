// v3.2.3 (GH #103 follow-up): iOS Safari has ignored `user-scalable=no` /
// `maximum-scale=1` in the viewport meta tag since ~iOS 10 (an Apple
// accessibility fix — zoom must always be available to the end user via SOME
// mechanism) — confirmed on a real iPhone running iOS 26: v3.2.2's meta tag
// did not stop pinch-zoom at all. The meta tag is left in place (harmless,
// and still honoured by some non-WebKit engines) but it cannot be the fix.
//
// What iOS DOES honour is CSS `touch-action` on the page root (see
// `touch-action: pan-x pan-y` on `html, body, #root` in index.css — omitting
// the `pinch-zoom` keyword blocks the page-level pinch gesture while
// `pan-x pan-y` keeps every descendant's own scrolling fully intact, per the
// touch-action intersection rule already documented in index.css/Board.tsx
// for GH #87) and, as a second line of defense for older/edge-case WebKit
// behaviour, explicitly cancelling the non-standard `gesturestart` /
// `gesturechange` / `gestureend` events WebKit fires on a two-finger pinch
// regardless of `touch-action`. A third, `touchend`-timestamp-based guard
// covers double-tap-to-zoom, which is a distinct iOS gesture from pinch and
// is not reliably covered by `touch-action` on every WebKit version.
//
// Playwright WebKit is a DESKTOP engine: it does not implement iOS's
// touch/gesture pipeline (no `GestureEvent`, no double-tap-to-zoom, and it
// never adopted the since-iOS-10 override of `user-scalable=no` because it
// never honoured that meta attribute to begin with). None of this module's
// actual zoom-blocking behaviour is reproducible in this repo's test/CI
// environment — only its *wiring* (are the right listeners attached, with
// the right options) and its one pure decision function are verified here;
// the rest is unverified-by-repro, the same honest caveat already carried by
// BugReportDialog's other iOS/WebKit-specific defenses.

/** WebKit's non-standard pinch-gesture event — not in lib.dom.d.ts. */
type GestureEvent = Event & { scale?: number; rotation?: number }

/** Two touchend events this close together (ms) are treated as a double-tap. */
export const DOUBLE_TAP_THRESHOLD_MS = 350

/**
 * Pure decision for the double-tap guard, kept separate from the DOM wiring
 * below so it is unit-testable without a real `touchend` event stream.
 * `now` must be >= `lastTouchEnd`; a negative delta (clock skew) never
 * counts as a double-tap.
 */
export function isDoubleTap(
  lastTouchEnd: number,
  now: number,
  thresholdMs: number = DOUBLE_TAP_THRESHOLD_MS,
): boolean {
  const delta = now - lastTouchEnd
  return delta >= 0 && delta <= thresholdMs
}

/**
 * Installs the pinch/double-tap zoom guards on `doc` (defaults to the real
 * `document`) and returns a cleanup function that removes them. Safe to call
 * once at app startup — see main.tsx. All listeners are registered
 * `{ passive: false }`: `preventDefault()` on a passive listener is a silent
 * no-op, which would make this module appear to work while doing nothing.
 */
export function installPinchZoomGuard(doc: Document = document): () => void {
  const preventGesture = (e: Event) => {
    e.preventDefault()
  }

  let lastTouchEnd = 0
  const onTouchEnd = (e: TouchEvent) => {
    const now = Date.now()
    if (isDoubleTap(lastTouchEnd, now)) {
      e.preventDefault()
    }
    lastTouchEnd = now
  }

  const opts: AddEventListenerOptions = { passive: false }
  // gesturestart/change/end are WebKit-only (Safari); other engines never
  // fire them, so adding the listeners is a harmless no-op elsewhere.
  doc.addEventListener('gesturestart', preventGesture as EventListener, opts)
  doc.addEventListener('gesturechange', preventGesture as EventListener, opts)
  doc.addEventListener('gestureend', preventGesture as EventListener, opts)
  doc.addEventListener('touchend', onTouchEnd as EventListener, opts)

  return () => {
    doc.removeEventListener('gesturestart', preventGesture as EventListener)
    doc.removeEventListener('gesturechange', preventGesture as EventListener)
    doc.removeEventListener('gestureend', preventGesture as EventListener)
    doc.removeEventListener('touchend', onTouchEnd as EventListener)
  }
}

export type { GestureEvent }
