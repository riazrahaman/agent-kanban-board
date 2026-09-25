# Design System

The visual contract for the Agent Kanban Board. This document is the reference
the code comment in `client/src/lib/responsive.test.mjs` and the guard in
`server/test/kanban.test.js` (`keeps client source on the DESIGN.md visual
contract`) already assume exists.

**Precedence.** The implementation is the source of truth; this document
describes it. If the two ever disagree, the code wins and this file is the bug.
Every token, class, and font stack below is copied from a shipped file — none is
aspirational.

Aesthetic in one line: **editorial-minimalist** — a warm paper ground, hairline
structure, and operational colour used only to encode state.

---

## 1. Principles

1. **Depth from hairlines, never shadows.** Structure is drawn with 1px borders
   in `border-line`. Shadows and heavy gradients are banned (see §12). The only
   gradients in the codebase are the two edge-fade overlays on the board, which
   hint at off-screen columns.
2. **Warm paper, not white.** The light theme is a cream page (`--bg #f6f2e8`),
   chosen to cut glare; surfaces sit barely above it (`--surface #fdfbf5`).
3. **Form *and* colour.** Status is never signalled by hue alone. Every status
   carries a left severity stripe, a text label, and (for review/running) a
   glyph. See §6.
4. **Colour is operational, not decorative.** The accent tokens exist to
   describe task state and nothing else. There is no brand colour used for
   ornament.
5. **Identifiers are monospaced.** Ids, counts, metrics, and timestamps use the
   mono stack with `tabular-nums` so digits do not jitter and columns align.
6. **Square corners.** The UI is rectilinear; no rounded surfaces.

---

## 2. Color System

Tokens are CSS custom properties declared once per theme in
`client/src/index.css` and mapped to Tailwind utilities in
`client/tailwind.config.js`. Components reference the **utility**, never a raw
hex.

### 2.1 Neutral / surface tokens

| Token | Utility | Light (`:root`) | Dark (`.dark`) | Role |
|---|---|---|---|---|
| `--bg` | `bg-bg` | `#f6f2e8` | `#1b211d` | Page ground (warm cream / green-charcoal) |
| `--surface` | `bg-surface` | `#fdfbf5` | `#252d27` | Cards, sheets, header/footer panels |
| `--line` | `border-line` | `#e6dfd0` | `#445047` | The 1px hairline — all structure |
| `--ink` | `text-ink` | `#211f1a` | `#e8ece4` | Primary text (14.73:1 / 13.1:1 on `--bg`) |
| `--muted` | `text-muted` | `#6e6857` | `#b4beaf` | Secondary text (4.97:1 / 8.8:1 on `--bg`) |
| `--muted-bg` | `bg-muted-bg` | `#efe9db` | `rgba(255,255,255,.07)` | Chips, badges, subtle fills |

### 2.2 Scrollbar tokens (board only)

| Token | Light | Dark | Role |
|---|---|---|---|
| `--scroll-track` | `#ece5d6` | `rgba(255,255,255,.07)` | Board scroll track |
| `--scroll-thumb` | `#b8ad95` | `rgba(255,255,255,.30)` | Board scroll thumb |
| `--scroll-thumb-hover` | `#9b8f74` | `rgba(255,255,255,.48)` | Thumb hover |

The board needs a **visible** scrollbar (off-screen columns were undiscoverable);
the global document scrollbar stays a faint `--line` hairline. See §7.3.

### 2.3 Operational tokens

Each pair is `--<name>` (foreground) + `--<name>-bg` (tint). Contrast figures are
the CSS comments' own measurements.

