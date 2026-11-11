import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ABOUT_GITHUB_URL,
  ABOUT_LIVE_URL,
  CAPABILITIES,
  CHAPTERS,
  FIELD_GUIDE,
  HERO,
  ORCHESTRATOR_SKILL,
  SKILL_HUB_URL,
  SKILL_STANDALONE_REPO_URL,
  STACK_ROWS,
  TOUR_SHOTS,
  TRUST_METRICS,
  WHY_CARDS,
} from '../lib/aboutContent'
import { PHONE_LAYOUT_QUERY } from '../lib/scrollLock'
import { formatVisitCount } from '../lib/useVisitCount'
import type { VisitState } from '../lib/useVisitCount'
// C1 (v3.12.5): the page shell keeps the masthead, hero, rail and chapter bar;
// the per-chapter article body and its figures live in ../about/*. Each file is
// a verbatim extraction, so the rendered markup is unchanged.
import { ChapterBody } from '../about/ChapterBody'
import { AskCard } from '../about/Ask'
import { VideoShowcase } from '../about/VideoShowcase'
import { Cta, FieldLabel, Kicker } from '../about/primitives'
type Props = {
  version: string | null
  visit: VisitState
  /** v2.16.0 (opt-public-bug-reports): hidden entirely when the operator has
   *  not configured Report-a-bug (see App.tsx's one-time config fetch). */
  bugReportEnabled?: boolean
  onReportBug?: () => void
}

const SECTIONS = CHAPTERS.map((c) => ({ id: c.id, title: c.title }))

/** Look up a trust metric's value by its label, so the headline figures in the
 *  numbers strip come from the same constant `about.test.mjs` cross-checks
 *  against the real suite sizes instead of being retyped into the JSX. */
const metric = (label: string) => TRUST_METRICS.find((m) => m.label === label)?.value ?? '—'

const NUMBERS = [
  { value: '8', label: 'Lifecycle states', detail: 'Strict, forward-only, role-gated' },
  { value: '0', label: 'Database engines', detail: 'Atomic rename-writes to a file' },
  { value: metric('server tests'), label: 'Server tests', detail: 'Plus ' + metric('client tests') + ' on the client' },
  { value: '1', label: 'Write lock', detail: 'Every mutation serialized' },
]
// ---------------------------------------------------------------------------
// About view
// ---------------------------------------------------------------------------

