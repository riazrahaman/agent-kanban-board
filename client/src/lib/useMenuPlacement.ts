import { useLayoutEffect, useState, type RefObject } from 'react'
import { placeMenu, type MenuPlacement } from './menuPlacement'

/**
 * Measures `triggerRef` while `open` and returns a viewport-clamped
 * `position: fixed` placement (see menuPlacement.ts), or null while closed or
 * when `enabledQuery` (a media query, e.g. '(min-width: 640px)') does not
 * match — the caller then falls back to its own CSS placement. Runs in a
 * layout effect so the first painted frame is already in place, and
 * re-measures on window / visual-viewport resize.
 */
export function useMenuPlacement(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  widths: { fine: number; coarse: number },
  enabledQuery?: string,
): MenuPlacement | null {
  const [placement, setPlacement] = useState<MenuPlacement | null>(null)
  const { fine, coarse } = widths

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    const measure = () => {
      const trigger = triggerRef.current
      const enabled = !enabledQuery || (window.matchMedia?.(enabledQuery).matches ?? true)
      if (!trigger || !enabled) {
        setPlacement(null)
        return
      }
      const isCoarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
      setPlacement(
        placeMenu(
          trigger.getBoundingClientRect(),
          document.documentElement.clientWidth || window.innerWidth,
          isCoarse ? coarse : fine,
        ),
      )
    }
    measure()
    window.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('resize', measure)
    }
  }, [open, triggerRef, fine, coarse, enabledQuery])

  return placement
}

/** max-height for a fixed menu whose top edge sits at `top`: stays above the
 *  visible viewport's bottom and the bottom safe-area inset, never below 8rem. */
export function menuMaxHeight(top: number): string {
  return `max(8rem, calc(100dvh - ${top}px - 0.75rem - env(safe-area-inset-bottom, 0px)))`
}
