import {
  ARCH_DIAGRAM,
  ARCH_INTRO,
  ARCH_LAYERS,
  CLAIM_FLOW,
  CURL_SNIPPET,
  ENV_VARS,
  FAQ,
  LIFECYCLE_STEPS,
  RECLAIM_FLOW,
  RECLAIM_INTRO,
  SAFETY_FOOTER,
  SAFETY_LAYERS,
} from '../lib/aboutContent'
import type { Chapter } from '../lib/aboutContent'
import { ArchitectureDiagram } from './ArchitectureDiagram'
import { AskArchitectureFigure } from './Ask'
import { FileChips, FlowRow } from './primitives'

/**
 * C1 (v3.12.5) — one chapter of the field guide: the ELI5 / under-the-hood /
 * snippet / gotcha grammar plus the per-chapter reference blocks. Extracted
 * verbatim from components/About.tsx; the chapter data still comes from
 * lib/aboutContent.ts, so the article contract is unchanged.
 */

// ---------------------------------------------------------------------------
// A single chapter
// ---------------------------------------------------------------------------

export function ChapterBody({ chapter }: { chapter: Chapter }) {
  return (
    <>
      {/* `.ch-head` grammar from the benchmark: a 2px ink rule across the top,
          a mono accent chapter number in the left column spanning both rows,
          and a heavy SANS heading — Instrument Serif has no bold face, so it
          is kept for italic accents and never for a heading that must carry
          weight. */}
      <div className="border-t-2 border-ink pt-4 mb-7 grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 items-baseline">
        <span className="font-mono text-[13px] uppercase tracking-[0.1em] text-live sm:row-span-2">
          Chapter {chapter.number}
        </span>
        <h2 className="flex items-center gap-3 text-[clamp(1.75rem,3.4vw,2.9rem)] font-bold leading-[1.05] tracking-[-0.03em] text-ink">
          <span>{chapter.title}</span>
          <span aria-hidden="true" className="emo text-[0.7em]">
            {chapter.emoji}
          </span>
        </h2>
        <p className="max-w-[46em] text-[16.5px] leading-relaxed text-muted col-start-1 sm:col-start-2">
          <span className="mr-2 inline-block border border-line bg-muted-bg px-2 py-0.5 font-mono text-[12px] uppercase tracking-wider text-ink">
            ELI5
          </span>
          {chapter.eli5}
        </p>
      </div>

      <h3 className="mt-6 font-mono text-[12px] uppercase tracking-[0.1em] text-muted">
        Under the hood
      </h3>
      <p className="mt-2.5 max-w-[46em] text-[16.5px] leading-relaxed text-muted">{chapter.underTheHood}</p>

      <div className="about-code mt-4 border border-line">
        <div className="border-b border-line/40 px-3.5 py-2 font-mono text-[12.5px] uppercase tracking-wider opacity-70">
          {chapter.snippet.label}
        </div>
        <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[13px] leading-relaxed">
          {chapter.snippet.code}
        </pre>
      </div>

      <p className="mt-4 border-l-2 border-warn pl-3.5 text-[15.5px] leading-relaxed text-muted">
        <span className="font-mono text-[12px] font-semibold uppercase tracking-wider text-warn mr-1">Gotcha </span>
        {chapter.gotcha}
      </p>

      <FileChips files={chapter.files} />

      {/* Chapter extras drawn from the data-driven reference blocks. */}
      {chapter.id === 'states' && (
        <ol className="mt-6 space-y-2.5">
          {LIFECYCLE_STEPS.map((s) => (
            <li
              key={s.status}
              className="flex flex-wrap items-baseline gap-x-3 border-l-2 border-line pl-3.5 py-0.5"
            >
              <span className="font-mono text-[13px] font-semibold uppercase tracking-wider text-ink">
                {s.status}
              </span>
              <span className="font-mono text-[12px] uppercase tracking-wider text-muted">
                {s.actor}
              </span>
              <span className="text-[15.5px] text-muted">{s.detail}</span>
            </li>
          ))}
        </ol>
      )}

      {chapter.id === 'claims' && (
        <pre className="mt-5 overflow-x-auto border border-line bg-surface p-4 font-mono text-[13px] leading-relaxed text-ink">
          {CURL_SNIPPET}
        </pre>
      )}

      {chapter.id === 'reaper' && (
        <div className="mt-5">
          <p className="max-w-3xl text-[16.5px] leading-relaxed text-muted">{RECLAIM_INTRO}</p>
          <div className="mt-4">
            {RECLAIM_FLOW.map((s) => (
              <FlowRow key={s.label} label={s.label} title={s.title} detail={s.detail} />
            ))}
          </div>
        </div>
      )}

      {chapter.id === 'conflicts' && (
        <div className="mt-5">
          <div>
            {SAFETY_LAYERS.map((s) => (
              <FlowRow key={s.label} label={s.label} title={s.name} detail={s.detail} />
            ))}
          </div>
          <p className="mt-4 font-mono text-[13px] leading-relaxed text-live">{SAFETY_FOOTER}</p>
        </div>
      )}

      {chapter.id === 'client' && (
        <div className="mt-5">
          <p className="max-w-3xl text-[16.5px] leading-relaxed text-muted">{ARCH_INTRO}</p>
          <div className="mt-4">
            {CLAIM_FLOW.map((s) => (
              <FlowRow key={s.label} label={s.label} title={s.title} detail={s.detail} />
            ))}
          </div>
          <div className="mt-6">
            {ARCH_LAYERS.map((s) => (
              <FlowRow key={s.label} label={s.label} title={s.title} detail={s.detail} />
            ))}
          </div>
        </div>
      )}

      {chapter.id === 'architecture' && (
        <div className="mt-5">
          <div className="border border-line bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-muted-bg/30 px-4 py-2.5">
              <span className="font-mono text-xs uppercase tracking-wider text-muted">
                Figure 01 · System Architecture &amp; Request Flow
              </span>
              <span className="font-mono text-[12px] uppercase tracking-wider text-muted">
                SVG 1.1 · Adaptive Theme · Zero Runtime
              </span>
            </div>
            <div className="w-full overflow-x-auto p-3 sm:p-5">
              <ArchitectureDiagram />
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 border-t border-line bg-muted-bg/10 px-4 py-2.5 font-mono text-xs text-muted">
              <span>{ARCH_DIAGRAM.desc}</span>
              <span className="sm:hidden text-live">⇄ Scroll sideways</span>
            </div>
          </div>
        </div>
      )}

      {chapter.id === 'config' && (
        <div className="mt-5 border border-line bg-surface">
          {ENV_VARS.map((v) => (
            <div
              key={v.name}
              className="flex flex-col gap-1 border-b border-line px-4 py-3 last:border-0 sm:flex-row sm:items-baseline sm:gap-6"
            >
              <code className="font-mono text-[13px] font-medium text-ink sm:w-72 sm:flex-none sm:[overflow-wrap:anywhere]">
                {v.name}
              </code>
              <span className="text-[15.5px] leading-relaxed text-muted">
                {v.purpose}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* The console itself lives in the hero, rendered by the AskCard there. This
          chapter keeps the explanation and points back up, so the reader who
          arrives here by scrolling is not handed a second, duplicate form. */}
      {chapter.id === 'ask' && (
        <div className="mt-5 space-y-5">
          <p className="border border-line bg-surface p-4 text-[16.5px] leading-relaxed text-muted">
            The console is at the top of this page — it is the first thing in the
            guide rather than the last.{' '}
            <a href="#top" className="font-medium text-live underline underline-offset-2">
              Go and ask it something →
            </a>
          </p>
          <AskArchitectureFigure />
        </div>
      )}

      {chapter.id === 'faq' && (
        <div className="mt-5 space-y-2.5">
          {FAQ.map((f) => (
            <details key={f.q} className="border border-line bg-surface p-4">
              <summary className="cursor-pointer text-[17px] font-medium text-ink py-0.5">{f.q}</summary>
              <p className="mt-2.5 text-[15.5px] leading-relaxed text-muted">{f.a}</p>
            </details>
          ))}
        </div>
      )}
    </>
  )
}
