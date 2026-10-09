// v2.5.0 — per-project column colors (display settings).
//
// The palette is the design system's accent token set. Each entry maps to a
// LITERAL Tailwind class so the JIT scanner keeps it — never interpolate.
// Resolution order lives server-side (stock -> board default -> project
// override) and arrives via GET /api/settings and the SSE `settings` event.
export type ColumnColorToken =
  | 'muted'
  | 'live'
  | 'warn'
  | 'test'
  | 'fail'
  | 'pass'
  | 'block'
  | 'line'

export type ColumnColors = Record<string, ColumnColorToken>

export const COLUMN_COLOR_TOKENS: ColumnColorToken[] = [
  'muted',
  'live',
  'warn',
  'test',
  'fail',
  'pass',
  'block',
  'line',
]

export const COLUMN_COLOR_LABELS: Record<ColumnColorToken, string> = {
  muted: 'Default',
  live: 'Blue',
  warn: 'Amber',
  test: 'Violet',
  fail: 'Red',
  pass: 'Green',
  block: 'Slate',
  line: 'Hairline',
}

// Literal accent classes per token (Tailwind JIT requires literal strings).
export const ACCENT_CLASS: Record<ColumnColorToken, string> = {
  muted: 'border-t-2 border-t-muted/40',
  live: 'border-t-2 border-t-live',
  warn: 'border-t-2 border-t-warn',
  test: 'border-t-2 border-t-test',
  fail: 'border-t-2 border-t-fail',
  pass: 'border-t-2 border-t-pass',
  block: 'border-t-2 border-t-block',
  line: 'border-t-2 border-t-line',
}

// Stock palette as shipped (mirrors server STOCK_COLUMN_COLORS).
export const DEFAULT_COLUMN_COLORS: ColumnColors = Object.freeze({
  BACKLOG: 'muted',
  READY: 'line',
  PLANNING: 'block',
  IN_PROGRESS: 'live',
  IN_REVIEW: 'warn',
  VALIDATION: 'test',
  READY_TO_SHIP: 'pass',
  DONE: 'pass',
  BLOCKED: 'fail',
  UNKNOWN: 'line',
  ISSUES: 'warn',
  // Backward compatibility aliases
  BUILDING: 'live',
  IN_TEST: 'test',
})

/** Swatch background for the palette UI (literal classes). */
export const SWATCH_CLASS: Record<ColumnColorToken, string> = {
  muted: 'bg-muted/40',
  live: 'bg-live',
  warn: 'bg-warn',
  test: 'bg-test',
  fail: 'bg-fail',
  pass: 'bg-pass',
  block: 'bg-block',
  line: 'bg-line',
}

/** Resolve the top-accent class for a column, falling back to the stock map. */
export function resolveColumnAccent(status: string, colors?: ColumnColors | null): string {
  const key = String(status).toUpperCase()
  const token = colors?.[key] ?? DEFAULT_COLUMN_COLORS[key]
  return ACCENT_CLASS[token] ?? ACCENT_CLASS.line
}

/** True when every column matches the stock palette (nothing customized). */
export function isStockPalette(colors?: ColumnColors | null): boolean {
  if (!colors) return true
  return Object.entries(DEFAULT_COLUMN_COLORS).every(
    ([key, token]) => colors[key] === undefined || colors[key] === token
  )
}

/** Storage key for a project's local column colors cache. */
export function columnColorsStorageKey(project?: string): string {
  const p = typeof project === 'string' && project.trim() !== '' ? project.trim() : 'default'
  return `kanban.columnColors.${p}`
}

/** Read persisted column colors for a project from localStorage. */
export function readStoredColumnColors(project?: string): ColumnColors | null {
  try {
    const raw = localStorage.getItem(columnColorsStorageKey(project))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const validTokens = new Set<string>(COLUMN_COLOR_TOKENS)
    const result: ColumnColors = {}
    let count = 0
    for (const [col, tok] of Object.entries(parsed)) {
      if (typeof tok === 'string' && validTokens.has(tok)) {
        result[col.toUpperCase()] = tok as ColumnColorToken
        count++
      }
    }
    return count > 0 ? result : null
  } catch {
    return null
  }
}

/** Persist column colors for a project to localStorage. */
export function writeStoredColumnColors(
  project: string | undefined,
  colors: ColumnColors | null,
): void {
  try {
    const key = columnColorsStorageKey(project)
    if (!colors || isStockPalette(colors)) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, JSON.stringify(colors))
    }
  } catch {
    // Non-fatal
  }
}