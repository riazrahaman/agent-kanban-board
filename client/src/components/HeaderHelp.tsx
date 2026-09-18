import { useEffect, useRef, useState } from 'react'

/**
 * A small "i" affordance in the header that explains the two operator fields
 * (agent id + api token). Discoverable on demand without permanently spending
 * header space on prose.
 */
export default function HeaderHelp() {
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
        className="flex h-[26px] w-[26px] items-center justify-center border border-line bg-surface font-serif text-[13px] italic leading-none text-muted transition-colors hover:bg-muted-bg hover:text-ink active:scale-[0.98]"
      >
        i
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Operator field reference"
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-80 border border-line bg-surface p-3 text-left shadow-xl"
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
        </div>
      )}
    </div>
  )
}
