import type { ReactNode } from 'react'
import { ARCH_DIAGRAM, ARCH_DIAGRAM_CALLOUTS } from '../lib/aboutContent'

/**
 * C1 (v3.12.5) — chapter 9's hand-authored inline SVG architecture diagram,
 * extracted verbatim from components/About.tsx. Every paint is a theme token,
 * so light/dark follow the board; no mermaid, no external image.
 */

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

export function ArchitectureDiagram() {
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
