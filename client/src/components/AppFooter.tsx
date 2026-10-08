type Props = {
  /** v2.16.3 (report-bug-footer-link): only when the server confirms the
   *  feature is configured — same gate as HeaderHelp's popover entry and
   *  About's CTA. A phone visitor had to find the header's "i" disclosure
   *  (behind the `⋯` toggle: 3 taps) or scroll to the About page to see
   *  "Report a bug" at all. This renders a slim, always-reachable third
   *  entry point at the very end of the page content instead. Rendered as
   *  `null` (no `<footer>` at all) when the flag is off, so an operator who
   *  never enables the feature sees zero layout change. */
  bugReportEnabled: boolean
  onReportBug: () => void
}

/**
 * The last thing on the page, below the main board/portfolio/about area:
 * a single, low-key "Report a bug" link. Deliberately NOT `fixed`/`sticky` —
 * it must never cover the board, the Signal rail or a card — and it sits
 * as a sibling of `<main>` in the app shell's `flex h-screen flex-col`
 * column, so it costs real (but tiny) height taken out of `<main>`'s
 * `flex-1` share rather than floating over it or requiring a second
 * scrollbar anywhere.
 */
export default function AppFooter({ bugReportEnabled, onReportBug }: Props) {
  if (!bugReportEnabled) return null

  return (
    <footer className="shrink-0 border-t border-line bg-surface px-3 text-center sm:px-4">
      <button
        type="button"
        onClick={onReportBug}
        title="Report a bug — opens a short form (title, description, captcha)"
        className="inline-flex items-center justify-center py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:text-ink active:scale-[0.98] pointer-coarse:min-h-11"
      >
        Report a bug
      </button>
    </footer>
  )
}
