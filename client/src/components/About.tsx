import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ABOUT_GITHUB_URL,
  ABOUT_LIVE_URL,
  ARCH_DIAGRAM,
  ARCH_DIAGRAM_CALLOUTS,
  ARCH_INTRO,
  ARCH_LAYERS,
  ASK_SCOPE_NOTE,
  ASK_UNCONFIGURED_NOTE,
  CAPABILITIES,
  CHAPTERS,
  CLAIM_FLOW,
  CURL_SNIPPET,
  ENV_VARS,
  FAQ,
  FIELD_GUIDE,
  HERO,
  LIFECYCLE_STEPS,
  ORCHESTRATOR_SKILL,
  RECLAIM_FLOW,
  RECLAIM_INTRO,
  SAFETY_FOOTER,
  SAFETY_LAYERS,
  SKILL_HUB_URL,
  SKILL_STANDALONE_REPO_URL,
  STACK_ROWS,
  TOUR_SHOTS,
  TRUST_METRICS,
  WHY_CARDS,
} from '../lib/aboutContent'
import type { Chapter } from '../lib/aboutContent'
import { askQuestion, getAskConfig, readStoredAskPass, writeStoredAskPass, AskError } from '../lib/ask'
import { PHONE_LAYOUT_QUERY } from '../lib/scrollLock'
import { formatVisitCount } from '../lib/useVisitCount'
import type { VisitState } from '../lib/useVisitCount'

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
// Small shared pieces
// ---------------------------------------------------------------------------

