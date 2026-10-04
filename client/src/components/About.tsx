import { useEffect, useState } from 'react'
import {
  ABOUT_GITHUB_URL,
  ABOUT_LIVE_URL,
  ARCH_INTRO,
  ARCH_LAYERS,
  CAPABILITIES,
  CLAIM_FLOW,
  CURL_SNIPPET,
  FAQ,
  LIFECYCLE_STEPS,
  ORCHESTRATOR_SKILL,
  RECLAIM_FLOW,
  RECLAIM_INTRO,
  SAFETY_FOOTER,
  SAFETY_LAYERS,
  SKILL_HUB_URL,
  SKILL_STANDALONE_REPO_URL,
  STACK_ROWS,
  TRUST_METRICS,
  TOUR_SHOTS,
  WHY_CARDS,
} from '../lib/aboutContent'
import { formatVisitCount } from '../lib/useVisitCount'
import type { VisitState } from '../lib/useVisitCount'

type Props = {
  version: string | null
  visit: VisitState
}

const SECTIONS = [
  { id: 'overview', title: 'Overview' },
  { id: 'headless-first', title: 'Headless-first' },
  { id: 'orchestrator-skill', title: 'Bundled Skill' },
  { id: 'trust-metrics', title: 'Trust Metrics' },
  { id: 'why-cards', title: 'Why Not Human Board' },
  { id: 'lifecycle', title: '60s Lifecycle' },
  { id: 'strict-engine', title: 'Strict Engine' },
  { id: 'architecture', title: 'Architecture & Flow' },
  { id: 'tour', title: 'Workflow Tour' },
  { id: 'faq', title: 'Adoption FAQ' },
]

