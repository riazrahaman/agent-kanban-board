import { useEffect, useRef, useState } from 'react'
import { submitBugReport } from '../api'
import {
  DESCRIPTION_MAX,
  TITLE_MAX,
  TURNSTILE_ACTION,
  buildBugReportPayload,
  canSubmitBugReport,
  describeSubmitError,
  formatViewport,
  remainingChars,
  validateDescription,
  validateTitle,
} from '../lib/bugReport'

type Props = {
  open: boolean
  siteKey: string | null
  onClose: () => void
}

type TurnstileWidget = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string
      action: string
      callback: (token: string) => void
      'error-callback'?: () => void
      'expired-callback'?: () => void
      size?: 'normal' | 'compact' | 'flexible'
    },
  ) => string
  reset: (widgetId?: string) => void
  remove: (widgetId?: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileWidget
  }
}

const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

// Module-level so the script is fetched at most once no matter how many
// times the sheet is opened/closed in a session.
let turnstileScriptPromise: Promise<void> | null = null
function loadTurnstileScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (window.turnstile) return Promise.resolve()
  if (!turnstileScriptPromise) {
    turnstileScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = TURNSTILE_SCRIPT_SRC
      script.async = true
      script.onload = () => resolve()
      script.onerror = () => {
        turnstileScriptPromise = null
        reject(new Error('Failed to load Turnstile'))
      }
      document.head.appendChild(script)
    })
  }
  return turnstileScriptPromise
}

/**
 * The "Report a bug" sheet (v2.16.0, opt-public-bug-reports). Mirrors
 * TaskSheet's slide-in-from-the-right shell so it reads as the same pattern
 * as every other panel on the board, even though this one needs no task.
 *
 * The Turnstile script + widget are created lazily — only once `open` is
 * true — so an anonymous visitor who never opens the form never loads
 * Cloudflare's script at all.
 */