function Cta({
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

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="block font-mono text-[12px] uppercase tracking-wider text-muted sm:hidden">
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

function Kicker({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`font-mono text-xs uppercase tracking-[0.2em] ${className || 'text-muted'}`}>
      {children}
    </div>
  )
}

function FileChips({ files }: { files: string[] }) {
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

// ---------------------------------------------------------------------------
// Chapter 9 — the hand-authored architecture diagram
//
// A self-contained inline SVG (no mermaid, no external image, no dependency).
// It reads light and dark because every paint is a theme token: surfaces are
// `var(--color-surface)`, borders `var(--color-line)`, ink/live/muted come from
// `currentColor` and the same variables the Tailwind tokens are built from.
// ---------------------------------------------------------------------------

const DIAGRAM_MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const chipWidth = (label: string) => Math.round(18 + label.length * 6.4)

function DiagramNodeBox({
  x,
  y,
  w,
  h,
  title,
  lines,
}: {
  x: number
  y: number
  w: number
  h: number
  title: string
  lines: string[]
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill="var(--color-surface)" stroke="var(--color-line)" />
      <text
        x={x + 16}
        y={y + 26}
        fontSize={12.5}
        fontWeight={600}
        fill="currentColor"
        fontFamily={DIAGRAM_MONO}
      >
        {title}
      </text>
      {lines.map((line, i) => (
        <text
          key={line}
          x={x + 16}
          y={y + 26 + (i + 1) * 18}
          fontSize={10.5}
          fill="var(--color-muted)"
          fontFamily={DIAGRAM_MONO}
        >
          {line}
        </text>
      ))}
    </g>
  )
}

function DiagramChipRow({
  x,
  y,
  labels,
  gap = 8,
  accent = false,
}: {
  x: number
  y: number
  labels: string[]
  gap?: number
  accent?: boolean
}) {
  let cx = x
  return (
    <g>
      {labels.map((label) => {
        const w = chipWidth(label)
        const chip = (
          <g key={label}>
            <rect x={cx} y={y} width={w} height={24} rx={2} fill="var(--color-surface)" stroke="var(--color-line)" />
            <text
              x={cx + 9}
              y={y + 16}
              fontSize={10}
              fill={accent ? 'var(--color-live)' : 'currentColor'}
              fontFamily={DIAGRAM_MONO}
            >
              {label}
            </text>
          </g>
        )
        cx += w + gap
        return chip
      })}
    </g>
  )
}

function DiagramArrow({ d, live = false, dashed = false }: { d: string; live?: boolean; dashed?: boolean }) {
  return (
    <path
      d={d}
      fill="none"
      stroke={live ? 'var(--color-live)' : 'var(--color-muted)'}
      strokeWidth={1.5}
      strokeDasharray={dashed ? '4 3' : undefined}
      markerEnd={live ? 'url(#arch-arrow-live)' : 'url(#arch-arrow)'}
    />
  )
}

function DiagramLabel({
  x,
  y,
  children,
  live = false,
  anchor = 'start',
  rotate,
}: {
  x: number
  y: number
  children: ReactNode
  live?: boolean
  anchor?: 'start' | 'middle' | 'end'
  rotate?: string
}) {
  return (
    <text
      x={x}
      y={y}
      fontSize={10}
      textAnchor={anchor}
      transform={rotate}
      fill={live ? 'var(--color-live)' : 'var(--color-muted)'}
      fontFamily={DIAGRAM_MONO}
    >
      {children}
    </text>
  )
}

function ArchitectureDiagram() {
  const c = ARCH_DIAGRAM_CALLOUTS
  return (
    <svg
      role="img"
      viewBox="0 0 960 800"
      preserveAspectRatio="xMidYMid meet"
      className="w-full text-ink"
      style={{ minWidth: 720 }}
    >
      <title>{ARCH_DIAGRAM.title}</title>
      <desc>{ARCH_DIAGRAM.desc}</desc>
      <defs>
        <marker id="arch-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--color-muted)" />
        </marker>
        <marker
          id="arch-arrow-live"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0,0 L8,4 L0,8 z" fill="var(--color-live)" />
        </marker>
      </defs>

      {/* Actors */}
      <DiagramNodeBox
        x={16}
        y={12}
        w={430}
        h={76}
        title="HTTP agents — curl / CLI"
        lines={['drives the board over plain REST', 'auth header: x-api-token (or Bearer)']}
      />
      <DiagramNodeBox
        x={470}
        y={12}
        w={430}
        h={76}
        title="Web board — React client"
        lines={['client/src/App.tsx · Board.tsx', 'TaskSheet.tsx · useClaimCoordinator.ts']}
      />

      {/* Transport */}
      <DiagramNodeBox
        x={16}
        y={112}
        w={430}
        h={68}
        title="REST /api/*"
        lines={['Bearer token · per-project scope', 'or x-api-token header']}
      />
      <DiagramNodeBox
        x={470}
        y={112}
        w={430}
        h={68}
        title="SSE  GET /api/events"
        lines={['mode=diff · one long-lived stream', 'auth: ?ticket= — 60 s, single-use']}
      />

      <DiagramArrow d="M231,88 V110" live />
      <DiagramLabel x={240} y={104} live>
        {c.rest}
      </DiagramLabel>
      <DiagramArrow d="M560,88 V100 H380 V110" />
      <DiagramLabel x={470} y={95} anchor="middle">
        claim / heartbeat
      </DiagramLabel>
      <DiagramArrow d="M685,112 V90" live />
      <DiagramLabel x={694} y={104} live>
        {c.sse}
      </DiagramLabel>
      <DiagramArrow d="M800,204 V182" />
      <DiagramLabel x={810} y={196}>
        GET /api/events
      </DiagramLabel>

      {/* Express process */}
      <rect x={16} y={204} width={884} height={246} fill="var(--color-surface)" stroke="var(--color-line)" />
      <text x={32} y={228} fontSize={12.5} fontWeight={600} fill="currentColor" fontFamily={DIAGRAM_MONO}>
        Express process — server/server.js · real mount order
      </text>
      <DiagramLabel x={140} y={254} anchor="end">
        boot
      </DiagramLabel>
      <DiagramChipRow x={152} y={238} gap={10} labels={['CORS', 'express.json', 'trust proxy']} />
      <DiagramLabel x={140} y={290} anchor="end">
        pre-auth
      </DiagramLabel>
      <DiagramChipRow x={152} y={274} gap={10} labels={['/api/auth', '/api/bug-reports', '/api/ask']} />
      <DiagramLabel x={140} y={326} anchor="end">
        guard
      </DiagramLabel>
      <DiagramChipRow
        x={152}
        y={310}
        gap={10}
        labels={['auth middleware · auth.js', 'rate limit · rateLimit.js']}
      />
      <DiagramLabel x={140} y={362} anchor="end">
        routers
      </DiagramLabel>
      <DiagramChipRow
        x={152}
        y={346}
        gap={8}
        labels={['tasks.js', 'agents.js', 'projects.js', 'metrics.js', 'settings.js', 'milestones.js', 'audit.js', 'health.js']}
      />
      <DiagramLabel x={140} y={398} anchor="end">
        stream
      </DiagramLabel>
      <DiagramChipRow x={152} y={382} gap={8} labels={['GET /api/events · SSE · mode=diff']} />
      <DiagramLabel x={476} y={398}>
        one stream per browser
      </DiagramLabel>
      <DiagramLabel x={32} y={434}>
        Every route mounted after the guard carries a valid token and a project scope.
      </DiagramLabel>

      <DiagramArrow d="M231,180 V204" />
      <DiagramLabel x={240} y={196}>
        writes
      </DiagramLabel>

      {/* Core engine */}
      <rect x={16} y={474} width={884} height={160} fill="var(--color-surface)" stroke="var(--color-line)" />
      <text x={32} y={498} fontSize={12.5} fontWeight={600} fill="currentColor" fontFamily={DIAGRAM_MONO}>
        Core engine — server/store.js · one serialized write path
      </text>
      <DiagramLabel x={140} y={524} anchor="end">
        siblings
      </DiagramLabel>
      <DiagramChipRow
        x={152}
        y={508}
        gap={8}
        labels={['state-machine.js · 8 states + canRoleTransition', 'task-fields.js', 'task-identity.js', 'storage.js']}
      />
      <DiagramLabel x={140} y={560} anchor="end">
        calls
      </DiagramLabel>
      <DiagramChipRow
        x={152}
        y={544}
        gap={8}
        accent
        labels={['withMutationLock — every write chained', 'applyClaim — leases & heartbeat', 'reapExpiredClaims — reaper']}
      />
      <DiagramLabel x={152} y={600}>
        write path:  routes → engine → persist-first → memory → notify / SSE
      </DiagramLabel>
      <DiagramArrow d="M760,570 V610" dashed />
      <DiagramLabel x={770} y={600} live>
        {c.reaper}
      </DiagramLabel>

      <DiagramArrow d="M600,450 V474" />
      <DiagramLabel x={610} y={466}>
        every mutation
      </DiagramLabel>

      {/* Persistence + fan-out bus */}
      <rect x={16} y={658} width={430} height={132} fill="var(--color-surface)" stroke="var(--color-line)" />
      <text x={32} y={682} fontSize={12.5} fontWeight={600} fill="currentColor" fontFamily={DIAGRAM_MONO}>
        Persistence — storage.js
      </text>
      <DiagramChipRow x={32} y={690} labels={['JsonStorage']} />
      <DiagramLabel x={132} y={706}>
        atomic temp-file + rename
      </DiagramLabel>
      <DiagramChipRow x={32} y={718} labels={['GitYamlStorage']} />
      <DiagramLabel x={162} y={734}>
        one YAML card / task · one commit / transition
      </DiagramLabel>
      <DiagramLabel x={32} y={772}>
        mounted disk · KANBAN_DATA_DIR
      </DiagramLabel>

      <rect x={470} y={658} width={430} height={132} fill="var(--color-surface)" stroke="var(--color-line)" />
      <text x={486} y={682} fontSize={12.5} fontWeight={600} fill="currentColor" fontFamily={DIAGRAM_MONO}>
        Fan-out bus — store.js listeners
      </text>
      <DiagramLabel x={486} y={706}>
        onDiff · onChange · onAudit
      </DiagramLabel>
      <DiagramChipRow x={486} y={716} gap={8} labels={['SSE → client', 'notifier.js · Telegram', 'webhooks.js']} />
      <DiagramChipRow x={486} y={750} gap={8} labels={['auditLog.js · audit.jsonl']} />

      <DiagramArrow d="M231,634 V658" live />
      <DiagramLabel x={240} y={652} live>
        {c.persist}
      </DiagramLabel>
      <DiagramArrow d="M700,634 V658" />
      <DiagramLabel x={710} y={652}>
        fan-out
      </DiagramLabel>

      {/* Fan-out bus back up into the SSE endpoint. */}
      <DiagramArrow d="M900,706 H924 V146 H902" live />
      <DiagramLabel x={940} y={430} anchor="middle" rotate="rotate(-90 940 430)" live>
        fan-out to SSE
      </DiagramLabel>
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Ask-the-Board — the page's lead feature, rendered in the hero.
//
// It used to sit inside chapter 11, eleven screens down. It is the one thing
// on this page that answers a question the reader actually has, so it now
// opens the guide and chapter 11 keeps only the explanation of how it works.
// ---------------------------------------------------------------------------

type AskConfig = Awaited<ReturnType<typeof getAskConfig>>
type AskState =
  | { phase: 'loading' }
  | { phase: 'off' }
  | { phase: 'ready'; model?: string }

// Kept short on purpose: as full sentences these wrapped the chip row onto
// three lines and pushed the Ask button below the fold.
const SUGGESTED_QUESTIONS = [
  { chip: 'Why claims expire', ask: 'Why do claims expire?' },
  { chip: 'The two 409s', ask: 'What are the two different 409 responses?' },
  { chip: 'The reaper', ask: 'What does the lease reaper do?' },
]

function messageForAskError(err: unknown): string {
  if (err instanceof AskError) {
    if (err.status === 401) return 'Wrong password.'
    if (err.status === 429) return 'Too many attempts — please wait a moment.'
    if (err.status === 502 || err.status === 503) return 'The assistant is temporarily unavailable.'
    if (err.code === 'invalid_question') return 'Ask a question between 3 and 500 characters.'
    return `Something went wrong (${err.status}).`
  }
  return 'The assistant is temporarily unavailable.'
}

function AskCard() {
  const [state, setState] = useState<AskState>({ phase: 'loading' })
  const [password, setPassword] = useState(() => readStoredAskPass())
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [answerModel, setAnswerModel] = useState<string | undefined>(undefined)
  const [fallback, setFallback] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getAskConfig()
      .then((cfg: AskConfig) => {
        if (cancelled) return
        setState(cfg.enabled ? { phase: 'ready', model: cfg.model } : { phase: 'off' })
      })
      .catch(() => {
        if (!cancelled) setState({ phase: 'off' })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onPasswordChange = (value: string) => {
    setPassword(value)
    writeStoredAskPass(value)
  }

  const submit = async () => {
    const q = question.trim()
    if (!q || asking) return
    setAsking(true)
    setError(null)
    setAnswer(null)
    setFallback(false)
    try {
      const res = await askQuestion(q, password)
      setAnswer(res.answer)
      setAnswerModel(res.model)
      setFallback(res.fallback === true)
    } catch (err) {
      setError(messageForAskError(err))
    } finally {
      setAsking(false)
    }
  }

  if (state.phase === 'loading') {
    return (
      <div className="border border-line bg-surface p-4 font-mono text-[13px] text-muted">
        Checking availability…
      </div>
    )
  }

  // Off is the self-hosted default (both secrets unset), so it stays a quiet
  // note rather than a large empty console at the very top of the page.
  if (state.phase === 'off') {
    return (
      <div className="border border-line bg-surface p-4">
        <Kicker>Ask the board · not configured here</Kicker>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">{ASK_UNCONFIGURED_NOTE}</p>
      </div>
    )
  }

  const trimmed = question.trim()
  const questionTooShort = trimmed.length > 0 && trimmed.length < 3

  return (
    <div className="border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-muted-bg/30 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 bg-live" aria-hidden="true" />
          <Kicker>Ask the board</Kicker>
        </div>
        {state.model && (
          <span className="font-mono text-[13px] text-muted">{state.model}</span>
        )}
      </div>

      <div className="p-4 sm:p-5">
        {/* The question leads: it is what the reader came for. The password is
            a gate on the endpoint, so it sits under the button as a condition
            of sending, not as the first thing asked for. */}
        <label className="block">
          <span className="sr-only">Your question about this board</span>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
            }}
            rows={3}
            maxLength={500}
            className="w-full resize-y border border-line bg-bg px-3.5 py-3 text-base leading-relaxed text-ink outline-none focus:border-live"
            placeholder="Ask anything about how this board works — why claims expire, what the reaper does, how a 409 happens…"
          />
        </label>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px] uppercase tracking-wider text-muted">Try</span>
          {SUGGESTED_QUESTIONS.map((sq) => (
            <button
              key={sq.chip}
              type="button"
              onClick={() => setQuestion(sq.ask)}
              className="border border-line bg-muted-bg/50 px-2.5 py-1 font-mono text-[13px] text-muted transition-colors hover:border-ink hover:text-ink pointer-coarse:min-h-11"
            >
              {sq.chip}
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={submit}
            disabled={asking || !trimmed || questionTooShort}
            className="inline-flex items-center border border-ink bg-ink px-5 py-2.5 font-mono text-[13px] font-medium uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:min-h-11"
          >
            {asking ? 'Asking…' : 'Ask →'}
          </button>
          <label className="flex min-w-[13rem] flex-1 items-center gap-2 border border-line bg-bg px-3 py-2">
            <span className="sr-only">Shared access password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent font-mono text-[15px] text-ink outline-none"
              placeholder="access password"
            />
          </label>
          <span className="font-mono text-[13px] tabular-nums text-muted">{trimmed.length}/500</span>
        </div>

        {error && (
          <p className="mt-3.5 border-l-2 border-warn pl-3.5 text-[15px] text-warn">{error}</p>
        )}

        {answer && (
          <div className="mt-5 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Kicker>Answer</Kicker>
              {answerModel && (
                <span className="font-mono text-[13px] text-muted">via {answerModel}</span>
              )}
              {fallback && (
                <span className="border border-warn px-2 py-0.5 font-mono text-[12px] uppercase tracking-wider text-warn">
                  live figures unavailable
                </span>
              )}
            </div>
            <p className="mt-2.5 whitespace-pre-wrap text-[16.5px] leading-relaxed text-ink">{answer}</p>
          </div>
        )}

        <p className="mt-4 border-t border-line/60 pt-3 text-[15.5px] leading-relaxed text-muted">
          {ASK_SCOPE_NOTE}{' '}
          <a href="#ask" className="text-live underline underline-offset-2">
            How it works →
          </a>
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// A single chapter
// ---------------------------------------------------------------------------

function ChapterBody({ chapter }: { chapter: Chapter }) {
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
        <p className="mt-5 border border-line bg-surface p-4 text-[16.5px] leading-relaxed text-muted">
          The console is at the top of this page — it is the first thing in the
          guide rather than the last.{' '}
          <a href="#top" className="font-medium text-live underline underline-offset-2">
            Go and ask it something →
          </a>
        </p>
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

// ---------------------------------------------------------------------------
// About view
// ---------------------------------------------------------------------------

export default function About({ version, visit, bugReportEnabled, onReportBug }: Props) {
  const { count: visitCount, counted: visitCounted } = visit
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0]?.id ?? 'states')
  const [showTop, setShowTop] = useState(false)
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
      setShowTop(
        scroller === window
          ? window.scrollY > 600
          : (scroller as HTMLElement).scrollTop > 600,
      )
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

  const scrollTo = (id: string) => {
    const el = document.getElementById(id)
    if (!el) return
    el.scrollIntoView({ behavior: motion(), block: 'start' })
    setActiveSection(id)
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
      <div className="mx-auto w-full max-w-[1400px] px-4 py-7 sm:px-6 lg:px-8">
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

            {/* The twelve chapters */}
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
      {showTop && (
        <button
          type="button"
          onClick={scrollToTop}
          className="fixed right-4 bottom-4 z-30 border border-line bg-surface px-3.5 py-2 font-mono text-[13px] uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg max-md:pointer-coarse:bottom-[calc(5.5rem+env(safe-area-inset-bottom,0px))] pointer-coarse:min-h-11"
        >
          ↑ Top
        </button>
      )}
    </div>
  )
}
