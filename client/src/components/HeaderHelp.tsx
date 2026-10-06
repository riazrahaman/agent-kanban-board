import { useEffect, useRef, useState } from 'react'

type Props = {
  /** v2.16.0 (opt-public-bug-reports): only when the server confirms the
   *  feature is configured. Rendered as a row inside this popover rather
   *  than its own header button — a standalone button widened the toolbar
   *  enough to push it onto an extra row at several mid viewports (see
   *  CHANGELOG "Fixed", v2.16.0). The popover is `absolute`-positioned, so
   *  anything inside it costs zero width in the header's flex layout
   *  regardless of the flag. */
  bugReportEnabled?: boolean
  onReportBug?: () => void
}

/**
 * A small "i" affordance in the header that explains the two operator fields
 * (agent id + api token), and — when configured — a "Report a bug" entry.
 * Discoverable on demand without permanently spending header space on prose
 * or on a second always-visible button.
 */
export default function HeaderHelp({ bugReportEnabled, onReportBug }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
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

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="What do the agent id and api token fields do?"
        aria-expanded={open}
        title="What do the agent id and api token fields do?"
        className="flex h-[32px] w-[32px] items-center justify-center border border-line bg-surface font-serif text-[13px] italic leading-none text-muted transition-colors hover:bg-muted-bg hover:text-ink active:scale-[0.98] md:h-[26px] md:w-[26px] pointer-coarse:min-h-11 pointer-coarse:min-w-11"
      >
        i
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Operator field reference"
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-80 border-2 border-ink/70 bg-surface p-3 text-left"
        >
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            Operator fields
          </p>
          <dl className="space-y-2">
            <div>
              <dt className="font-mono text-[11px] text-ink">agent id (auto-claim)</dt>
              <dd className="text-[11px] leading-snug text-muted">
                Binds this browser to an agent identity. While bound, the board
                heartbeats its task leases and auto-claims the next eligible task.
                Press Enter or click away to bind. Empty = monitor only.
              </dd>
            </div>
            <div>
              <dt className="font-mono text-[11px] text-ink">api token</dt>
              <dd className="text-[11px] leading-snug text-muted">
                Credential for writes (claim, heartbeat, log). Sent as an
                Authorization: Bearer header; stored in this browser only, never in a
                URL. Reads need no token — without one the board shows{' '}
                <span className="font-mono text-[10px] uppercase tracking-wider">read-only</span>.
              </dd>
            </div>
          </dl>
          {bugReportEnabled && onReportBug && (
            <>
              <div className="my-2.5 border-t border-line" />
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  onReportBug()
                }}
                className="w-full border border-line bg-surface px-2 py-1.5 text-left font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg pointer-coarse:min-h-11"
              >
                Report a bug
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