| Token | Utility pair | Light fg | Light bg | Dark fg | Dark bg | Meaning |
|---|---|---|---|---|---|---|
| `--up` / `--up-bg` | `text-up` / `bg-up-bg` | `#346538` | `#e8efe2` | `#8fc79f` | `rgba(120,190,145,.16)` | Healthy / passing |
| `--down` / `--down-bg` | `text-down` / `bg-down-bg` | `#9f2f2d` | `#f9e7e3` | `#e39b96` | `rgba(220,115,110,.17)` | Failing / bad |
| `--pass` | alias of `--up` | — | — | — | — | Passing checks |
| `--fail` | alias of `--down` | — | — | — | — | Failed checks |
| `--warn` / `--warn-bg` | `text-warn` / `bg-warn-bg` | `#8A6A12` | `#f6efdc` | `#ddb45c` | `rgba(221,180,92,.16)` | Attention (4.89:1 light) |
| `--block` / `--block-bg` | `text-block` / `bg-block-bg` | `#4A4D52` | `#ece7db` | `#a6acb5` | `rgba(255,255,255,.07)` | Stalled — grey, deliberately *not* bad (8.20:1 light) |
| `--live` / `--live-bg` | `text-live` / `bg-live-bg` | `#1F5673` | `#e4ecf0` | `#8fbcd6` | `rgba(143,188,214,.16)` | Running now (7.69:1 light) |
| `--test` / `--test-bg` | `text-test` / `bg-test-bg` | `#6B4E9B` | `#ece5f5` | `#b9a3e3` | `rgba(169,138,224,.18)` | Verification stage — violet (6.4:1 light) |

Notes:

- `--pass`/`--pass-bg` and `--fail`/`--fail-bg` are **aliases**: `--pass: var(--up)`,
  `--fail: var(--down)`. Change the up/down pair and pass/fail follow.
- `--block` is intentionally a neutral slate: a blocked card is *stalled*, which
  is not the same as a failing one (which uses `--fail`). The two must stay
  visually distinct.
- `--test` (violet) exists specifically to separate "in verification" from "in
  progress" (`--live`, blue).

### 2.4 Theme declaration

- Each theme sets `color-scheme` (`light` on `:root`, `dark` on `.dark`) so
  native controls — notably the `<select>` option popup — match the page.
- There is deliberately **no `prefers-color-scheme` media block**. Such a block
  would re-apply dark tokens under `:root` regardless of the `.dark` class,
  making a user's explicit "light" choice invisible. The OS preference is
  consulted exactly once, in JS (`lib/theme.ts`), then folded into one class.
- The dark palette is green-tinted to match `riazrahaman.com`, so the two sites
  read as one product family.

---

## 3. Typography

Three stacks, declared in `client/tailwind.config.js` and mirrored in
`client/src/index.css`.

| Role | Utility | Stack |
|---|---|---|
| Body / UI | `font-sans` (default on `body`) | `system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif` |
| Display / titles | `font-serif` | `Instrument Serif, Georgia, Times New Roman, serif` |
| Identifiers / data | `font-mono` | `ui-monospace, SF Mono, JetBrains Mono, Menlo, Consolas, monospace` |

Rules:

- The page title in the header is the only serif display element
  (`whitespace-nowrap font-serif text-base font-normal tracking-tight sm:text-lg`).
- **Mono + `tabular-nums`** is mandatory for anything numeric or machine-owned:
  task ids, agent ids, counts, metrics, timestamps, project slugs. `.tabular-nums`
  is defined in `index.css` (`font-variant-numeric: tabular-nums`).
- **Micro-scale** is monospaced and uppercase with wide tracking. The canonical
  pattern is `font-mono text-[10px] uppercase tracking-[0.12em]` (badges) and
  `tracking-[0.14em]` (section headers). Sub-labels use `text-[9px]`; meta rows
  `text-[11px]`.
- `Inter` and `Roboto` are banned outright (§12).

---

## 4. Geometry & Spacing

| Concern | Rule |
|---|---|
| Hairline | `border border-line` (1px) is the default for every surface |
| Column accent | `border-t-2 border-t-<token>` — the one 2px top rule (§7.2) |
| Severity stripe | `border-l-[3px]` on cards and status badges (§6.2) |
| High-priority edge | `border-r-2 border-r-fail` on the card's right edge only |
| Card padding | `p-3` |
| Column width | `w-[85vw]` on phones, `md:w-72` (18rem) from `md` up |
| Column gap | `gap-4` (1rem); board padding `p-4` |
| Corners | Always square — no border radius utilities anywhere |
| Board pitch | `COLUMN_STEP = 304` px (288px column + 16px gap) for programmatic paging |

Stacked surfaces use low-alpha fills (`bg-surface/40`, `bg-surface/70`) rather
than a border to nest, keeping the hairline budget low.

---

