# Design System & Layout Handover: Multi-Column Documentation Layout

> **Target Site**: `https://riazrahaman.com`  
> **Source Reference**: `https://agent-kanban.riazrahaman.com` ([`client/src/components/About.tsx`](file:///Users/riazrahaman/Documents/agend-grid/agent-kanban-board/client/src/components/About.tsx) and [`client/src/index.css`](file:///Users/riazrahaman/Documents/agend-grid/agent-kanban-board/client/src/index.css))  
> **Purpose**: Complete design system, tokens, component blueprints, and layout contracts to replicate the 3-column layout on wide screens with flawless mobile degradation.

---

## 1. Architectural Philosophy: The "Editorial Blueprint"

The design bridges **technical precision** (monospace labels, hairline grids, system telemetry) with **editorial elegance** (warm paper / blueprint surfaces, serif display headers, balanced line lengths).

### Core Rules & Invariants
1. **Hairlines over Shadows**: Absolutely **no box shadows** (`shadow-*` is strictly forbidden). Visual elevation is communicated purely via 1px hairline borders (`border border-line`) against subtle surface contrast (`bg-surface` on `bg-bg`).
2. **Sharp / Minimal Geometry**: No rounded-full / pill buttons (`rounded-full` is strictly forbidden). Buttons and cards are sharp or have standard rectangular edges (`rounded-none` / minimal).
3. **Controlled Reading Measure**: Even on 4K or 34" ultrawide displays, the primary body prose is **never allowed to stretch beyond `max-w-3xl` (~768px)**. This maintains a comfortable 65–80 character measure.
4. **Adaptive Space Utilization**: Wide display real estate is occupied by contextual rails (Table of Contents on the left, specs/actions on the right) rather than blowing out text width.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                     Top Navigation                                     │
├───────────────────────┬────────────────────────────────────────┬───────────────────────┤
│ Left Rail (Sticky)    │ Center Column (Max 768px)              │ Right Rail (Sticky)   │
│ `w-52` / `w-56`       │ `min-w-0 max-w-3xl flex-1`             │ `w-64` / `w-72`       │
│                       │                                        │                       │
│ • "ON THIS PAGE"      │ • Editorial Display H1                 │ • Quick Action Links  │
│ • Smooth Jump Links   │ • Monospace Subtitle                   │ • Architecture Specs  │
│ • Active Highlight    │ • Code Blocks (`overflow-x-auto`)      │ • Copyable CLI One-   │
│   (Intersection-      │ • Responsive Stack Tables              │   Liner with Feedback │
│   Observer)           │ • 2/4-Col Stat Cards                   │ • Telemetry / Live    │
│ • Version/Meta Badge  │ • FAQ Accordions                       │   Status Indicator    │
│                       │                                        │                       │
│ (Hidden < 1024px)     │ (100% width on mobile)                 │ (Hidden < 1280px)     │
└───────────────────────┴────────────────────────────────────────┴───────────────────────┘
```

---

## 2. Design Tokens & Color Palette

The interface supports two palettes: **Warm Paper** (light mode) and **Midnight-Navy Blueprint** (dark mode).

```css
:root {
  /* Warm Paper Palette (Light Mode) */
  --bg: #f6f2e8;        /* Warm cream background (14.73:1 contrast against ink) */
  --surface: #fdfbf5;   /* Barely lifted paper card surface */
  --line: #e6dfd0;      /* Warm hairline border */
  --ink: #211f1a;       /* Warm near-black text */
  --muted: #6e6857;     /* Warm muted grey */
  --muted-bg: #efe9db;  /* Soft hover background */
  --live: #1F5673;      /* Deep slate-teal active accent */
  --live-bg: #e4ecf0;   /* Muted teal badge background */
}

.dark {
  /* Midnight-Navy Blueprint Palette (Dark Mode) */
  --bg: #0c1017;        /* Midnight navy background */
  --surface: #121820;   /* Deep slate-navy card surface */
  --line: #222c38;      /* Blueprint grid border */
  --ink: #e6edf3;       /* Crisp high-contrast foreground text */
  --muted: #8b949e;     /* Cool silver secondary text */
  --muted-bg: #1c2430;  /* Slate hover / code block background */
  --live: #388bfd;      /* Electric blueprint blue active accent */
  --live-bg: #152238;   /* Translucent accent surface */
}
```

### Tailwind v4 / Theme Configuration

```css
@theme {
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-line: var(--line);
  --color-ink: var(--ink);
  --color-muted: var(--muted);
  --color-muted-bg: var(--muted-bg);
  --color-live: var(--live);
  --color-live-bg: var(--live-bg);

  --font-sans: system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  --font-serif: 'Instrument Serif', Georgia, 'Times New Roman', serif;
}
```

---

## 3. Typography Stack & Hierarchy

| Role | Font Family | Tailwind Classes | Sample Usage |
| :--- | :--- | :--- | :--- |
| **Headline H1** | Serif Display | `font-serif text-3xl sm:text-4xl leading-tight text-ink` | Page title / Hero statement |
| **Section H2** | Serif Display | `font-serif text-xl text-ink` | Major section headers |
| **Sub-section H3**| Serif Display | `font-serif text-lg text-ink` | Subsection titles |
| **Overline Label**| Monospace | `font-mono text-[10px] or text-[11px] uppercase tracking-widest text-muted` | Category badges, section eyebrows ("ON THIS PAGE", "QUICK LINKS") |
| **Body Prose** | System Sans | `text-sm leading-relaxed text-muted` | Narrative paragraphs, descriptions |
| **Code / Data** | Monospace | `font-mono text-[10px] or text-[11px] text-ink leading-relaxed` | CLI commands, API paths, specs |
| **Numeric Stats** | Monospace | `font-mono text-2xl tabular-nums text-ink` | Metric card counts, KPIs |

---

## 4. Full Component Architecture (React + Tailwind)

Below is the standard reference implementation of the multi-column documentation layout:

```tsx
import { useEffect, useState } from 'react'

interface TocSection {
  id: string
  title: string
}

const SECTIONS: TocSection[] = [
  { id: 'overview', title: 'Overview' },
  { id: 'experience', title: 'Experience & Work' },
  { id: 'projects', title: 'Projects & Systems' },
  { id: 'architecture', title: 'Technical Stack' },
  { id: 'writing', title: 'Essays & Notes' },
  { id: 'contact', title: 'Get In Touch' },
]

export default function DocumentLayout() {
  const [activeSection, setActiveSection] = useState<string>('overview')
  const [copied, setCopied] = useState<boolean>(false)

  // 1. Scroll-Spy via IntersectionObserver
  useEffect(() => {
    const ids = SECTIONS.map((s) => s.id)
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter(Boolean) as HTMLElement[]

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

  // 2. Smooth Scroll Anchor Handler
  const scrollTo = (id: string) => {
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' })
      setActiveSection(id)
    }
  }

  // 3. Quick Copy Helper
  const copySnippet = (text: string) => {
    if (navigator?.clipboard) {
      navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="h-full min-w-0 flex-1 overflow-y-auto">
      {/* Outer Viewport Wrapper: max-w-[1536px] ensures clean margins on ultrawides */}
      <div className="mx-auto w-full max-w-[1536px] px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex justify-center gap-8 xl:gap-12">
          
          {/* ========================================================= */}
          {/* LEFT RAIL: Sticky Table of Contents (>= 1024px)           */}
          {/* ========================================================= */}
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

              {/* Auxiliary Metadata in Left Sidebar */}
              <div className="border-t border-line pt-4 font-mono text-[10px] text-muted">
                Status: <span className="text-ink">Available for Advisory</span>
              </div>
            </div>
          </aside>

          {/* ========================================================= */}
          {/* CENTER COLUMN: Primary Reading Article                    */}
          {/* ========================================================= */}
          <article className="min-w-0 max-w-3xl flex-1">
            {/* Header / Hero Section */}
            <header id="overview" className="scroll-mt-8">
              <p className="font-mono text-[11px] uppercase tracking-widest text-muted">
                Engineering · Distributed Systems · Agent Architecture
              </p>
              <h1 className="mt-3 font-serif text-3xl leading-tight text-ink sm:text-4xl">
                Riaz Rahaman
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
                Senior systems and frontend architect. Specializing in autonomous agent orchestrators,
                local-first data infrastructure, and strict state machines.
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <a
                  href="https://github.com/riazrahaman"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center border border-line bg-surface px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg"
                >
                  GitHub ↗
                </a>
                <a
                  href="mailto:contact@riazrahaman.com"
                  className="inline-flex items-center border border-line bg-surface px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg"
                >
                  Email ↗
                </a>
              </div>
            </header>

            {/* Code / Highlight Section */}
            <section id="experience" className="mt-10 scroll-mt-8">
              <h2 className="font-mono text-[11px] uppercase tracking-widest text-muted">
                Core Philosophy
              </h2>
              <pre className="mt-3 overflow-x-auto border border-line bg-surface p-3 font-mono text-[11px] leading-relaxed text-ink">
{`# Deterministic agent coordination over plain HTTP
curl -s -X POST "https://agent-kanban.riazrahaman.com/api/tasks/next-claim" \\
  -H "X-Agent-Role: builder"`}
              </pre>
            </section>

            {/* Metric / Stat Tiles Grid */}
            <section id="projects" className="mt-10 scroll-mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { val: '12+', label: 'Years Arch', sub: 'Distributed & Web' },
                { val: '300+', label: 'Agent Tasks', sub: 'Live Swarm Board' },
                { val: '146', label: 'Suite Tests', sub: 'Zero Tolerance Fail' },
                { val: '0', label: 'Cloud DB Lockin', sub: 'Local-First Engine' },
              ].map((m) => (
                <div key={m.label} className="border border-line bg-surface p-3 text-center">
                  <div className="font-mono text-2xl tabular-nums text-ink">{m.val}</div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted">
                    {m.label}
                  </div>
                  <div className="mt-2 text-[11px] leading-snug text-muted">{m.sub}</div>
                </div>
              ))}
            </section>

            {/* Technical Stack / Specification Table (Mobile-Responsive Card Pattern) */}
            <section id="architecture" className="mt-12 scroll-mt-8 border-l-2 border-live pl-4">
              <h2 className="font-serif text-xl text-ink">Technical Stack</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Preferred technologies designed for durability, observability, and deterministic performance.
              </p>

              <div className="mt-4 border border-line bg-surface sm:table sm:w-full sm:border-collapse">
                <div className="hidden border-b border-line sm:table-header-group">
                  <div className="sm:table-row">
                    {['Layer', 'Choice', 'Reasoning'].map((h) => (
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
                  {[
                    { layer: 'Frontend', choice: 'React 19 / Vite / Tailwind v4', why: 'Observability viewport, high frame-rate SSE updates' },
                    { layer: 'Backend', choice: 'Node.js / Express (ESM)', why: 'Deterministic mutation lock with persistent promise queues' },
                    { layer: 'Storage', choice: 'Atomic JSON + Git YAML', why: 'Auditability and local-first zero cloud vendor dependency' },
                  ].map((r) => (
                    <div
                      key={r.layer}
                      className="border-b border-line px-3 py-2.5 last:border-0 sm:table-row sm:px-0 sm:py-0"
                    >
                      <div className="font-mono text-[10px] uppercase tracking-wider text-muted sm:hidden">
                        Layer
                      </div>
                      <div className="text-sm font-medium text-ink sm:table-cell sm:px-3 sm:py-2 sm:align-top">
                        {r.layer}
                      </div>
                      <div className="mt-1 text-sm text-ink sm:table-cell sm:px-3 sm:py-2 sm:align-top">
                        <span className="block font-mono text-[9px] uppercase tracking-wider text-muted sm:hidden">Choice</span>
                        {r.choice}
                      </div>
                      <div className="mt-1 text-xs leading-snug text-muted sm:table-cell sm:px-3 sm:py-2 sm:align-top sm:text-sm sm:leading-relaxed">
                        <span className="block font-mono text-[9px] uppercase tracking-wider text-muted sm:hidden">Why</span>
                        {r.why}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Footer */}
            <footer className="mt-16 border-t border-line pt-6 font-mono text-[10px] text-muted">
              <div>Local-first · Built with React &amp; Tailwind · riazrahaman.com</div>
            </footer>
          </article>

          {/* ========================================================= */}
          {/* RIGHT RAIL: Sticky Action & Spec Cards (>= 1280px)        */}
          {/* ========================================================= */}
          <aside className="hidden w-64 shrink-0 xl:block 2xl:w-72">
            <div className="sticky top-8 space-y-4">
              {/* Quick Links Card */}
              <div className="border border-line bg-surface p-4">
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
                  Quick Links
                </div>
                <div className="mt-3 flex flex-col gap-2">
                  <a
                    href="https://agent-kanban.riazrahaman.com"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex w-full items-center justify-center border border-line bg-surface px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg"
                  >
                    Live Kanban Swarm ↗
                  </a>
                  <a
                    href="https://github.com/riazrahaman"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex w-full items-center justify-center border border-line bg-surface px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-muted-bg"
                  >
                    GitHub Profile ↗
                  </a>
                </div>
              </div>

              {/* Quick Spec Card */}
              <div className="border border-line bg-surface p-4">
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
                  System Specifications
                </div>
                <dl className="mt-3 space-y-2 font-mono text-[11px]">
                  <div className="flex justify-between border-b border-line pb-1.5">
                    <dt className="text-muted">Transport</dt>
                    <dd className="text-ink">HTTP + SSE</dd>
                  </div>
                  <div className="flex justify-between border-b border-line pb-1.5">
                    <dt className="text-muted">Concurrency</dt>
                    <dd className="text-ink">Mutex + CAS</dd>
                  </div>
                  <div className="flex justify-between border-b border-line pb-1.5">
                    <dt className="text-muted">State Machine</dt>
                    <dd className="text-ink">RBAC Strict</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted">Persistence</dt>
                    <dd className="text-ink">Git / Atomic JSON</dd>
                  </div>
                </dl>
              </div>

              {/* Copyable Action Card */}
              <div className="border border-line bg-surface p-4">
                <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-muted">
                  <span>Contact Handshake</span>
                  <button
                    type="button"
                    onClick={() => copySnippet('riaz@riazrahaman.com')}
                    className="text-live hover:underline"
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <pre className="mt-2 overflow-x-auto border border-line bg-muted-bg/30 p-2 font-mono text-[10px] text-ink">
                  riaz@riazrahaman.com
                </pre>
              </div>
            </div>
          </aside>

        </div>
      </div>
    </div>
  )
}
```

---

## 5. Responsive Behavior Matrix

| Viewport | Screen Width | Left TOC Rail | Center Column | Right Spec Rail | Layout Style |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Mobile** | `< 640px` | Hidden (`hidden`) | `100%` width, `px-4` | Hidden (`hidden`) | Single-column, stacked cards |
| **Tablet** | `640px – 1023px` | Hidden (`hidden`) | `max-w-3xl`, centered | Hidden (`hidden`) | Single-column, grid 2/4 cards |
| **Laptop / Desktop** | `1024px – 1279px` | Visible (`lg:block w-52`) | `max-w-3xl flex-1` | Hidden (`hidden`) | 2-Column: Left TOC + Content |
| **Wide / Ultrawide** | `≥ 1280px` | Visible (`w-56`) | `max-w-3xl flex-1` | Visible (`xl:block w-64/72`) | Complete 3-Column Documentation |

---

## 6. Implementation Checklist for the Target Site

When implementing this layout on `https://riazrahaman.com`:

1. [ ] **Inject Color Tokens**: Ensure `var(--bg)`, `var(--surface)`, `var(--line)`, `var(--ink)`, `var(--muted)`, `var(--live)` are added to `:root` (light) and `.dark` (midnight blueprint).
2. [ ] **Verify Typography**: Ensure `Instrument Serif` (or Georgia fallback) is loaded for headings, and standard monospace for overlines and data.
3. [ ] **Prevent Horizontal Blowout**: Ensure all `<pre>` blocks have `overflow-x-auto` and tables use responsive card stacking on mobile.
4. [ ] **Set Scroll Padding**: Add `scroll-mt-8` on all section anchors so jumping to a section doesn't clip under sticky headers.
5. [ ] **Enforce Anti-Patterns**: Run a check to guarantee no `shadow-*` or `rounded-full` classes are introduced.
