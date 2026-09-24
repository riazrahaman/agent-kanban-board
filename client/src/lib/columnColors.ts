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
  BUILDING: 'live',
  IN_REVIEW: 'warn',
  IN_TEST: 'test',
  BLOCKED: 'fail',
  DONE: 'pass',
  UNKNOWN: 'line',
  ISSUES: 'warn',
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