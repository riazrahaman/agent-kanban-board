/**
 * Header brand mark: the "Three-Column Ledger" favicon, drawn inline so it
 * follows the app theme (--ink / --line / --live / --pass) instead of the OS
 * scheme the standalone favicon.svg follows. It also replaces the old pulsing
 * blue square as the live-connection signal: the blue "live agent" card in the
 * centre lane is the part that pulses (same `animate-pulse` the square used),
 * so the board keeps a heartbeat without a separate dot.
 *
 * Keep the geometry in step with client/public/favicon.svg (32x32 grid).
 */
export default function BrandMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={`shrink-0 ${className}`}
      role="img"
      aria-label="Live connection"
      data-testid="brand-mark"
    >
      <rect x="1" y="1" width="30" height="30" rx="6" fill="var(--surface)" />
      <rect x="1.5" y="1.5" width="29" height="29" rx="5.5" fill="none" stroke="var(--line)" strokeWidth="1.5" />
      <rect x="11" y="5" width="1.2" height="22" rx="0.6" fill="var(--line)" />
      <rect x="20" y="5" width="1.2" height="22" rx="0.6" fill="var(--line)" />
      <rect x="5" y="7" width="4.5" height="5" rx="1" fill="var(--ink)" />
      <rect x="5" y="14" width="4.5" height="7" rx="1" fill="var(--ink)" />
      <rect
        x="13.7"
        y="7"
        width="4.6"
        height="9"
        rx="1"
        fill="var(--live)"
        className="animate-pulse motion-reduce:animate-none"
        data-testid="brand-mark-live"
      />
      <rect x="13.7" y="18" width="4.6" height="5" rx="1" fill="var(--ink)" />
      <rect x="22.5" y="7" width="4.5" height="6" rx="1" fill="var(--pass)" />
      <rect x="22.5" y="15" width="4.5" height="4" rx="1" fill="var(--ink)" />
    </svg>
  )
}
