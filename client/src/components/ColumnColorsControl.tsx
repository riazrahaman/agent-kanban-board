import { useEffect, useRef, useState } from 'react'
import {
  COLUMN_COLOR_TOKENS,
  COLUMN_COLOR_LABELS,
  DEFAULT_COLUMN_COLORS,
  SWATCH_CLASS,
  isStockPalette,
  type ColumnColors,
  type ColumnColorToken,
} from '../lib/columnColors'

const COLUMN_ORDER = Object.keys(DEFAULT_COLUMN_COLORS)

type Props = {
  colors: ColumnColors | null
  onChange: (colors: ColumnColors) => void
  onReset: () => void
}

/**
 * v2.5.0 — per-project column colors. A small popover: one row per swimlane,
 * each with a swatch palette. Saves are optimistic (App persists via PUT
 * /api/settings); this component only manages the open/close + pick state.
 */
export default function ColumnColorsControl({ colors, onChange, onReset }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Outside-click + Escape close, mirroring HeaderHelp.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (column: string, token: ColumnColorToken) => {
    onChange({ ...(colors ?? {}), [column]: token })
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Customize column colors"
        title="Per-column accent colors (saved for this project)"
        className="border border-line bg-surface px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg active:scale-[0.98]"
      >
        Columns
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Column colors"
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-64 border-2 border-ink/70 bg-surface p-2 text-left"
        >
          {COLUMN_ORDER.map((column) => {
            const current = colors?.[column] ?? DEFAULT_COLUMN_COLORS[column]
            return (
              <div key={column} className="flex items-center justify-between gap-2 py-1">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                  {column}
                </span>
                <div className="flex items-center gap-1">
                  {COLUMN_COLOR_TOKENS.map((token) => (
                    <button
                      key={token}
                      type="button"
                      aria-label={`${COLUMN_COLOR_LABELS[token]} for ${column}`}
                      title={COLUMN_COLOR_LABELS[token]}
                      aria-pressed={current === token}
                      onClick={() => pick(column, token)}
                      className={[
                        'h-4 w-4 border transition-transform',
                        SWATCH_CLASS[token],
                        current === token ? 'border-ink' : 'border-line hover:scale-110',
                      ].join(' ')}
                    />
                  ))}
                </div>
              </div>
            )
          })}
          <div className="mt-2 border-t border-line pt-2">
            <button
              type="button"
              onClick={() => {
                onReset()
                setOpen(false)
              }}
              disabled={isStockPalette(colors)}
              className="w-full border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:bg-muted-bg hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reset to defaults
            </button>
          </div>
        </div>
      )}
    </div>
  )
}