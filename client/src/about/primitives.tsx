import type { ReactNode } from 'react'

/**
 * C1 (v3.12.5) — the About page's smallest shared pieces, extracted verbatim
 * from components/About.tsx so the page shell and the per-chapter section
 * components can share them without a cycle. Rendering is byte-identical.
 */

export function Cta({
  href,
  children,
  className = '',
}: {
  href: string
  children: ReactNode
  className?: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex items-center border border-line bg-surface px-4 py-2 font-mono text-xs uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg ${className}`}
    >
      {children}
    </a>
  )
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="block font-mono text-[12px] uppercase tracking-wider text-muted sm:hidden">
      {children}
    </span>
  )
}

export function FlowRow({
  label,
  title,
  detail,
}: {
  label: string
  title: ReactNode
  detail: ReactNode
}) {
  return (
    <div className="flex gap-4 border-b border-line py-3 last:border-0">
      <span className="flex h-8 w-8 flex-none items-center justify-center border border-line bg-surface font-mono text-xs font-semibold text-ink">
        {label}
      </span>
      <div className="min-w-0">
        <div className="text-[15px] font-medium text-ink">{title}</div>
        <div className="mt-1 text-sm leading-relaxed text-muted">{detail}</div>
      </div>
    </div>
  )
}

export function Kicker({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`font-mono text-xs uppercase tracking-[0.2em] ${className || 'text-muted'}`}>
      {children}
    </div>
  )
}

export function FileChips({ files }: { files: string[] }) {
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {files.map((f) => (
        <code
          key={f}
          className="border border-line bg-surface px-2 py-1 font-mono text-xs text-muted"
        >
          {f}
        </code>
      ))}
    </div>
  )
}