export default function About({ version, visit, bugReportEnabled, onReportBug }: Props) {
  const { count: visitCount, counted: visitCounted } = visit
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0]?.id ?? 'states')
  const [showTop, setShowTop] = useState(false)
  // Where a chapter jump came FROM, so it can be undone (#113). Stored as a
  // scroll offset rather than an element: it returns you to the sentence you
  // were on, where returning to the origin chapter's heading would not.
  // `left` guards the retire-on-return check below: a smooth jump fires scroll
  // events from the origin outwards, so an unguarded "are we back yet" test is
  // true on the very first one and cancels the offer before the reader has
  // gone anywhere. It flips once the jump has actually travelled.
  const [backTo, setBackTo] = useState<{ top: number; label: string; left: boolean } | null>(
    null,
  )
  const viewRef = useRef<HTMLDivElement | null>(null)
  const tocRef = useRef<HTMLElement | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)

  // The scroller is the `.about-view` div everywhere except the phone layout,
  // where index.css hands scrolling back to the document (so iOS Safari can
  // draw behind its floating toolbar). Everything below — the reading line,
  // the Top button, the smooth jumps — has to ask which one is in charge.
  //
  // `phoneLayout` is state, not a one-off read: rotating a phone to landscape
  // leaves the query, which swaps the scroller. Without re-running on that
  // change the scroll-spy and the Top button bind to an element that no longer
  // scrolls and silently go dead.
  const [phoneLayout, setPhoneLayout] = useState(
    () => typeof matchMedia === 'function' && matchMedia(PHONE_LAYOUT_QUERY).matches,
  )

  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia(PHONE_LAYOUT_QUERY)
    const onChange = () => setPhoneLayout(mq.matches)
    mq.addEventListener('change', onChange)
    onChange()
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const getScroller = useCallback((): HTMLElement | Window => {
    const el = viewRef.current
    if (!el || phoneLayout) return window
    return el.scrollHeight > el.clientHeight + 1 ? el : window
  }, [phoneLayout])

  /** Height of the app header while it is sticky above the guide — 0 on every
   *  layout but the phone one, where the document is the scroller. */
  const appHeaderH = () => {
    if (!phoneLayout || typeof getComputedStyle !== 'function') return 0
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--app-header-h')
    return Number.parseFloat(raw) || 0
  }

  const motion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      ? ('auto' as const)
      : ('smooth' as const)

  // Scroll-spy. The pill that lights up is the LAST chapter whose top has
  // passed a reading line just under the sticky bar — not simply the first
  // element the observer reports intersecting, which lights whichever entry
  // the callback happens to list first and flickers between neighbours.
  // IntersectionObserver is kept purely as the cheap "something moved" trigger
  // (ported from stack-field-guide guide.js).
  useEffect(() => {
    const sections = SECTIONS.map((s) => document.getElementById(s.id)).filter(
      Boolean,
    ) as HTMLElement[]
    if (sections.length === 0) return

    // Everything pinned above the text counts: the chapter bar always, plus
    // the app header on the phone layout, where it is sticky over the document.
    const tocHeight = () => (tocRef.current?.offsetHeight ?? 0) + appHeaderH()
    const readLine = () => tocHeight() + Math.min(160, window.innerHeight * 0.25)

    const spyNow = () => {
      const scroller = getScroller()
      const atBottom =
        scroller === window
          ? window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2
          : (scroller as HTMLElement).scrollTop + (scroller as HTMLElement).clientHeight >=
            (scroller as HTMLElement).scrollHeight - 2
      const line = atBottom ? window.innerHeight - 1 : readLine()
      let hit: HTMLElement | null = null
      for (const sec of sections) {
        const r = sec.getBoundingClientRect()
        if (r.top <= line && r.bottom > 0) hit = sec
      }
      if (hit && hit.getBoundingClientRect().bottom < tocHeight()) hit = null
      if (hit) setActiveSection(hit.id)
      const top =
        scroller === window ? window.scrollY : (scroller as HTMLElement).scrollTop
      setShowTop(top > 600)
      setBackTo((prev) => {
        if (!prev) return prev
        const away = Math.abs(top - prev.top)
        if (!prev.left) return away > 400 ? { ...prev, left: true } : prev
        // Back at roughly where the jump started, under the reader's own
        // steam: the offer is spent, so retire it rather than leave a stale
        // label pointing at where they already are.
        return away < 140 ? null : prev
      })
    }

    const scroller = getScroller()
    scroller.addEventListener('scroll', spyNow, { passive: true })
    window.addEventListener('resize', spyNow)

    let observer: IntersectionObserver | null = null
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(spyNow, { threshold: [0, 0.01, 1] })
      sections.forEach((s) => observer!.observe(s))
    }
    spyNow()

    return () => {
      scroller.removeEventListener('scroll', spyNow)
      window.removeEventListener('resize', spyNow)
      observer?.disconnect()
    }
  }, [getScroller, phoneLayout])

  // Keep `--toc-h` equal to the bar's real height, so every chapter anchor's
  // scroll-margin clears it — one scrolling row on phones, a taller wrapped
  // block on desktop, nothing at all once the wide-screen rail takes over.
  useEffect(() => {
    const bar = tocRef.current
    const view = viewRef.current
    if (!bar || !view || typeof ResizeObserver === 'undefined') return
    const publish = () => view.style.setProperty('--toc-h', `${bar.offsetHeight}px`)
    const ro = new ResizeObserver(publish)
    ro.observe(bar)
    publish()
    return () => ro.disconnect()
  }, [])

  // Fade the right edge of the pill row until it is scrolled to the end, so
  // it is visible that more chapters exist off-screen (stack-field-guide #5:
  // chapters past the fold had no affordance at all).
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const fade = () =>
      strip.classList.toggle('at-end', strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 4)
    strip.addEventListener('scroll', fade, { passive: true })
    window.addEventListener('resize', fade)
    fade()
    return () => {
      strip.removeEventListener('scroll', fade)
      window.removeEventListener('resize', fade)
    }
  }, [])

  const scrollOffset = () => {
    const scroller = getScroller()
    return scroller === window ? window.scrollY : (scroller as HTMLElement).scrollTop
  }

  const scrollTo = (id: string) => {
    const el = document.getElementById(id)
    if (!el) return
    const from = scrollOffset()
    const fromLabel = SECTIONS.find((s) => s.id === activeSection)?.title
    const distance = Math.abs(el.getBoundingClientRect().top)
    // Only offer the return trip when the jump actually took you somewhere.
    // Nudging to the chapter you are already reading needs no way back, and a
    // chip that appears on every click is noise rather than an affordance.
    if (fromLabel && id !== activeSection && distance > window.innerHeight / 2) {
      setBackTo({ top: from, label: fromLabel, left: false })
    }
    el.scrollIntoView({ behavior: motion(), block: 'start' })
    setActiveSection(id)
  }

  const goBack = () => {
    if (!backTo) return
    getScroller().scrollTo({ top: backTo.top, behavior: motion() })
    setBackTo(null)
  }

  const scrollToTop = () => {
    const scroller = getScroller()
    scroller.scrollTo({ top: 0, behavior: motion() })
    stripRef.current?.scrollTo({ left: 0, behavior: motion() })
  }

  return (
    // Same floating-toolbar clearance as Column.tsx/Portfolio.tsx; in the
    // phone layout (index.css, `about-view` hook) it flows in the document.
    <div
      ref={viewRef}
      // Same floating-toolbar clearance as Column.tsx/Portfolio.tsx; in the
      // phone layout (index.css, `about-view` hook) it flows in the document.
      className="about-view h-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden max-md:pointer-coarse:pb-[calc(5rem+env(safe-area-inset-bottom,0px))]"
    >
      <div className="about-shell mx-auto w-full px-4 py-7 sm:px-6 lg:px-8">
        {/* Masthead: edition line + version, closed by the 2px ink rule. The
            repository / live-board / skill links used to be repeated here AND
            in the hero; they are now in the hero only, so the fold carries the
            headline and the console rather than two copies of the same row. */}
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b-2 border-ink pb-3">
          <span className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-muted">
            <span aria-hidden="true" className="text-live">
              ●
            </span>
            {FIELD_GUIDE.kicker} <span className="text-ink">{FIELD_GUIDE.edition}</span>
            <span className="text-muted/60">·</span>
            <span className="text-ink">{FIELD_GUIDE.title}</span>
          </span>
          {version && (
            <span className="ml-auto border border-line bg-surface px-2.5 py-0.5 font-mono text-xs uppercase tracking-wider text-ink">
              v{version}
            </span>
          )}
        </header>

        {/* Hero. Two columns that START together — the previous build aligned
            them to the baseline, which left a column of empty paper above the
            headline whenever the right side ran taller. The right side is now
            the Ask console: the page's one interactive feature, above the fold
            instead of eleven chapters down. */}
        <header id="top" className="scroll-mt-4">
          {/* DOM order is headline → console → specifications, so on a phone
              (one column) the console arrives directly under the lede rather
              than below four meta rows and three stacked buttons. From `lg`
              the three blocks are placed explicitly into two columns, which
              puts the console back on the right beside the headline. */}
          <div className="grid grid-cols-1 items-start gap-x-12 gap-y-8 border-b border-line pb-8 pt-9 lg:grid-cols-[1.15fr_0.95fr]">
            <div className="min-w-0 lg:col-start-1 lg:row-start-1">
              <p className="font-mono text-[13px] uppercase tracking-[0.2em] text-muted">
                A kanban board where the users aren&apos;t human
              </p>
              {/* Heavy SANS display type with Instrument Serif reserved for the
                  italic accents — the serif has no bold face, so setting the
                  whole headline in it reads light and literary instead of
                  authoritative. */}
              <h1 className="mt-4 text-[clamp(2.5rem,5.6vw,4.5rem)] font-bold leading-[0.95] tracking-[-0.035em] text-ink">
                {HERO.before}
                <em className="font-serif font-normal italic tracking-[-0.01em] text-live">
                  {HERO.accentOne}
                </em>
                {HERO.middle}
                <em className="font-serif font-normal italic tracking-[-0.01em] text-live">
                  {HERO.accentTwo}
                </em>
                {HERO.after}
              </h1>
              <p className="mt-6 max-w-[34em] text-[18px] leading-relaxed text-muted">
                {HERO.lede}
              </p>
            </div>

            <div className="min-w-0 lg:col-start-2 lg:row-start-1 lg:row-span-2">
              <AskCard />
            </div>

            <div className="min-w-0 lg:col-start-1 lg:row-start-2">
              <div className="space-y-1.5 font-mono text-[13px] leading-[1.7] text-muted">
                <div>
                  <b className="font-semibold text-ink">Covers</b> → eight states, leases,
                  the reaper, two very different 409s, credentials
                </div>
                <div>
                  <b className="font-semibold text-ink">Engine</b> → one process-local
                  mutation lock · zero database
                </div>
                <div>
                  <b className="font-semibold text-ink">Protocol</b> → plain REST ·{' '}
                  <code className="border border-line bg-surface px-1.5 py-0.5 text-ink">
                    /api/events
                  </code>{' '}
                  SSE diffs
                </div>
                <div>
                  <b className="font-semibold text-ink">Edition</b> → {FIELD_GUIDE.kicker}{' '}
                  {FIELD_GUIDE.edition}
                  {version ? ` · v${version}` : ''}
                  {visitCount !== null ? ` · ${formatVisitCount(visitCount)}` : ''}
                </div>
              </div>
              <div className="mt-6 flex flex-wrap items-center gap-2.5">
                <Cta href={ABOUT_GITHUB_URL}>Download · fork · contribute →</Cta>
                <Cta href={ABOUT_LIVE_URL}>Open the live board →</Cta>
                <Cta href={SKILL_STANDALONE_REPO_URL}>Orchestrator skill →</Cta>
                {bugReportEnabled && onReportBug && (
                  <button
                    type="button"
                    onClick={onReportBug}
                    className="inline-flex items-center border border-line bg-surface px-4 py-2 font-mono text-xs uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg pointer-coarse:min-h-11"
                  >
                    Report a bug →
                  </button>
                )}
              </div>
            </div>
          </div>
        </header>

        {/* The numbers that back the claims above. Sourced from the same
            TRUST_METRICS the About data contract already pins, so the suite
            sizes cannot drift away from the figures the tests count. */}
        <div className="mt-7 grid grid-cols-2 divide-line border border-line bg-surface sm:grid-cols-4 sm:divide-x">
          {NUMBERS.map((n) => (
            <div key={n.label} className="border-b border-line p-4 last:border-b-0 sm:border-b-0 sm:p-5">
              <div className="text-[clamp(2rem,3.4vw,3rem)] font-bold leading-none tracking-[-0.03em] tabular-nums text-ink">
                {n.value}
              </div>
              <div className="mt-2 font-mono text-[13px] font-semibold uppercase tracking-wider text-ink">
                {n.label}
              </div>
              <div className="mt-1 font-mono text-[12px] leading-snug text-muted">{n.detail}</div>
            </div>
          ))}
        </div>

        {/* Video Field Guide Walkthrough */}
        <VideoShowcase />

        <div className="mt-8 flex gap-10">
          {/* Wide screens only (index.css `.about-rail`, ≥1440px): the chapter
              list moves into the left gutter that was otherwise empty paper,
              and the horizontal bar hides itself. Sticky rather than fixed —
              a fixed rail would ride over the app header, which the field
              guides this is modelled on do not have. */}
          <nav aria-label="Chapters" className="about-rail w-[13rem] flex-none">
            <div className="sticky top-4">
              <div className="border-b-2 border-ink pb-2.5 font-mono text-xs uppercase tracking-[0.2em] text-ink">
                Contents
              </div>
              <ul className="mt-3 space-y-0.5">
                {SECTIONS.map((s, idx) => {
                  const isActive = activeSection === s.id
                  return (
                    <li key={s.id}>
                      <a
                        href={`#${s.id}`}
                        aria-current={isActive ? 'location' : undefined}
                        onClick={(e) => {
                          e.preventDefault()
                          scrollTo(s.id)
                        }}
                        className={`block border-l-2 py-1.5 pl-3 font-mono text-[13px] leading-snug transition-colors ${
                          isActive
                            ? 'border-l-live font-semibold text-ink'
                            : 'border-l-transparent text-muted hover:text-ink'
                        }`}
                      >
                        <span className={isActive ? 'text-live' : 'text-muted/60'}>
                          {String(idx + 1).padStart(2, '0')}{' '}
                        </span>
                        {s.title}
                      </a>
                    </li>
                  )
                })}
              </ul>
            </div>
          </nav>

          <article className="min-w-0 flex-1">
            {/* The chapter bar below the rail breakpoint: one scrolling row
                with a faded right edge (index.css `.about-toc-strip`), so the
                chapters past the fold advertise themselves instead of wrapping
                into three rows that eat the screen. */}
            <nav
              ref={tocRef}
              aria-label="Chapters"
              className="about-toc -mx-4 border-y border-line px-4 py-2.5 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
            >
              <div ref={stripRef} className="about-toc-strip">
                {SECTIONS.map((s, idx) => {
                  const isActive = activeSection === s.id
                  return (
                    <a
                      key={s.id}
                      href={`#${s.id}`}
                      aria-current={isActive ? 'location' : undefined}
                      onClick={(e) => {
                        e.preventDefault()
                        scrollTo(s.id)
                      }}
                      className={`flex-none border px-3.5 py-1.5 font-mono text-[13px] uppercase tracking-wider whitespace-nowrap transition-colors ${
                        isActive
                          ? 'border-ink bg-ink font-medium text-bg'
                          : 'border-line bg-surface text-muted hover:border-ink hover:text-ink'
                      }`}
                    >
                      <span className={isActive ? 'text-bg/70' : 'text-muted/60'}>
                        {String(idx + 1).padStart(2, '0')}{' '}
                      </span>
                      {s.title}
                    </a>
                  )
                })}
              </div>
            </nav>

            {/* Why not a human board */}
            <section id="rationale" className="mt-12 scroll-mt-8">
              <Kicker>Why not a human board</Kicker>
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {WHY_CARDS.map((c) => (
                  <article key={c.title} className="border border-line bg-surface p-4 flex flex-col justify-between">
                    <div>
                      <h3 className="text-[17px] font-semibold text-ink">{c.title}</h3>
                      <p className="mt-2 text-[15.5px] leading-relaxed text-muted">{c.body}</p>
                    </div>
                    <p className="mt-4 border-t border-line/60 pt-2 break-words font-mono text-xs leading-snug text-live [overflow-wrap:anywhere]">
                      {c.mechanism}
                    </p>
                  </article>
                ))}
              </div>
            </section>

            {/* The thirteen chapters */}
            {CHAPTERS.map((chapter) => (
              <section
                key={chapter.id}
                id={chapter.id}
                className="mt-14 scroll-mt-20"
              >
                <ChapterBody chapter={chapter} />
              </section>
            ))}

            {/* Back matter — the pinned reference blocks */}
            <section id="reference" className="mt-14 scroll-mt-8 border-t-2 border-ink pt-8">
              <Kicker className="text-live">Architecture &amp; code flow</Kicker>
              <h2 className="mt-2 font-serif text-2xl sm:text-3xl text-ink">Reference &amp; plates</h2>

              <h3 className="mt-8 font-serif text-xl sm:text-2xl text-ink">The stack, in one table</h3>
              <div className="mt-3.5 border border-line bg-surface sm:table sm:w-full sm:border-collapse">
                <div className="hidden border-b border-line sm:table-header-group">
                  <div className="sm:table-row">
                    {['Layer', 'Choice', 'Why', 'Location'].map((h) => (
                      <div
                        key={h}
                        className="px-4 py-2.5 text-left font-mono text-xs uppercase tracking-wider text-muted sm:table-cell"
                      >
                        {h}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="sm:table-row-group">
                  {STACK_ROWS.map((r) => (
                    <div
                      key={r.layer}
                      className="border-b border-line px-4 py-3 last:border-0 sm:table-row sm:px-0 sm:py-0"
                    >
                      <div className="font-mono text-xs uppercase tracking-wider text-muted sm:hidden">
                        Layer
                      </div>
                      <div className="text-[15px] font-semibold text-ink sm:table-cell sm:px-4 sm:py-2.5 sm:align-top">
                        {r.layer}
                      </div>
                      <div className="mt-1 text-[15.5px] font-medium text-ink sm:table-cell sm:px-4 sm:py-2.5 sm:align-top">
                        <FieldLabel>Choice</FieldLabel>
                        {r.choice}
                      </div>
                      <div className="mt-1 text-sm leading-relaxed text-muted sm:table-cell sm:px-4 sm:py-2.5 sm:align-top">
                        <FieldLabel>Why</FieldLabel>
                        {r.why}
                      </div>
                      <div className="mt-1 break-words font-mono text-xs sm:text-[12.5px] text-muted sm:table-cell sm:px-4 sm:py-2.5 sm:align-top sm:whitespace-nowrap">
                        <FieldLabel>Location</FieldLabel>
                        {r.location}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <h3 className="mt-10 font-serif text-xl sm:text-2xl text-ink">Capability index</h3>
              <section id="strict-engine" className="mt-3.5 scroll-mt-8">
                <div className="border border-line bg-surface divide-y divide-line">
                  {CAPABILITIES.map((c) => (
                    <div
                      key={c.name}
                      className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                    >
                      <span className="text-[15px] font-medium text-ink">{c.name}</span>
                      <span className="font-mono text-xs sm:text-[12.5px] text-muted sm:text-right [overflow-wrap:anywhere]">
                        {c.code}
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              <h3 className="mt-10 font-serif text-xl sm:text-2xl text-ink">Plates</h3>
              <div className="mt-3.5 space-y-6">
                {TOUR_SHOTS.map((s) => (
                  <figure key={s.src}>
                    <img
                      src={s.src}
                      alt={s.alt}
                      loading="lazy"
                      className="w-full border border-line bg-surface"
                    />
                    <figcaption className="mt-2.5 text-[13px] leading-relaxed text-muted">
                      {s.caption}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>

            {/* Bundled orchestrator skill */}
            <section id="orchestrator-skill" className="mt-14 scroll-mt-8 border-l-2 border-live pl-4">
              <h2 className="font-mono text-xs uppercase tracking-widest text-live">
                Bundled orchestrator skill
              </h2>
              <h3 className="mt-3 font-serif text-xl sm:text-2xl text-ink">
                The protocol that drives the board, shipped with it
              </h3>
              <p className="mt-3 max-w-3xl text-[15px] sm:text-base leading-relaxed text-muted">
                {ORCHESTRATOR_SKILL.summary}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2.5">
                <Cta href={ORCHESTRATOR_SKILL.hubUrl ?? SKILL_HUB_URL}>
                  Download from Skills Hub ↗
                </Cta>
                <Cta href={SKILL_STANDALONE_REPO_URL}>Standalone repo ↗</Cta>
              </div>
              <div className="mt-4 border border-line bg-surface p-4">
                <div className="flex items-center justify-between font-mono text-xs uppercase tracking-wider text-muted">
                  <span>Skill file</span>
                  <a
                    href={ORCHESTRATOR_SKILL.hubUrl ?? SKILL_HUB_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-live hover:underline"
                  >
                    Skills Hub ↗
                  </a>
                </div>
                <code className="mt-2 block break-all font-mono text-[13px] text-ink">
                  {ORCHESTRATOR_SKILL.path}
                </code>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="min-w-0 border border-line bg-surface p-4">
                  <div className="font-mono text-xs uppercase tracking-wider text-muted">
                    Install
                  </div>
                  <pre className="mt-2 overflow-x-auto font-mono text-[13px] leading-relaxed text-ink">
                    {ORCHESTRATOR_SKILL.install.join('\n')}
                  </pre>
                </div>
                <div className="min-w-0 border border-line bg-surface p-4">
                  <div className="font-mono text-xs uppercase tracking-wider text-muted">
                    Enforces
                  </div>
                  <ul className="mt-2 space-y-2">
                    {ORCHESTRATOR_SKILL.notes.map((n) => (
                      <li key={n} className="text-sm leading-relaxed text-muted">
                        {n}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>

            <section className="mt-14 border-t border-line pt-8">
              <h2 className="font-serif text-xl sm:text-2xl text-ink">
                Use it for your swarm. Improve it for everyone else.
              </h2>
              <div className="mt-4 flex flex-wrap items-center gap-2.5">
                <Cta href={ABOUT_GITHUB_URL}>Download · fork · contribute</Cta>
                <Cta href={ABOUT_LIVE_URL}>Open live demo</Cta>
              </div>
              <p className="mt-5 font-mono text-xs leading-relaxed text-muted">
                Local-first · headless-first · no accounts · no tracking ·{' '}
                <a
                  href={ABOUT_GITHUB_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {ABOUT_GITHUB_URL}
                </a>
              </p>
              <p className="mt-1.5 font-mono text-xs text-muted">
                {TRUST_METRICS.map((m) => `${m.value} ${m.label}`).join(' · ')}
              </p>
              {visitCount !== null && (
                <p
                  className="mt-1.5 font-mono text-xs tabular-nums text-muted"
                  title={visitCounted ? 'This visit was counted' : 'Visit count so far'}
                >
                  {formatVisitCount(visitCount)}
                  <span className="text-muted/70"> · one anonymous counter, no per-visitor data</span>
                </p>
              )}
            </section>
          </article>
        </div>
      </div>

      {/* Floating return-to-top, shown once the hero is well out of view. The
          field guides this is modelled on give it a pill and a drop shadow;
          both are off-system here (DESIGN.md §7), so it is the same hairline
          square as every other control. It sits above the phone layout's
          floating toolbar clearance so the two never overlap. */}
      {(showTop || backTo) && (
        <div className="fixed right-4 bottom-4 z-30 flex items-center gap-2 max-md:pointer-coarse:bottom-[calc(5.5rem+env(safe-area-inset-bottom,0px))]">
          {backTo && (
            <button
              type="button"
              onClick={goBack}
              className="max-w-[min(62vw,22rem)] truncate border border-line bg-surface px-3.5 py-2 font-mono text-[13px] text-ink transition-colors hover:bg-muted-bg pointer-coarse:min-h-11"
            >
              ← Back to {backTo.label}
            </button>
          )}
          {showTop && (
            <button
              type="button"
              onClick={scrollToTop}
              className="border border-line bg-surface px-3.5 py-2 font-mono text-[13px] uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg pointer-coarse:min-h-11"
            >
              ↑ Top
            </button>
          )}
        </div>
      )}
    </div>
  )
}
