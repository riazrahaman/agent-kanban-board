// Viewport-clamped placement for anchored dropdown menus (v3.2.4).
//
// Why: ProjectPicker's listbox was `absolute right-0 w-48` — right-aligned to
// its trigger. Below `md` the trigger is the FIRST item of the wrapped header
// disclosure row, at the screen's left edge, so a 12rem menu right-aligned to
// a ~5rem button extended ~7rem past x=0 on a real iPhone: project names were
// cut off ("ects", "vestment-advisor") and the menu sat over the token/theme
// controls. A pure CSS anchor can't know where in a wrapped row the trigger
// lands, so the menu is placed from the trigger's measured rect and clamped.

export type AnchorRect = { top: number; bottom: number; left: number; right: number }

export type MenuPlacement = { top: number; left: number; width: number }

/** Minimum gap kept between the menu and either viewport edge (px). */
export const MENU_EDGE_MARGIN = 12
/** Gap between the trigger's bottom edge and the menu (px) — the old `top-[calc(100%+6px)]`. */
export const MENU_GAP = 6

/**
 * Prefers the original desktop look — right edge aligned with the trigger's
 * right edge — and falls back to left-aligning with the trigger, then to a
 * plain clamp, so the menu is always fully within
 * [MENU_EDGE_MARGIN, viewportWidth - MENU_EDGE_MARGIN]. The width shrinks to
 * fit a viewport narrower than `preferredWidth` plus both margins.
 */
export function placeMenu(anchor: AnchorRect, viewportWidth: number, preferredWidth: number): MenuPlacement {
  const maxWidth = Math.max(0, viewportWidth - 2 * MENU_EDGE_MARGIN)
  const width = Math.min(preferredWidth, maxWidth)
  const minLeft = MENU_EDGE_MARGIN
  const maxLeft = viewportWidth - MENU_EDGE_MARGIN - width

  let left = anchor.right - width // right-aligned (desktop default)
  if (left < minLeft) left = anchor.left // left-aligned to the trigger
  left = Math.min(Math.max(left, minLeft), Math.max(minLeft, maxLeft))

  return { top: anchor.bottom + MENU_GAP, left, width }
}