## 5. Layout Shell

```
<div class="flex h-screen flex-col bg-bg text-ink">
  <header class="…border-b border-line bg-surface…">      ← sticky chrome, mono controls
  <main class="flex flex-1 overflow-hidden">
    <Board/>            ← horizontal snap-scroll columns
    <SignalRail/>       ← w-80, border-l; slides over below md
  </main>
</div>
```

- `h-screen` is overridden to `100dvh` under `@supports (height:100dvh)` so
  mobile URL bars don't push the layout off-screen.
- The header is the only place the display serif appears; every control in it is
  mono, uppercase, `text-[11px]`, and hairline-bordered
  (`border border-line bg-surface px-2.5 py-1.5 … hover:bg-muted-bg`).
- The live-connection dot is a `h-2 w-2 bg-live animate-pulse` square (no
  radius), `aria-label="Live connection"`.

---

## 6. Status & Priority Encoding

### 6.1 Canonical statuses

Six canonical values (ADR-001, mirrored in `client/src/lib/status.ts`):

`BACKLOG · BUILDING · IN_REVIEW · IN_TEST · BLOCKED · DONE`

`normalizeStatus` (`client/src/status.js`) maps legacy input:

| Input | Normalized |
|---|---|
| `TODO` | `BACKLOG` |
| `IN_PROGRESS` | `BUILDING` |
| unknown / empty / non-string | `UNKNOWN` |

### 6.2 Status stripe + badge

Every status maps to a **left stripe** and a **badge tint** (`STATUS_STYLES`):

| Status | Stripe | Badge | Accent token |
|---|---|---|---|
| `DONE` | `border-l-pass` | `bg-pass-bg text-pass` | green |
| `IN_TEST` | `border-l-test` | `bg-test-bg text-test` | violet |
| `IN_REVIEW` | `border-l-warn` | `bg-warn-bg text-warn` | amber |
| `BUILDING` | `border-l-live` | `bg-live-bg text-live` | blue |
| `BLOCKED` | `border-l-block` | `bg-block-bg text-block` | slate |
| `BACKLOG` | `border-l-line` | `bg-muted-bg text-muted` | hairline |
| `UNKNOWN` | `border-l-line` | `bg-muted-bg text-muted` | hairline |

`StatusBadge` renders it as
`inline-flex items-center border-l-[3px] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]`,
with an `aria-label="Status: <NORMALIZED>"`.

**Glyphs** (form encoding, so colour is never the only signal):

| Glyph | Appears on | Meaning |
|---|---|---|
| `▲ ` | `IN_REVIEW` badge | awaiting review |
| `• ` | `BUILDING`, `IN_TEST` badge | actively running |

### 6.3 Priority

`normalizePriority` (`client/src/priority.ts`) folds the backend's triage scheme
onto three keys: `high` (incl. `P0-critical`, `P0`, `P1-high`, `P1`), `medium`
(incl. `P2-medium`, `P2`, and the fallback), `low` (incl. `P3-low`, `P3`). An
unmapped priority falls back to `medium` so a render can never throw.

| Priority | Badge class | Card edge |
|---|---|---|
| `high` | `bg-fail-bg text-fail border-fail/40 font-semibold` | `border-r-2 border-r-fail` |
| `medium` | `bg-warn-bg text-warn border-warn/40` | — |
| `low` | `bg-muted-bg text-muted border-line` | — |

### 6.4 Card metadata glyphs

| Glyph | Field | Class |
|---|---|---|
| `◇` | milestone | `border-live bg-live-bg text-live` |
| `⚡` | estimate / points / size | `border-line bg-muted-bg text-muted` |

---

## 7. Component Vocabulary

### 7.1 Task card (`components/TaskCard.tsx`)

`group cursor-pointer border border-line bg-surface p-3 transition-colors hover:bg-muted-bg/50 border-l-[3px] <stripe>`
(plus `border-r-2 border-r-fail` when high priority).

- Header row: id (`min-w-0 flex-1 truncate font-mono text-xs tabular-nums tracking-wider`,
  full value in `title`) then a badge group pinned to the right. On phones the
  badge group takes its own full-width line (`w-full sm:w-auto`) so the id owns
  the row.
