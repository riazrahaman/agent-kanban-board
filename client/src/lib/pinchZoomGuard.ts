// v3.2.3 (GH #103 follow-up): iOS Safari has ignored `user-scalable=no` /
// `maximum-scale=1` in the viewport meta tag since ~iOS 10 (an Apple
// accessibility fix) — confirmed on a real iPhone running iOS 26: v3.2.2's
// meta tag did not stop pinch-zoom at all. The meta tag is left in place
// (harmless, still honoured by some non-WebKit engines) but it cannot be the
// fix.
//
// What iOS DOES honour is CSS `touch-action` on the page root (see
// `touch-action: pan-x pan-y` on `html, body, #root` in index.css — omitting
// the `pinch-zoom` keyword blocks BOTH the page-level pinch gesture AND
// double-tap-to-zoom, while `pan-x pan-y` keeps every descendant's own
// scrolling fully intact, per the touch-action intersection rule already
// documented in index.css/Board.tsx for GH #87). This module is the second
// line of defense for older/edge-case WebKit behaviour: it explicitly
// cancels the non-standard `gesturestart`/`gesturechange`/`gestureend`
// events WebKit fires on a two-finger pinch regardless of `touch-action`.
//
// An earlier revision also shipped a `touchend`-timestamp double-tap guard,
// reviewed out (round 1): `touch-action: pan-x pan-y` already covers
// double-tap-zoom (no `pinch-zoom` keyword means no zoom gesture of either
// kind), so the extra guard was redundant — and it was actively harmful: it
// `preventDefault()`d the SECOND of any two touchends within 350ms
// regardless of target, which cancels the following click for a real user
// double-tapping two different buttons, swiping then quickly tapping a card,
// or double-tap-selecting a word in a textarea.
//
// Playwright WebKit is a DESKTOP engine: it does not implement iOS's
// touch/gesture pipeline (no `GestureEvent`). None of this module's actual
// zoom-blocking behaviour is reproducible in this repo's test/CI
// environment — only its *wiring* (are the right listeners attached, with
// the right options) is verified here; the rest is unverified-by-repro, the
// same honest caveat already carried by BugReportDialog's other iOS/WebKit-
// specific defenses.

/**
 * Installs the pinch-zoom guard on `doc` (defaults to the real `document`)
 * and returns a cleanup function that removes it. Safe to call once at app
 * startup — see main.tsx. Registered `{ passive: false }`: `preventDefault()`
 * on a passive listener is a silent no-op, which would make this module
 * appear to work while doing nothing.
 */
export function installPinchZoomGuard(doc: Document = document): () => void {
  const preventGesture = (e: Event) => {
    e.preventDefault()
  }

  const opts: AddEventListenerOptions = { passive: false }
  // gesturestart/change/end are WebKit-only (Safari); other engines never
  // fire them, so adding the listeners is a harmless no-op elsewhere.
  doc.addEventListener('gesturestart', preventGesture as EventListener, opts)
  doc.addEventListener('gesturechange', preventGesture as EventListener, opts)
  doc.addEventListener('gestureend', preventGesture as EventListener, opts)

  return () => {
    doc.removeEventListener('gesturestart', preventGesture as EventListener)
    doc.removeEventListener('gesturechange', preventGesture as EventListener)
    doc.removeEventListener('gestureend', preventGesture as EventListener)
  }
}
