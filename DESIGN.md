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
| `--bg` | `bg-bg` | `#f6f2e8` | `#0c1726` | Page ground (warm cream / deep navy) |
| `--surface` | `bg-surface` | `#fdfbf5` | `#13243b` | Cards, sheets, header/footer panels |
| `--line` | `border-line` | `#e6dfd0` | `#26405f` | The 1px hairline — all structure |
| `--ink` | `text-ink` | `#211f1a` | `#e7edf6` | Primary text (14.73:1 / 15.3:1 on `--bg`) |
| `--muted` | `text-muted` | `#6e6857` | `#a9b7cb` | Secondary text (4.97:1 / 8.85:1 on `--bg`) |
| `--muted-bg` | `bg-muted-bg` | `#efe9db` | `rgba(120,170,255,.08)` | Chips, badges, subtle fills |

### 2.2 Scrollbar tokens (board only)

| Token | Light | Dark | Role |
|---|---|---|---|
| `--scroll-track` | `#ece5d6` | `rgba(12,23,38,.7)` | Board scroll track |
| `--scroll-thumb` | `#b8ad95` | `rgba(169,183,203,.35)` | Board scroll thumb |
| `--scroll-thumb-hover` | `#9b8f74` | `rgba(169,183,203,.55)` | Thumb hover |

The board needs a **visible** scrollbar (off-screen columns were undiscoverable);
the global document scrollbar stays a faint `--line` hairline. See §7.3.

### 2.3 Operational tokens

Each pair is `--<name>` (foreground) + `--<name>-bg` (tint). Contrast figures are
the CSS comments' own measurements.

