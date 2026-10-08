import { useEffect, useRef, useState } from 'react'

/**
 * A small "i" affordance in the header that explains the two operator fields
 * (agent id + api token). Discoverable on demand without permanently
 * spending header space on prose.
 *
 * v2.17.0 (mobile-dialog-theme-auto-bugicon): this popover USED to also host
 * a bug-reporting row (v2.16.0) — moved out to its own header icon button
 * beside the theme toggle (see App.tsx) because a popover entry was still a
 * multi-tap discovery path on a phone. The `max-lg:fixed` viewport-anchored
 * containment fix below (round 4) stays: it fixes a real clipping bug in
 * THIS popover's own positioning, unrelated to what it contains.
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
        className="flex h-[32px] w-[32px] items-center justify-center border border-line bg-surface font-serif text-[13px] italic leading-none text-muted transition-colors hover:bg-muted-bg hover:text-ink active:scale-[0.98] md:h-[26px] md:w-[26px] pointer-coarse:min-h-11 pointer-coarse:min-w-11"
      >
        i
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Operator field reference"
          // v2.16.0 fix: an unconditional `absolute right-0 w-80` clipped off
          // the LEFT edge of the viewport whenever this popover's anchor (the
          // "i" button, wherever it lands in the header's flex row) sat less
          // than 320px from the left edge — measured at 320-390px (~44%
          // clipped) AND at 768-820px, where the full header-controls row is
          // already inline and crowds the button rightward past the point a
          // 320px-wide right-anchored popover can still fit. `right:0` alone
          // can never guarantee containment: it is anchored to the BUTTON,
          // not the viewport, so no width/max-width tweak fixes it on its
          // own. Below `lg` (1024px) this mirrors ColumnColorsControl's own
          // `max-sm:` convention, just at a wider cutover to cover the
          // measured range: a `fixed`, viewport-anchored bottom sheet that
          // does not care where the button is at all. `lg:` and up reverts
          // to the original anchored dropdown (verified to fit at
          // 1024/1280/1440/1920 in real Chrome). `max-w-[calc(100vw-1.5rem)]`
          // is an unconditional safety net at every width.
          className="z-50 border-2 border-ink/70 bg-surface p-3 text-left max-w-[calc(100vw-1.5rem)] max-lg:fixed max-lg:inset-x-3 max-lg:top-auto max-lg:bottom-4 max-lg:w-auto max-lg:max-h-[calc(100dvh-2rem)] max-lg:overflow-y-auto lg:absolute lg:right-0 lg:top-[calc(100%+6px)] lg:w-80"
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