- Title: `text-sm font-medium leading-snug text-ink break-words`; double-click to
  edit in place.
- Footer: `border-t border-line/60 pt-2`, assigned agent in mono (`unassigned` is
  `text-muted/60 italic`), issues chip in `bg-warn-bg text-warn`.
- Memoised by `id + version` (a version bump is a content change).

### 7.2 Column (`components/Column.tsx`, `components/Board.tsx`)

`flex w-[85vw] shrink-0 snap-start flex-col border border-line bg-surface/40 md:w-72 <topAccent>`

- Top accent: `border-t-2 border-t-<token>`. The stock map (`COLUMN_ACCENTS`) is
  `BACKLOG muted/40 · BUILDING live · IN_REVIEW warn · IN_TEST test · BLOCKED fail ·
  DONE pass · UNKNOWN line · ISSUES warn`.
- Per-project overrides (`lib/columnColors.ts`) replace the accent only; the
  eight selectable tokens are `muted · live · warn · test · fail · pass · block ·
  line`, each with a **literal** Tailwind class (the JIT scanner requires literal
  strings — never interpolate a border class).
- Header: optional step chip (`01`…`04`, mono `text-[10px]`), title
  (`font-mono text-xs font-semibold uppercase tracking-wider`), and a count chip
  that turns `bg-fail-bg text-fail border-fail/40 font-bold` when a BLOCKED
  column is non-empty.
- `DONE` columns render at `opacity-70`.
- The 8 board columns are ordered: Backlog, Building, In Review, In Test,
  Blocked, Done, Unknown, Issues.

### 7.3 Board scroll (`components/Board.tsx`)

`board-scroll flex h-full w-full snap-x scroll-pl-4 gap-4 overflow-x-auto p-4`.

- `.board-scroll` gives it a visible 12px scrollbar plus a `‹`/`›` button pair
  (`hidden … md:flex`) because a trackpad-less mouse can't drag it.
- Edge-fade overlays (`bg-gradient-to-r/l from-bg to-transparent`, `w-10`,
  `pointer-events-none`) indicate overflow. These two are the only gradients.

### 7.4 Signal Rail (`components/SignalRail.tsx`)

`<aside class="flex w-80 shrink-0 flex-col border-l border-line bg-surface/40">`

- "Signal Overview" rollup: three `border border-line bg-surface p-2.5 text-center`
  cells (Active / Blocked / Done); Blocked flips to `border-fail bg-fail-bg`.
- "Activity" feed: most recent 20 log entries, `divide-y divide-line/40`; each row
  is a button with a mono agent chip, the message, and a relative timestamp.
- Below `md` it becomes a right-anchored slide-over drawer.

### 7.5 Metrics dashboard (`components/MetricsDashboard.tsx`)

`border-b border-line bg-surface/70 px-3 py-2.5 backdrop-blur-sm animate-fadeIn`;
cards in a `grid-cols-2 sm:grid-cols-4 md:grid-cols-7` grid, each
`border border-line bg-surface p-2 text-center` with a `text-lg tabular-nums`
value over a `text-[9px] uppercase tracking-wider` label. Blocked / Overdue cards
escalate to `border-fail bg-fail-bg` / `border-warn bg-warn-bg` when non-zero.

### 7.6 About (`components/About.tsx`)

Data-driven from `lib/aboutContent.ts` (`TRUST_METRICS`, `TOUR_SHOTS`,
`ARCH_LAYERS`, `CLAIM_FLOW`, `SAFETY_LAYERS`, `RECLAIM_FLOW`, `STACK_ROWS`,
`CAPABILITIES`, `LIFECYCLE_STEPS`, `FAQ`, `CURL_SNIPPET`). Rows use hairline
dividers (`border-b border-line py-2.5 last:border-0`); step markers are
`flex h-7 w-7 … border border-line bg-surface font-mono text-[11px]`. Counts
(`TRUST_METRICS`) must be refreshed when the test suites change size.

---

## 8. Theming

- Class-based (`tailwind.config.js` → `darkMode: 'class'`); `.dark` on the root
  swaps every token.
- Resolution is pure and lives in `client/src/lib/theme.ts`:
  `resolveTheme(stored, prefersDark)` → an explicit stored `'light' | 'dark'`
  always wins; otherwise the OS preference is used. Storage key: `theme`.