| Token | Utility pair | Light fg | Light bg | Dark fg | Dark bg | Meaning |
|---|---|---|---|---|---|---|
| `--up` / `--up-bg` | `text-up` / `bg-up-bg` | `#346538` | `#e8efe2` | `#3dd6a8` | `rgba(61,214,168,.16)` | Healthy / passing |
| `--down` / `--down-bg` | `text-down` / `bg-down-bg` | `#9f2f2d` | `#f9e7e3` | `#ff7a55` | `rgba(255,122,85,.18)` | Failing / bad |
| `--pass` | alias of `--up` | — | — | — | — | Passing checks |
| `--fail` | alias of `--down` | — | — | — | — | Failed checks |
| `--warn` / `--warn-bg` | `text-warn` / `bg-warn-bg` | `#8A6A12` | `#f6efdc` | `#f2c14e` | `rgba(242,193,78,.16)` | Attention (4.89:1 light) |
| `--block` / `--block-bg` | `text-block` / `bg-block-bg` | `#4A4D52` | `#ece7db` | `#9ba6b8` | `rgba(155,166,184,.14)` | Stalled — grey, deliberately *not* bad (8.20:1 light) |
| `--live` / `--live-bg` | `text-live` / `bg-live-bg` | `#1F5673` | `#e4ecf0` | `#6aa8ff` | `rgba(106,168,255,.12)` | Running now (7.69:1 light) |
| `--test` / `--test-bg` | `text-test` / `bg-test-bg` | `#6B4E9B` | `#ece5f5` | `#b38cff` | `rgba(179,140,255,.16)` | Verification stage — violet (6.4:1 light) |

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
- The dark palette is a midnight-navy blueprint adopted from the Stack Field
  Guide (https://stack-field-guide.riazrahaman.com/#map): deep navy canvas,
  elevated navy card surface, crisp slate-blue borders, ice-white text, and
  status tokens mapped to the Field Guide's category colors.

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
- There is no app-wide footer. A v2.16.3 slim footer link (`AppFooter.tsx`)
  that existed as a third Report-a-bug entry point was removed in v2.17.0
  once the feature got a direct header icon (§7.7) — see that section for
  the current set of entry points.

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

### 7.7 Report-a-bug sheet (`components/BugReportDialog.tsx`)

Same slide-in shell as TaskSheet (§7, right-anchored `aside`, `fixed inset-0`
scrim, `translate-x-full` ↔ `translate-x-0`, Escape-to-close) — the one other
panel on the board that is not a task. Two conventions it introduces that a
future form should reuse:

- **Char counter.** A right-aligned `font-mono text-[10px] tabular-nums
  text-muted` count next to the field label, driven by a pure
  `remainingChars(value, max)` helper (`lib/bugReport.ts`) — never computed
  inline in the component.
- **Honeypot field.** Moved off-screen with `absolute -left-[9999px] ...
  h-px w-px overflow-hidden` plus `aria-hidden="true"` and `tabIndex={-1}` —
  **never** `className="hidden"` / `display:none`, which some bots
  special-case and skip "filling" (defeating the trap). Still a real
  `<label>` + `<input>` pair, just unreachable by a human.

The Turnstile widget container (`<div ref={widgetContainerRef} />`) is an
unstyled mount point — Cloudflare's own script renders into it — so it
carries no DESIGN.md tokens itself (beyond a defensive `max-w-full
overflow-hidden` cap, v2.17.0); the surrounding form does. It is rendered
with Turnstile's `size: 'flexible'` option so it fills the sheet's width
instead of forcing a fixed ~300px box.

**Entry point (v2.17.0): a small icon button in the header, immediately
beside the theme toggle.** `App.tsx` renders an inline-SVG bug glyph
(stroke-only line icon, matching the rest of the UI's no-emoji/no-icon-font
convention) in a square button styled with the same `border-line`/
`bg-surface` tokens as the theme toggle, `pointer-coarse:min-h-11
pointer-coarse:min-w-11` for the touch target and a compact ~28px box on a
mouse. It and the theme toggle sit together in one `shrink-0` flex group so
they are always adjacent and wrap (or don't) as a single unit. Rendered only
once `GET /api/bug-reports/config` confirms the feature, and renders nothing
at all (not a disabled/hidden button) when it is off — same
zero-layout-change-by-default contract every earlier entry point used.
`About.tsx` keeps its own CTA (§7.6) — that page isn't width-constrained the
way the header toolbar is.

This replaces TWO earlier entry points, both removed in v2.17.0: a row
inside `HeaderHelp.tsx`'s "i" popover (v2.16.0 — a standalone labelled
header button had cost just enough width to wrap the toolbar at several mid
viewports, so the entry was hidden behind the popover instead), and a slim
global footer link (`AppFooter.tsx`, v2.16.3, added because the popover was
still a 3-tap discovery path on a phone). An unlabelled icon-only button
sidesteps the ORIGINAL width problem the popover was built to avoid, so a
single direct, always-visible entry point now covers the same ground the
popover + footer combination did. `HeaderHelp.tsx` reverts to explaining
only the agent-id/api-token fields; its own `max-lg:fixed` viewport
containment fix (below) is unrelated to what the popover contains and
stays. Guarded by `scripts/check-header-layout.mjs`, which measures the
header's height with the feature flag ON vs OFF at eleven widths
(320-1920px) in both pointer environments — the hard requirement is that
ON and OFF measure IDENTICALLY; a width that would wrap only when the icon
is present must be fixed by tightening the icon/theme group's layout, not
accepted as a taller ON-state header.

**The "i" popover itself must stay viewport-anchored below `lg`, not
button-anchored** (unrelated to what it contains — this is about the
popover's own position). `right:0` positions a popover relative to its own
trigger button, not the viewport — fine for a narrow popover (ProjectPicker's
`w-48`) near a predictable edge, but a wide one (this `w-80`) clipped off the
LEFT edge whenever the "i" button sat less than 320px from it: measured at
320-390px AND again at 768-820px, where the full header-controls row is
already inline and crowds the button rightward. No width/max-width tweak
fixes an anchor-relative overflow — the fix is a different ANCHOR, not a
smaller box. Below `lg` (1024px) this popover is `fixed` + `inset-x-3`
(viewport margins, bottom-pinned), the same strategy `ColumnColorsControl`
already uses below `sm` — just at a wider cutover, because this popover is
wider and sits further right in a busier row. From `lg` up it reverts to the
original `absolute right-0` anchored dropdown. `max-w-[calc(100vw-1.5rem)]`
is an unconditional safety net at every breakpoint. Guarded by
`scripts/check-header-layout.mjs`'s popover-containment check (real
headless Chrome, 320-1440px) and a `bugReportContract.test.mjs` assertion
that it can never regress to an unconditional `absolute right-0`.

**iOS/WebKit sheet fixes (v2.17.0).** A real-device report showed the sheet
panning horizontally, its content zoomed, and the Turnstile widget/Submit
button pinned under Safari's floating bottom toolbar. Defenses applied:
`overflow-x-hidden` + `max-w-[100vw]` on the `<aside>` itself (a
`position:fixed` panel translated off-screen via `translate-x-full`, or an
absolutely-positioned descendant like the honeypot's `-left-[9999px]` offset,
can still widen WebKit's document scroll area even though nothing is
visually overflowing) plus the same `overflow-x: hidden` on `html, body` as
a second line of defense (`index.css`); `inert` on the closed sheet so it
exits the a11y tree and tab order immediately; `height: 100dvh` so mobile
chrome cannot clip it; and a submit button pinned in its own `shrink-0`
footer OUTSIDE the scrollable body (`form="bug-report-form"` associates it
with the `<form>` by id) with `padding-bottom:
calc(1rem + env(safe-area-inset-bottom))`, so it stays reachable above a
floating toolbar regardless of scroll position. The horizontal-overflow and
bottom-clearance mechanisms are verifiable in real WebKit (Playwright); the
OS-level pinch-zoom-on-focus chrome itself is not reproducible outside a
physical iPhone — see `bugReportContract.test.mjs` for the source-level
guards and the card's test notes for what was actually measured.

---

## 8. Theming

- Class-based (`tailwind.config.js` → `darkMode: 'class'`); `.dark` on the root
  swaps every token.
- Three stored modes (v2.17.0): `'auto'` (follows OS `prefers-color-scheme`,
  the default with no stored choice), `'light'`, `'dark'` (explicit, always
  win). Resolution is pure and lives in `client/src/lib/theme.ts`:
  `parseStoredMode(stored)` turns a raw `localStorage` read into a mode (only
  the exact literals `'light'`/`'dark'` are explicit; anything else,
  including an explicit `'auto'`, a missing key or garbage, is auto);
  `resolveMode(mode, prefersDark)` resolves a mode to the applied
  `'light' | 'dark'` theme. Storage key: `theme` — `'auto'` is written
  explicitly rather than by removing the key, so every mode round-trips
  through one read path with no special-cased "no key" branch.
- The single compact toggle button cycles `nextMode(current)`: Auto → Light →
  Dark → Auto, labelled `AUTO`/`LIGHT`/`DARK` (similar width in all three
  states so the header does not reflow) via `modeLabel`, with a dynamic
  `title` from `themeToggleTitle` (e.g. "Theme: auto (follows system). Click
  for light"). Auto mode live-updates: a `matchMedia('(prefers-color-scheme:
  dark)')` `change` listener in `App.tsx` re-resolves the theme the instant
  the OS setting flips, no reload needed. `theme.test.mjs` locks the
  precedence, cycling and persistence rules; `client/index.html`'s pre-paint
  inline script mirrors the same stored-value handling so there is no flash
  of the wrong theme in any of the three modes on first load.
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
