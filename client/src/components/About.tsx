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
  STACK_ROWS,
  TRUST_METRICS,
  TOUR_SHOTS,
  WHY_CARDS,
} from '../lib/aboutContent'
import { formatVisitCount, useVisitCount } from '../lib/useVisitCount'

type Props = {
  version: string | null
}

function Cta({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center border border-line bg-surface px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg"
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

export default function About({ version }: Props) {
  const { count: visitCount, counted: visitCounted } = useVisitCount()
  return (
    <div className="h-full min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-10">
        <header>
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

        <section className="mt-10">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-muted">
            Headless-first
          </h2>
          <pre className="mt-3 overflow-x-auto border border-line bg-surface p-3 font-mono text-[11px] leading-relaxed text-ink">
            {CURL_SNIPPET}
          </pre>
        </section>

        <section className="mt-12 border-l-2 border-live pl-4">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-muted">
            Bundled orchestrator skill
          </h2>
          <h3 className="mt-3 font-serif text-xl text-ink">
            The protocol that drives the board, shipped with it
          </h3>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            {ORCHESTRATOR_SKILL.summary}
          </p>
          <div className="mt-4 border border-line bg-surface p-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
              Skill file
            </div>
            <code className="mt-2 block font-mono text-[11px] text-ink">
              {ORCHESTRATOR_SKILL.path}
            </code>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="border border-line bg-surface p-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
                Install
              </div>
              <pre className="mt-2 overflow-x-auto font-mono text-[11px] leading-relaxed text-ink">
                {ORCHESTRATOR_SKILL.install.join('\n')}
              </pre>
            </div>
            <div className="border border-line bg-surface p-3">
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

        <section className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
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

        <section className="mt-12">
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
                <p className="mt-3 font-mono text-[11px] leading-snug text-live">
                  {c.mechanism}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-12">
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

        <section className="mt-12">
          <h2 className="font-serif text-xl text-ink">
            Under the UI is a deliberately strict engine
          </h2>
          <div className="mt-4 border border-line bg-surface">
            <table className="w-full text-left">
              <tbody>
                {CAPABILITIES.map((c) => (
                  <tr key={c.name} className="border-b border-line last:border-0">
                    <td className="px-3 py-2 text-sm text-ink">{c.name}</td>
                    <td className="px-3 py-2 text-right font-mono text-[10px] text-muted">
                      {c.code}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-12 border-l-2 border-live pl-4">
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

        <section className="mt-12">
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

        <section className="mt-12">
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
      </div>
    </div>
  )
}