- The toggle calls `nextTheme(current)`. `theme.test.mjs` (5 tests) locks the
  precedence and persistence rules.
- Because `color-scheme` follows the class, native form controls switch with it.

---

## 9. Motion

Deliberately minimal. The only tokenised animation is `animate-fadeIn`
(`fadeIn 180ms ease-out`, opacity + a 2px rise) on the metrics dashboard
entrance. The live dot uses Tailwind's `animate-pulse`. Interaction feedback is
`transition-colors` on hover and `active:scale-[0.96–0.98]` on buttons. No other
keyframes exist; add animation sparingly.

---

## 10. Responsive

| Breakpoint | Behaviour |
|---|---|
| `< sm` | Header wraps; board columns are `85vw` snap-scroll; card badge group takes a full line; metrics 2-up; Signal Rail is a slide-over drawer |
| `sm` (≥640px) | Badge group returns inline; metrics 4-up; some header labels reveal |
| `md` (≥768px) | Columns become `w-72`; `‹`/`›` scroll buttons and the docked Signal Rail appear (`w-80`); mobile-only header controls hide |
| `lg` | Additional header labels reveal |

Guarded by `client/src/lib/mobileToolbar.test.mjs` and `responsive.test.mjs`,
which also assert the `100dvh` override exists.

---

## 11. Accessibility

- Contrast targets are annotated in `index.css` and met: light text is 14.73:1
  (`--ink`) / 4.97:1 (`--muted`); dark is 13.1:1 / 8.8:1. Operational foregrounds
  range 4.89:1–8.20:1 (light).
- Status is encoded three ways — stripe, label, glyph — so it survives greyscale.
- Interactive icons carry `aria-label` (`Status: BUILDING`, `Live connection`,
  `Scroll columns left/right`, `Close metrics dashboard`).
- `color-scheme` keeps native controls legible in both themes.
- Decorative overlays and gradients are `pointer-events-none` + `aria-hidden` by
  nature (non-interactive divs).

---

## 12. Anti-Patterns (enforced)

These are banned and machine-checked across `client/src/**/*.{ts,tsx}` by
`client/src/lib/about.test.mjs` and `client/src/lib/responsive.test.mjs` (plus
the component contract test in `server/test/kanban.test.js`):

| Banned | Why |
|---|---|
| `shadow-*` utilities | Depth is hairlines only |
| `rounded-full` (and any radius) | The system is rectilinear |
| `Inter` | Not the chosen voice |
| `Roboto` | Not the chosen voice |
| the person glyph `U+1F464` | Replaced by the mono agent-id chip |

`columnColors.test.mjs` additionally forbids interpolating a Tailwind border
class inside a template string (it would be invisible to the JIT scanner).

---

## 13. Where the Tokens Live / How to Change Them

1. **Add or change a colour** → edit the custom property in **both** `:root` and
   `.dark` in `client/src/index.css`, then confirm the utility exists in
   `client/tailwind.config.js` `theme.extend.colors` (add it if new).
2. **Use it** → reference the Tailwind utility (`bg-surface`, `text-fail`), never
   a raw hex, and never interpolate a class name.
3. **A new column accent** → extend `ColumnColorToken`, `COLUMN_COLOR_LABELS`,
   `ACCENT_CLASS`, `SWATCH_CLASS`, and (if it becomes stock)
   `DEFAULT_COLUMN_COLORS` in `client/src/lib/columnColors.ts`, keeping every
   class **literal**.
4. **A new status** → add it to `STATUS_STYLES` in `client/src/status.js`,
   `status.d.ts`, `CANONICAL_STATUSES` in `lib/status.ts`, the server's
   `STATUSES` in `server/store.js`, and the `COLUMNS` list in `Board.tsx`.
5. **A font change** → update the stack in `tailwind.config.js` *and* the
   matching `.font-*` rule in `index.css`.

**Guards to keep green:** `client/src/lib/theme.test.mjs`,
`columnColors.test.mjs`, `about.test.mjs`, `responsive.test.mjs`,
`mobileToolbar.test.mjs`, and the `DESIGN.md visual contract` test in
`server/test/kanban.test.js`.
