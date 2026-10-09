/**
 * Theme resolution for the client.
 *
 * Three stored modes: 'auto' (follow the OS `prefers-color-scheme`, the
 * default for a visitor with no stored choice), 'light' and 'dark' (an
 * explicit user choice, authoritative over the OS preference). The resolved
 * theme drives a single `.dark` class on `<html>`: `dark` -> class present,
 * `light` -> class absent (the `:root` light token set is the default).
 *
 * Storage (v2.17.0, theme-auto): 'auto' is stored EXPLICITLY as the literal
 * string `'auto'` rather than by removing the `theme` key. A missing/garbage
 * key still resolves to auto (`parseStoredMode` treats anything that isn't
 * exactly 'light' or 'dark' as auto) so a pre-2.17.0 visitor with no stored
 * key is unaffected, but writing 'auto' explicitly means every mode round-
 * trips through the same read path with no special-cased "no key" branch —
 * one fewer case for the pre-paint inline script (client/index.html) and
 * this module to keep in sync.
 *
 * Everything here is pure so the resolution rules are unit-testable without a
 * browser; the localStorage/matchMedia reads stay in the component.
 */

/** What is stored / what the toggle cycles through. */
export type ThemeMode = 'auto' | 'light' | 'dark'

/** What is actually applied to the DOM — auto always resolves to one of these. */
export type Theme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'theme'

/**
 * Parse a raw `localStorage.getItem('theme')` value into a mode. Only the
 * exact literals 'light' and 'dark' are explicit choices; everything else
 * (null, undefined, 'auto', garbage) is auto — so a stored 'auto', a missing
 * key, and a corrupted value all behave identically.
 */
export function parseStoredMode(stored: string | null | undefined): ThemeMode {
  if (stored === 'light') return 'light'
  if (stored === 'dark') return 'dark'
  return 'auto'
}

/**
 * Resolve the effective (applied) theme from a mode and the OS dark
 * preference.
 *
 * @param mode        'auto' | 'light' | 'dark'.
 * @param prefersDark true when the OS reports `prefers-color-scheme: dark`.
 */
export function resolveMode(mode: ThemeMode, prefersDark: boolean): Theme {
  if (mode === 'light') return 'light'
  if (mode === 'dark') return 'dark'
  return prefersDark ? 'dark' : 'light'
}

/** The toggle reducer: cycles Auto -> Light -> Dark -> Auto. */
export function nextMode(mode: ThemeMode): ThemeMode {
  if (mode === 'auto') return 'light'
  if (mode === 'light') return 'dark'
  return 'auto'
}

/** Whether the resolved theme should carry the `.dark` class on the root. */
export function isDark(theme: Theme): boolean {
  return theme === 'dark'
}

/** Compact label for the toggle button — similar width in all three states
 *  so the header does not reflow as the mode changes. */
export function modeLabel(mode: ThemeMode): 'AUTO' | 'LIGHT' | 'DARK' {
  if (mode === 'light') return 'LIGHT'
  if (mode === 'dark') return 'DARK'
  return 'AUTO'
}

/** Accessible name / tooltip describing the current mode and what a click
 *  does next, e.g. "Theme: auto (follows system). Click for light". */
export function themeToggleTitle(mode: ThemeMode): string {
  const current = mode === 'auto' ? 'auto (follows system)' : mode
  return `Theme: ${current}. Click for ${nextMode(mode)}`
}
