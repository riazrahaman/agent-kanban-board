/**
 * Theme resolution for the client.
 *
 * The explicit user choice (a saved 'light'/'dark') is authoritative over the OS
 * `prefers-color-scheme` preference. When nothing has been chosen, we fall back
 * to the OS preference. The resolved theme drives a single `.dark` class on
 * `<html>`: `dark` -> class present, `light` -> class absent (the `:root` light
 * token set is the default).
 *
 * Everything here is pure so the resolution rules are unit-testable without a
 * browser; the localStorage/matchMedia reads stay in the component.
 */

export type Theme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'theme'

/**
 * Resolve the effective theme from a stored value and the OS dark preference.
 *
 * @param stored      raw `localStorage.getItem('theme')` value (or null).
 * @param prefersDark true when the OS reports `prefers-color-scheme: dark`.
 */
export function resolveTheme(stored: string | null | undefined, prefersDark: boolean): Theme {
  if (stored === 'light') return 'light'
  if (stored === 'dark') return 'dark'
  return prefersDark ? 'dark' : 'light'
}

/** The toggle reducer: flip to the opposite theme. */
export function nextTheme(current: Theme): Theme {
  return current === 'dark' ? 'light' : 'dark'
}

/** Whether the resolved theme should carry the `.dark` class on the root. */
export function isDark(theme: Theme): boolean {
  return theme === 'dark'
}