export default function BugReportDialog({ open, siteKey, onClose }: Props) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [website, setWebsite] = useState('') // honeypot — stays empty for a human
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ issue_number: number; issue_url: string } | null>(null)

  const widgetContainerRef = useRef<HTMLDivElement | null>(null)
  const widgetIdRef = useRef<string | undefined>(undefined)

  // Lazy-load the script and render the widget only once the form is open
  // AND the server has told us Turnstile is configured (siteKey present).
  useEffect(() => {
    if (!open || !siteKey) return
    let cancelled = false
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !widgetContainerRef.current || !window.turnstile) return
        widgetIdRef.current = window.turnstile.render(widgetContainerRef.current, {
          sitekey: siteKey,
          action: TURNSTILE_ACTION,
          callback: (token) => setTurnstileToken(token),
          'error-callback': () => setTurnstileToken(null),
          'expired-callback': () => setTurnstileToken(null),
          // 'flexible' fills the container's width (down to Cloudflare's own
          // ~300px floor) instead of a fixed 300x65 box — on a 320px phone
          // viewport a fixed-width widget can itself force the sheet wider
          // than the viewport. Still defensive-only below that floor; see
          // the widgetContainerRef wrapper's overflow-hidden/max-w-full.
          size: 'flexible',
        })
      })
      .catch(() => {
        // Leaves turnstileToken null — submit just stays disabled.
      })
    return () => {
      cancelled = true
      if (window.turnstile && widgetIdRef.current) {
        window.turnstile.remove(widgetIdRef.current)
      }
      widgetIdRef.current = undefined
    }
  }, [open, siteKey])

  // Clean slate every time the sheet closes, so reopening never shows a
  // stale success/error from the previous report.
  useEffect(() => {
    if (open) return
    setTitle('')
    setDescription('')
    setWebsite('')
    setTurnstileToken(null)
    setSubmitting(false)
    setError(null)
    setSuccess(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!turnstileToken || submitting) return
    setSubmitting(true)
    setError(null)
    const viewport =
      typeof window !== 'undefined' ? formatViewport(window.innerWidth, window.innerHeight) : '0x0'
    const payload = buildBugReportPayload({ title, description, turnstileToken, viewport, website })
    const result = await submitBugReport(payload)
    setSubmitting(false)
    if (!result.ok) {
      setError(describeSubmitError(result.status, result.code))
      // Reset the widget after any failed submit — a Turnstile token is
      // single-use, so a stale one would just fail again server-side.
      if (window.turnstile && widgetIdRef.current) window.turnstile.reset(widgetIdRef.current)
      setTurnstileToken(null)
      return
    }
    setSuccess({ issue_number: result.issue_number, issue_url: result.issue_url })
  }

  const titleError = title.length > 0 ? validateTitle(title) : undefined
  const descriptionError = description.length > 0 ? validateDescription(description) : undefined
  const canSubmit = canSubmitBugReport(title, description, turnstileToken) && !submitting

  return (
    <>
      <div
        className={[
          'fixed inset-0 z-40 bg-black/40 dark:bg-black/60 transition-opacity',
          open ? 'opacity-100 pointer-events-auto' : 'pointer-events-none opacity-0',
        ].join(' ')}
        onClick={onClose}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Report a bug"
        // When closed, take the panel out of the accessibility tree and out
        // of tab order immediately (not just after the 200ms slide-out
        // finishes) — `inert` is purely an interaction/a11y property, so it
        // does not affect the close animation's visibility.
        inert={!open ? true : undefined}
        className={[
          'fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col',
          'border-l border-line bg-surface transition-transform duration-200',
          // `box-border` + an explicit `max-w-[100vw]` on top of `max-w-md`:
          // belt-and-suspenders so this panel can never itself measure wider
          // than the viewport, however narrow, regardless of border/padding
          // box-model surprises. `overflow-x-hidden` is the same guard the
          // WebKit `translate-x-full` fix below relies on (see the comment
          // on html/body in index.css) applied again at the panel itself.
          'box-border max-w-[100vw] overflow-x-hidden',
          open ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
        style={{ height: '100dvh' }}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line p-4">
          <h2 className="font-serif text-lg text-ink">Report a bug</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 font-mono text-xs text-muted hover:text-ink transition-colors pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:flex pointer-coarse:items-center pointer-coarse:justify-center"
          >
            ✕
          </button>
        </div>

        {/* Scrollable body: everything except the submit button, which is
            pinned in its own shrink-0 footer below (see the form="..." wiring
            on the button) so it — and the Turnstile "Success" state right
            above it — stay reachable by scrolling the SHEET even when a
            phone's bottom chrome (e.g. Safari's floating toolbar) covers the
            last ~50px of the viewport. `overflow-y-auto overscroll-contain`
            was previously on the <aside> itself; moving it to just this
            region keeps the header and footer always visible. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          <p className="border border-line bg-muted-bg p-2.5 text-[11px] leading-snug text-muted">
            Reports are public on GitHub. Do not include passwords, tokens or personal data.
          </p>

          <div role="status" aria-live="polite" className="mt-4">
            {success && (
              <div className="border border-pass bg-pass-bg p-3 text-sm text-pass">
                <p>Thanks — filed as issue #{success.issue_number}.</p>
                <a
                  href={success.issue_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1.5 inline-block font-mono text-[11px] underline"
                >
                  View on GitHub ↗
                </a>
              </div>
            )}
          </div>

          {!success && (
            <form id="bug-report-form" onSubmit={handleSubmit} className="mt-4 space-y-4">
              <div>
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="bug-report-title"
                    className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted"
                  >
                    Title
                  </label>
                  <span className="font-mono text-[10px] tabular-nums text-muted">
                    {remainingChars(title, TITLE_MAX)}
                  </span>
                </div>
                <input
                  id="bug-report-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={TITLE_MAX}
                  required
                  className="mt-1.5 w-full border border-line bg-bg px-2.5 py-1.5 text-sm text-ink placeholder:text-muted focus:border-ink focus:outline-none pointer-coarse:min-h-11 pointer-coarse:text-base"
                  placeholder="Short summary of the bug"
                />
                {titleError && <p className="mt-1 font-mono text-[11px] text-fail">{titleError}</p>}
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="bug-report-description"
                    className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted"
                  >
                    Description
                  </label>
                  <span className="font-mono text-[10px] tabular-nums text-muted">
                    {remainingChars(description, DESCRIPTION_MAX)}
                  </span>
                </div>
                <textarea
                  id="bug-report-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={DESCRIPTION_MAX}
                  required
                  rows={8}
                  className="mt-1.5 w-full resize-none border border-line bg-bg px-2.5 py-1.5 text-sm text-ink placeholder:text-muted focus:border-ink focus:outline-none pointer-coarse:text-base"
                  placeholder="What did you expect? What happened instead? Steps to reproduce help a lot."
                />
                {descriptionError && (
                  <p className="mt-1 font-mono text-[11px] text-fail">{descriptionError}</p>
                )}
              </div>

              {/* Honeypot: pulled off-screen (not display:none — some bots
                  skip fields hidden that way), aria-hidden, unreachable by
                  Tab. Any non-empty value here fails the report silently
                  server-side (200 {ok:true}, nothing filed). */}
              <div aria-hidden="true" className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden">
                <label htmlFor="bug-report-website">Website</label>
                <input
                  id="bug-report-website"
                  name="website"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  // v2.17.0: text-base (16px) for the same reason as the other
                  // fields in this dialog — a sub-16px input font size makes
                  // iOS Safari zoom the viewport on focus. This field is
                  // off-screen and never focused by a real user, but a
                  // same-origin script or assistive tech could still land
                  // focus on it, so it carries the same defense as the rest.
                  className="text-base"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>

              {/* `overflow-hidden max-w-full` is a defensive cap on top of
                  Turnstile's own `size: 'flexible'` render option — if
                  Cloudflare's iframe ever renders at its ~300px floor on a
                  viewport narrower than that, it is clipped rather than
                  forcing the sheet (and the document) wider than the
                  viewport. */}
              <div ref={widgetContainerRef} className="max-w-full overflow-hidden" />

              {error && (
                <p role="alert" className="font-mono text-xs text-fail break-words [overflow-wrap:anywhere]">
                  {error}
                </p>
              )}
            </form>
          )}
        </div>

        {/* Pinned footer, not part of the scrollable body: on a phone whose
            browser chrome floats a toolbar over the bottom of the viewport
            (observed on iOS Safari), a submit button living at the end of a
            long scrollable form can end up permanently under that toolbar
            with no way to scroll it into view, because the toolbar is not
            counted in `100dvh` while it is showing. Pinning it in its own
            shrink-0 flex child — reachable by constrution since it is never
            part of the scrolled content — plus a safe-area-aware bottom
            padding keeps it tappable regardless of the toolbar's height.
            `form="bug-report-form"` associates it with the <form> above by
            id so it still submits natively despite living outside it. */}
        {!success && (
          <div className="shrink-0 border-t border-line p-4 pb-[calc(1rem_+_env(safe-area-inset-bottom))]">
            <button
              type="submit"
              form="bug-report-form"
              disabled={!canSubmit}
              className="w-full bg-ink text-bg px-3 py-2 font-mono text-xs font-medium uppercase tracking-wider transition-opacity hover:opacity-85 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:min-h-11"
            >
              {submitting ? 'Filing…' : 'Submit report'}
            </button>
          </div>
        )}
      </aside>
    </>
  )
}
