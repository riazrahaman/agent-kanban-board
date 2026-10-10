// Pinch-zoom guard (GH #103 follow-up; v3.2.3, hardened in v3.2.4).
//
// iOS Safari has ignored `user-scalable=no` / `maximum-scale=1` in the
// viewport meta tag since ~iOS 10 (an Apple accessibility change). The meta
// tag stays in place (other engines still honour it) but cannot be the fix.
//
// WHY v3.2.3 STILL ZOOMED on a real iPhone: it relied on `touch-action:
// pan-x pan-y` on `html, body, #root` only. touch-action is NOT inherited,
// and WebKit (following the Pointer Events "determining supported touch
// behavior" rule) intersects an element's touch-action with its ancestors'
// only UP TO the nearest scroll container — at every `overflow: auto|scroll`
// element the effective value resets to `auto`. Every card on the board sits
// inside `.board-scroll` (overflow-x: auto) and a column list
// (overflow-y: auto), and body itself became a scroll container through
// `overflow-x: hidden`, so the root rule never reached a single touch on the
// board: effective touch-action there was `auto`, pinch included. index.css
// now applies `pan-x pan-y` to EVERY element (`*`), scroll containers
// included, which is the primary fix.
//
// This module is the JS layer on top, layered so any one of them suffices:
//   1. `touchmove` with more than one finger down (or a WebKit `scale` other
//      than 1) is `preventDefault()`ed — the classic pinch block that still
//      works on current iOS when the listener is NON-passive (document-level
//      touch listeners default to passive in Safari 11.1+, which would make
//      preventDefault a silent no-op). One-finger moves are never touched,
//      so scrolling and swiping are unaffected.
//   2. WebKit's non-standard `gesturestart`/`gesturechange`/`gestureend`
//      events are cancelled.
//   3. `wheel` with `ctrlKey` (how desktop browsers report a trackpad pinch)
//      is cancelled.
// Each is registered on both `document` and `window`, capture phase, so a
// descendant that stops propagation cannot hide the gesture from the guard.
//
// Deliberately NO `touchend` double-tap guard: an earlier revision had one
// and it was reviewed out — it `preventDefault()`ed the second of any two
// touchends within 350ms regardless of target, cancelling real clicks
// (two quick taps on different buttons, swipe-then-tap, double-tap word
// select). Double-tap zoom is covered by touch-action (no `pinch-zoom`
// keyword means no zoom gesture of either kind) and by the viewport meta.
//
// Verification caveat: neither Playwright WebKit (a desktop engine) nor
// Chromium touch emulation implements iOS Safari's pinch pipeline, so the
// actual zoom blocking is unverified-by-repro off-device. What IS verified is
// the wiring and the decision logic (see pinchZoomGuard.test.mjs).

type Target = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

interface TouchLikeEvent {
  touches?: { length: number }
  scale?: number
  preventDefault(): void
}

interface WheelLikeEvent {
  ctrlKey?: boolean
  preventDefault(): void
}

/** True for a touchmove that is (part of) a pinch: two or more fingers, or
 *  a WebKit TouchEvent carrying a non-1 `scale`. Single-finger moves —
 *  ordinary scrolling and swiping — always return false. */
export function isPinchTouch(e: TouchLikeEvent): boolean {
  if (e.touches && e.touches.length > 1) return true
  return typeof e.scale === 'number' && e.scale !== 1
}

/**
 * Installs the guard on `doc` and `win` (default: the real document and
 * window) and returns a cleanup function that removes every listener. Call
 * once at startup — see main.tsx.
 */
export function installPinchZoomGuard(
  doc: Target = document,
  win: Target | null = typeof window === 'undefined' ? null : window,
): () => void {
  const preventGesture = (e: Event) => {
    e.preventDefault()
  }
  const preventPinchMove = (e: Event) => {
    if (isPinchTouch(e as unknown as TouchLikeEvent)) e.preventDefault()
  }
  const preventCtrlWheel = (e: Event) => {
    if ((e as unknown as WheelLikeEvent).ctrlKey) e.preventDefault()
  }

  const handlers: Array<[string, EventListener]> = [
    ['touchmove', preventPinchMove],
    ['gesturestart', preventGesture],
    ['gesturechange', preventGesture],
    ['gestureend', preventGesture],
    ['wheel', preventCtrlWheel],
  ]
  // passive:false — preventDefault() on a passive listener is a silent no-op.
  // capture:true — see the header comment.
  const opts: AddEventListenerOptions = { passive: false, capture: true }
  const targets = win ? [doc, win] : [doc]

  for (const target of targets) {
    for (const [type, handler] of handlers) target.addEventListener(type, handler, opts)
  }

  return () => {
    for (const target of targets) {
      for (const [type, handler] of handlers) {
        target.removeEventListener(type, handler, { capture: true })
      }
    }
  }
}