function Cta({
  href,
  children,
  className = '',
}: {
  href: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex items-center border border-line bg-surface px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg ${className}`}
    >
      {children}
    </a>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="block font-mono text-[9px] uppercase tracking-wider text-muted sm:hidden">
      {children}
    </span>
  )
}

function FlowRow({
  label,
  title,
  detail,
}: {
  label: string
  title: React.ReactNode
  detail: React.ReactNode
}) {
  return (
    <div className="flex gap-3 border-b border-line py-2.5 last:border-0">
      <span className="flex h-7 w-7 flex-none items-center justify-center border border-line bg-surface font-mono text-[11px] text-ink">
        {label}
      </span>
      <div className="min-w-0">
        <div className="text-sm text-ink">{title}</div>
        <div className="mt-0.5 text-xs leading-relaxed text-muted">{detail}</div>
      </div>
    </div>
  )
}

export default function About({ version, visit }: Props) {
  const { count: visitCount, counted: visitCounted } = visit
  const [activeSection, setActiveSection] = useState<string>('overview')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const ids = SECTIONS.map((s) => s.id)
    const elements = ids.map((id) => document.getElementById(id)).filter(Boolean) as HTMLElement[]

    if (elements.length === 0 || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((e) => e.isIntersecting)
        if (visible) {
          setActiveSection(visible.target.id)
        }
      },
      {
        rootMargin: '-10% 0px -70% 0px',
        threshold: 0,
      }
    )

    elements.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  const copyClaim = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(
        'curl -s -X POST "$BOARD/api/tasks/next-claim?agent_id=builder-1" \\\n  -H "Authorization: Bearer $TOKEN" -H "X-Agent-Role: builder"'
      )
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const scrollTo = (id: string) => {
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' })
      setActiveSection(id)
    }
  }

  return (
    <div className="h-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
      <div className="mx-auto w-full max-w-[1536px] px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex justify-start lg:justify-center gap-8 xl:gap-12">
          {/* Left Navigation: Table of Contents */}
          <aside className="hidden w-52 shrink-0 lg:block xl:w-56">
            <div className="sticky top-8 space-y-6">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-widest text-muted">
                  On this page
                </div>
                <nav className="mt-3 space-y-0.5">
                  {SECTIONS.map((s) => {
                    const isActive = activeSection === s.id
                    return (
                      <a
                        key={s.id}
                        href={`#${s.id}`}
                        onClick={(e) => {
                          e.preventDefault()
                          scrollTo(s.id)
                        }}
                        className={`block border-l-2 py-1 pl-3 font-mono text-[11px] transition-colors ${
                          isActive
                            ? 'border-live bg-surface font-medium text-ink'
                            : 'border-transparent text-muted hover:border-line hover:text-ink'
                        }`}
                      >
                        {s.title}
                      </a>
                    )
                  })}
                </nav>
              </div>

              {version && (
                <div className="border-t border-line pt-4 font-mono text-[10px] text-muted">
                  Engine <span className="text-ink">v{version}</span>
                </div>
              )}
            </div>
          </aside>

          {/* Center Main Narrative & Content */}
          <article className="w-full min-w-0 max-w-3xl flex-1">
            <header id="overview" className="scroll-mt-8">
              <p className="font-mono text-[11px] uppercase tracking-widest text-muted">
                A kanban board where the users aren&apos;t human
              </p>
              <h1 className="mt-3 font-serif text-3xl leading-tight text-ink sm:text-4xl">
                A trusted state register for swarms of coding agents.
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
                Agents claim work and advance a strict lifecycle over plain HTTP.
                The server enforces ownership, transitions and roles. Humans get a
                live, auditable view without ever becoming the workflow engine.
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <Cta href={ABOUT_GITHUB_URL}>Download · fork · contribute</Cta>
                <Cta href={ABOUT_LIVE_URL}>Open live demo</Cta>
                {version && (
                  <span className="font-mono text-[11px] text-muted">
                    v{version}
                  </span>
                )}
              </div>
            </header>

            <section id="headless-first" className="mt-10 scroll-mt-8">
              <h2 className="font-mono text-[11px] uppercase tracking-widest text-muted">
                Headless-first
              </h2>
              <pre className="mt-3 overflow-x-auto border border-line bg-surface p-3 font-mono text-[11px] leading-relaxed text-ink">
                {CURL_SNIPPET}
              </pre>
            </section>

            <section id="orchestrator-skill" className="mt-12 scroll-mt-8 border-l-2 border-live pl-4">
              <h2 className="font-mono text-[11px] uppercase tracking-widest text-muted">
                Bundled orchestrator skill
              </h2>
              <h3 className="mt-3 font-serif text-xl text-ink">
                The protocol that drives the board, shipped with it
              </h3>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
                {ORCHESTRATOR_SKILL.summary}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Cta href={ORCHESTRATOR_SKILL.hubUrl ?? SKILL_HUB_URL}>
                  Download from Skills Hub ↗
                </Cta>
                <Cta href={SKILL_STANDALONE_REPO_URL}>
                  Standalone repo ↗
                </Cta>
              </div>
              <div className="mt-4 border border-line bg-surface p-3">
                <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-muted">
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
                <code className="mt-2 block break-all font-mono text-[11px] text-ink">
                  {ORCHESTRATOR_SKILL.path}
                </code>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="min-w-0 border border-line bg-surface p-3">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
                    Install
                  </div>
                  <pre className="mt-2 overflow-x-auto font-mono text-[11px] leading-relaxed text-ink">
                    {ORCHESTRATOR_SKILL.install.join('\n')}
                  </pre>
                </div>
                <div className="min-w-0 border border-line bg-surface p-3">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
                    Enforces
                  </div>
                  <ul className="mt-2 space-y-1.5">
                    {ORCHESTRATOR_SKILL.notes.map((n) => (
                      <li key={n} className="text-xs leading-relaxed text-muted">
                        {n}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>

            <section id="trust-metrics" className="mt-10 scroll-mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {TRUST_METRICS.map((m) => (
                <div
                  key={m.label}
                  className="border border-line bg-surface p-3 text-center"
                >
                  <div className="font-mono text-2xl tabular-nums text-ink">
                    {m.value}
                  </div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted">
                    {m.label}
                  </div>
                  <div className="mt-2 text-[11px] leading-snug text-muted">
                    {m.detail}
                  </div>
                </div>
              ))}
            </section>

            <section id="why-cards" className="mt-12 scroll-mt-8">
              <h2 className="font-serif text-xl text-ink">
                Why a normal human task board is not enough
              </h2>
              <div className="mt-4 space-y-3">
                {WHY_CARDS.map((c) => (
                  <article
                    key={c.title}
                    className="border border-line bg-surface p-4"
                  >
                    <h3 className="text-sm font-medium text-ink">{c.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted">
                      {c.body}
                    </p>
                    <p className="mt-3 break-words font-mono text-[11px] leading-snug text-live [overflow-wrap:anywhere]">
                      {c.mechanism}
                    </p>
                  </article>
                ))}
              </div>
            </section>

            <section id="lifecycle" className="mt-12 scroll-mt-8">
              <h2 className="font-serif text-xl text-ink">
                The lifecycle, in sixty seconds
              </h2>
              <ol className="mt-4 space-y-2">
                {LIFECYCLE_STEPS.map((s) => (
                  <li
                    key={s.status}
                    className="flex flex-wrap items-baseline gap-x-3 border-l-2 border-line pl-3"
                  >
                    <span className="font-mono text-[11px] uppercase tracking-wider text-ink">
                      {s.status}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                      {s.actor}
                    </span>
                    <span className="text-sm text-muted">{s.detail}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-sm leading-relaxed text-muted">
                Illegal moves are rejected with a 409, and a move by the wrong role
                with a 403. Nothing about the flow lives in the client.
              </p>
            </section>

            <section id="strict-engine" className="mt-12 scroll-mt-8">
              <h2 className="font-serif text-xl text-ink">
                Under the UI is a deliberately strict engine
              </h2>
              <div className="mt-4 border border-line bg-surface divide-y divide-line">
                {CAPABILITIES.map((c) => (
                  <div
                    key={c.name}
                    className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                  >
                    <span className="text-sm text-ink">{c.name}</span>
                    <span className="font-mono text-[10px] text-muted sm:text-right [overflow-wrap:anywhere]">
                      {c.code}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section id="architecture" className="mt-12 scroll-mt-8 border-l-2 border-live pl-4">
              <p className="font-mono text-[11px] uppercase tracking-widest text-live">
                Architecture &amp; code flow
              </p>
              <h2 className="mt-2 font-serif text-xl text-ink">
                How it actually works, end to end
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
                {ARCH_INTRO}
              </p>

              <h3 className="mt-8 font-serif text-lg text-ink">
                The stack, in one table
              </h3>
              <div className="mt-3 border border-line bg-surface sm:table sm:w-full sm:border-collapse">
                <div className="hidden border-b border-line sm:table-header-group">
                  <div className="sm:table-row">
                    {['Layer', 'Choice', 'Why', 'Location'].map((h) => (
                      <div
                        key={h}
                        className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-muted sm:table-cell"
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
                      className="border-b border-line px-3 py-2.5 last:border-0 sm:table-row sm:px-0 sm:py-0"
                    >
                      <div className="font-mono text-[10px] uppercase tracking-wider text-muted sm:hidden">
                        Layer
                      </div>
                      <div className="text-sm text-ink sm:table-cell sm:px-3 sm:py-2 sm:align-top">
                        {r.layer}
                      </div>
                      <div className="mt-1 text-sm text-ink sm:table-cell sm:px-3 sm:py-2 sm:align-top">
                        <FieldLabel>Choice</FieldLabel>
                        {r.choice}
                      </div>
                      <div className="mt-1 text-xs leading-snug text-muted sm:table-cell sm:px-3 sm:py-2 sm:align-top sm:text-sm sm:leading-relaxed">
                        <FieldLabel>Why</FieldLabel>
                        {r.why}
                      </div>
                      <div className="mt-1 break-words font-mono text-[10px] text-muted sm:table-cell sm:px-3 sm:py-2 sm:align-top sm:whitespace-nowrap">
                        <FieldLabel>Location</FieldLabel>
                        {r.location}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <h3 className="mt-10 font-serif text-lg text-ink">
                What happens when an agent claims a task
              </h3>
              <div className="mt-3">
                {CLAIM_FLOW.map((s) => (
                  <FlowRow key={s.label} label={s.label} title={s.title} detail={s.detail} />
                ))}
              </div>

              <h3 className="mt-10 font-serif text-lg text-ink">
                Three safety layers around every write
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Each layer answers a different failure — a stale editor, an illegal
                move, a vanished agent.
              </p>
              <div className="mt-3">
                {SAFETY_LAYERS.map((s) => (
                  <FlowRow key={s.label} label={s.label} title={s.name} detail={s.detail} />
                ))}
              </div>
              <p className="mt-3 font-mono text-[11px] leading-relaxed text-live">
                {SAFETY_FOOTER}
              </p>

              <h3 className="mt-10 font-serif text-lg text-ink">
                What happens when an agent disappears
              </h3>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
                {RECLAIM_INTRO}
              </p>
              <div className="mt-3">
                {RECLAIM_FLOW.map((s) => (
                  <FlowRow key={s.label} label={s.label} title={s.title} detail={s.detail} />
                ))}
              </div>

              <h3 className="mt-10 font-serif text-lg text-ink">
                Six layers, top to bottom
              </h3>
              <div className="mt-3">
                {ARCH_LAYERS.map((s) => (
                  <FlowRow key={s.label} label={s.label} title={s.title} detail={s.detail} />
                ))}
              </div>
            </section>

            <section id="tour" className="mt-12 scroll-mt-8">
              <h2 className="font-serif text-xl text-ink">
                Read it as a workflow, not a screenshot gallery
              </h2>
              <div className="mt-4 space-y-6">
                {TOUR_SHOTS.map((s) => (
                  <figure key={s.src}>
                    <img
                      src={s.src}
                      alt={s.alt}
                      loading="lazy"
                      className="w-full border border-line bg-surface"
                    />
                    <figcaption className="mt-2 text-[11px] leading-snug text-muted">
                      {s.caption}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>

            <section id="faq" className="mt-12 scroll-mt-8">
              <h2 className="font-serif text-xl text-ink">Is this for me?</h2>
              <div className="mt-4 space-y-2">
                {FAQ.map((f) => (
                  <details key={f.q} className="border border-line bg-surface p-3">
                    <summary className="cursor-pointer text-sm text-ink">
                      {f.q}
                    </summary>
                    <p className="mt-2 text-sm leading-relaxed text-muted">{f.a}</p>
                  </details>
                ))}
              </div>
            </section>

            <section className="mt-12 border-t border-line pt-6">
              <h2 className="font-serif text-xl text-ink">
                Use it for your swarm. Improve it for everyone else.
              </h2>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Cta href={ABOUT_GITHUB_URL}>Download · fork · contribute</Cta>
                <Cta href={ABOUT_LIVE_URL}>Open live demo</Cta>
              </div>
              <p className="mt-4 font-mono text-[10px] text-muted">
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
              {visitCount !== null && (
                <p
                  className="mt-1 font-mono text-[10px] tabular-nums text-muted"
                  title={visitCounted ? 'This visit was counted' : 'Visit count so far'}
                >
                  {formatVisitCount(visitCount)}
                  <span className="text-muted/70"> · one anonymous counter, no per-visitor data</span>
                </p>
              )}
            </section>
          </article>

          {/* Right Rail: Quick Actions & Protocol Specs */}
          <aside className="hidden w-64 shrink-0 xl:block 2xl:w-72">
            <div className="sticky top-8 space-y-4">
              {/* Quick Links */}
              <div className="border border-line bg-surface p-4">
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
                  Quick Links
                </div>
                <div className="mt-3 flex flex-col gap-2">
                  <Cta href={ABOUT_GITHUB_URL} className="w-full justify-center text-center">
                    GitHub Repository ↗
                  </Cta>
                  <Cta href={ABOUT_LIVE_URL} className="w-full justify-center text-center">
                    Open Live Demo ↗
                  </Cta>
                  <Cta
                    href={ORCHESTRATOR_SKILL.hubUrl ?? SKILL_HUB_URL}
                    className="w-full justify-center text-center"
                  >
                    Skills Hub ↗
                  </Cta>
                  <Cta
                    href={SKILL_STANDALONE_REPO_URL}
                    className="w-full justify-center text-center"
                  >
                    Standalone Repo ↗
                  </Cta>
                </div>
              </div>

              {/* Swarm Protocol Specs */}
              <div className="border border-line bg-surface p-4">
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
                  Protocol Invariants
                </div>
                <dl className="mt-3 space-y-2 font-mono text-[11px]">
                  <div className="flex justify-between border-b border-line pb-1.5">
                    <dt className="text-muted">Transport</dt>
                    <dd className="text-ink">HTTP + SSE</dd>
                  </div>
                  <div className="flex justify-between border-b border-line pb-1.5">
                    <dt className="text-muted">Lease TTL</dt>
                    <dd className="text-ink">5 min (claim)</dd>
                  </div>
                  <div className="flex justify-between border-b border-line pb-1.5">
                    <dt className="text-muted">Concurrency</dt>
                    <dd className="text-ink">Mutex + CAS</dd>
                  </div>
                  <div className="flex justify-between border-b border-line pb-1.5">
                    <dt className="text-muted">Role Auth</dt>
                    <dd className="text-ink">X-Agent-Role</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted">Persistence</dt>
                    <dd className="text-ink">Local Git/JSON</dd>
                  </div>
                </dl>
              </div>

              {/* Headless Quick Copy */}
              <div className="border border-line bg-surface p-4">
                <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-muted">
                  <span>Agent Claim Call</span>
                  <button
                    type="button"
                    onClick={copyClaim}
                    className="text-live hover:underline"
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <pre className="mt-2 overflow-x-auto border border-line bg-muted-bg/30 p-2 font-mono text-[10px] leading-relaxed text-ink">
                  {`curl -s -X POST "$BOARD/api/tasks/next-claim?agent_id=builder-1"`}
                </pre>
              </div>

              {/* Visit Telemetry */}
              {visitCount !== null && (
                <div className="border border-line bg-surface p-4">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
                    Site Traffic
                  </div>
                  <div className="mt-2 font-mono text-xl tabular-nums text-ink">
                    {formatVisitCount(visitCount)}
                  </div>
                  <p className="mt-1 font-mono text-[10px] leading-snug text-muted">
                    Anonymous counter · no per-visitor data
                  </p>
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
