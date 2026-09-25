# Editorial-Minimalist Design System

A portable, project-agnostic visual contract you can hand to a build agent for a
new application. It defines an opinionated visual language — **warm paper,
hairline structure, operational colour, mono identifiers** — and gives the exact
tokens, rules, and component recipes to implement it. It contains no references
to, and no dependency on, any other project.

**How to use this document (build agent):**

1. Read **§1 Principles** and **§12 Anti-Patterns** first — they define the
   intent and the hard bans.
2. Copy the token values in **§2** and **§3** into your global stylesheet and
   theme layer (**§13**).
3. Build components from **§7**, encoding state per **§6**.
4. Meet **§11 Accessibility** and respect **§10 Responsive**.
5. Treat the values in these tables as the contract. Where you must deviate,
   deviate deliberately and leave a note saying why.

The reference implementation uses **Tailwind CSS (v3, `darkMode: 'class'`) over
CSS custom properties**, but the system is stack-agnostic: if you don't use
Tailwind, map each token to your own theme mechanism and keep the same values,
roles, and rules. The `color-*` and spacing tokens map cleanly onto any utility
or token system; the numeric and contrast targets are the part that matters.

Aesthetic in one line: **editorial-minimalist** — a warm paper ground, hairline
structure, and semantic colour used only to encode state.

---

## 1. Principles

1. **Depth from hairlines, never shadows.** Structure is drawn with 1px borders
   in the hairline token. Drop shadows and decorative gradients are banned
   (**§12**). If a surface must recede, use a low-alpha fill, not a shadow.
2. **Warm paper, not white.** The default light theme is a cream page, chosen to
   cut glare; surfaces sit barely above it. Pure `#fff` is not a surface token.
3. **Form *and* colour.** State is never signalled by hue alone. Every state
   carries a left severity stripe, a text label, and — where it helps — a glyph.
   The palette survives greyscale (**§6**).
4. **Colour is operational, not decorative.** The semantic tokens exist to
   describe state and nothing else. There is no brand colour used for ornament;
   the neutral ramp carries the layout.
5. **Identifiers are monospaced.** Ids, counts, metrics, and timestamps use the
   mono stack with `tabular-nums` so digits do not jitter and columns align.
6. **Square corners.** The interface is rectilinear. No border radius anywhere.

---

## 2. Color System

Declare tokens as CSS custom properties once per theme, then map each to a
utility in the theme layer. Components reference the **utility/token**, never a
raw hex. Ship **both themes from the start**; a single-theme build will be
retrofitted badly.

### 2.1 Neutral / surface tokens

| Token | Utility | Light (`:root`) | Dark (`.dark`) | Role |
|---|---|---|---|---|
| `--bg` | `bg-bg` | `#f6f2e8` | `#1b211d` | Page ground (warm cream / dark charcoal) |
| `--surface` | `bg-surface` | `#fdfbf5` | `#252d27` | Cards, panels, header/footer bars |
| `--line` | `border-line` | `#e6dfd0` | `#445047` | The 1px hairline — all structure |
| `--ink` | `text-ink` | `#211f1a` | `#e8ece4` | Primary text (14.73:1 / 13.1:1 on `--bg`) |
| `--muted` | `text-muted` | `#6e6857` | `#b4beaf` | Secondary text (4.97:1 / 8.8:1 on `--bg`) |
| `--muted-bg` | `bg-muted-bg` | `#efe9db` | `rgba(255,255,255,.07)` | Chips, badges, subtle fills |

### 2.2 Scrollbar tokens (optional, for a horizontally scrolling region)

A long horizontal or vertical scroll region can hide its overflow. Give any
**primary navigational scroll region** a visible scrollbar; leave the document
scrollbar a faint hairline.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--scroll-track` | `#ece5d6` | `rgba(255,255,255,.07)` | Scroll track |
| `--scroll-thumb` | `#b8ad95` | `rgba(255,255,255,.30)` | Scroll thumb |
| `--scroll-thumb-hover` | `#9b8f74` | `rgba(255,255,255,.48)` | Thumb hover |

### 2.3 Semantic (operational) tokens

Each pair is `--<name>` (foreground) + `--<name>-bg` (tint). Assign these to your
domain's states in **§6**. Contrast figures are the intended measurements on the
page ground.

| Semantic role | Token | Utility pair | Light fg | Light bg | Dark fg | Dark bg |
|---|---|---|---|---|---|---|
| Success / passing | `--up` / `--up-bg` | `text-up` / `bg-up-bg` | `#346538` | `#e8efe2` | `#8fc79f` | `rgba(120,190,145,.16)` |
| Failure / bad | `--down` / `--down-bg` | `text-down` / `bg-down-bg` | `#9f2f2d` | `#f9e7e3` | `#e39b96` | `rgba(220,115,110,.17)` |
| Success alias | `--pass` | `text-pass` / `bg-pass-bg` | alias of `--up` | alias of `--up-bg` | — | — |
| Failure alias | `--fail` | `text-fail` / `bg-fail-bg` | alias of `--down` | alias of `--down-bg` | — | — |
| Warning / attention | `--warn` / `--warn-bg` | `text-warn` / `bg-warn-bg` | `#8A6A12` | `#f6efdc` | `#ddb45c` | `rgba(221,180,92,.16)` |
| Stalled / inert (neutral) | `--block` / `--block-bg` | `text-block` / `bg-block-bg` | `#4A4D52` | `#ece7db` | `#a6acb5` | `rgba(255,255,255,.07)` |
| Active / in-progress (info) | `--live` / `--live-bg` | `text-live` / `bg-live-bg` | `#1F5673` | `#e4ecf0` | `#8fbcd6` | `rgba(143,188,214,.16)` |
| Verification / accent | `--test` / `--test-bg` | `text-test` / `bg-test-bg` | `#6B4E9B` | `#ece5f5` | `#b9a3e3` | `rgba(169,138,224,.18)` |

Notes — the reasoning is reusable, not just the values:

- **Aliases.** Success/pass and failure/fail are aliases: `--pass: var(--up)`,
  `--fail: var(--down)`. Change the up/down pair and everything downstream
  follows. Prefer aliases over duplicate hexes.
- **Stalled ≠ failing.** The neutral "stalled/inert" role is a deliberate cool
  slate, kept visually distinct from failure. Do not collapse them: a paused
  thing is not a broken thing.
- **Active vs. verifying are different hues.** The info (blue) and accent
  (violet) roles are separated so "running" and "being checked" never read the
  same. Pick hues that stay apart under colour-blindness.

### 2.4 Theme declaration

- Each theme sets `color-scheme` (`light` on `:root`, `dark` on the dark class)
  so native controls — notably `<select>` popups and scrollbars — match the page.
- Do **not** add a `prefers-color-scheme` media block. Such a block re-applies
  dark tokens under the root regardless of an explicit class, making a user's
  explicit "light" choice invisible. Consult the OS preference **exactly once**
  in JS, then fold it into a single class (**§8**).

---

## 3. Typography

Three stacks. Declare them in the theme layer and mirror them in the global
stylesheet.

| Role | Utility | Stack |
|---|---|---|
| Body / UI | `font-sans` (default on `body`) | `system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif` |
| Display / titles | `font-serif` | `Instrument Serif, Georgia, Times New Roman, serif` |
| Identifiers / data | `font-mono` | `ui-monospace, SF Mono, JetBrains Mono, Menlo, Consolas, monospace` |

Rules:

- The **serif display face is the accent**, not the default. Reserve it for page
  and section titles (`font-serif text-base font-normal tracking-tight sm:text-lg`
  is a good title recipe). Body copy is the system sans.
- **Mono + `tabular-nums` is mandatory** for anything numeric or machine-owned:
  ids, counts, metrics, timestamps, slugs. Define `.tabular-nums` as
  `font-variant-numeric: tabular-nums`.
- **Micro-scale** is mono, uppercase, wide-tracked. The canonical patterns are
  `font-mono text-[10px] uppercase tracking-[0.12em]` (badges) and
  `tracking-[0.14em]` (section headers). Sub-labels use `text-[9px]`; meta rows
  `text-[11px]`.
- `Inter` and `Roboto` are banned outright (**§12**) — the system voice is the
  native stack plus one serif display face.

---

## 4. Geometry & Spacing

| Concern | Rule |
|---|---|
| Hairline | `border border-line` (1px) is the default for every surface |
| Accent edge | A 2px top rule (`border-t-2 border-t-<token>`) marks a group's colour identity |
| Severity stripe | `border-l-[3px]` on cards and state badges (**§6**) |
| Severity edge (card) | `border-r-2 border-r-fail` on the card's trailing edge for the most severe items |
| Card padding | `p-3` (0.75rem) |
| Group/list width | `w-[85vw]` on phones, `md:w-72` (18rem) from `md` up |
| Group gap | `gap-4` (1rem); region padding `p-4` |
| Corners | Always square — no border-radius utilities anywhere |

Stacked surfaces use low-alpha fills (`bg-surface/40`, `bg-surface/70`) to nest,
rather than adding another border, keeping the hairline budget low.

---

## 5. Layout Shell

```
<div class="flex h-screen flex-col bg-bg text-ink">
  <header class="… border-b border-line bg-surface …">   ← chrome, mono controls
  <main class="flex flex-1 overflow-hidden">
    <primary-region/>                                    ← e.g. scrollable groups
    <aside class="w-80 border-l border-line …"/>         ← optional side panel
  </main>
</div>
```

- `h-screen` should be overridden to `100dvh` under `@supports (height:100dvh)`
  so mobile URL bars don't push the layout off-screen.
- The header is the only place the display serif appears; every control in it is
  mono, uppercase, `text-[11px]`, and hairline-bordered
  (`border border-line bg-surface px-2.5 py-1.5 … hover:bg-muted-bg`).
- A live/session indicator is a small square (`h-2 w-2`, no radius) tinted with
  the info token and animated with a pulse, carrying an `aria-label`.

---

## 6. State & Severity Encoding

The reusable idea: **define a small semantic palette (§2.3), then map every
domain state onto a role and render three signals — stripe, label, glyph.**

### 6.1 Map your states to roles

List your domain's states and assign each one a semantic role. Example for an
arbitrary workflow with states `draft → active → paused → verifying → done →
cancelled`:

| Domain state | Role | Token |
|---|---|---|
| `done` | Success | `--pass` |
| `verifying` | Verification | `--test` |
| `active` | Active / info | `--live` |
| `paused` | Stalled / neutral | `--block` |
| `draft` | Neutral / default | `--line` + `--muted` |
| `cancelled` | Failure | `--fail` |

Keep one canonical status set in one module, and a `normalize()` that maps legacy
or unknown input to a safe default (never throw on unknown state). A common
normalization rule: unknown / empty / non-string → a neutral `UNKNOWN` state.

### 6.2 Stripe + badge

Every state renders a **left stripe** and a **badge tint** from the same role:

| Role | Stripe class | Badge class |
|---|---|---|
| Success | `border-l-pass` | `bg-pass-bg text-pass` |
| Verification | `border-l-test` | `bg-test-bg text-test` |
| Warning | `border-l-warn` | `bg-warn-bg text-warn` |
| Active | `border-l-live` | `bg-live-bg text-live` |
| Stalled | `border-l-block` | `bg-block-bg text-block` |
| Neutral | `border-l-line` | `bg-muted-bg text-muted` |
| Failure | `border-l-fail` | `bg-fail-bg text-fail` |

The badge recipe:

```
inline-flex items-center border-l-[3px] px-1.5 py-0.5
font-mono text-[10px] uppercase tracking-[0.12em]
aria-label="Status: <NORMALIZED>"
```

### 6.3 Glyphs (form encoding)

Add a glyph where it disambiguates, so colour is never the only signal:

| Glyph | Meaning |
|---|---|
| `▲ ` | awaiting a human step (e.g. review) |
| `• ` | actively running |

### 6.4 Severity (priority)

Fold any backend triage scheme onto three keys — `high`, `medium`, `low` — with a
safe fallback to `medium` so a render can never throw. An unmapped value must not
crash the UI.

| Severity | Badge class | Card edge |
|---|---|---|
| `high` | `bg-fail-bg text-fail border-fail/40 font-semibold` | `border-r-2 border-r-fail` |
| `medium` | `bg-warn-bg text-warn border-warn/40` | — |
| `low` | `bg-muted-bg text-muted border-line` | — |

### 6.5 Metadata glyphs

Use a small, fixed glyph set for secondary card metadata (icons in mono chips),
kept to the hairline + neutral fill so they don't compete with the status stripe.

---

## 7. Component Patterns

Build these from tokens; the class recipes are illustrative of the geometry, not
a required framework.

### 7.1 Card

```
group cursor-pointer border border-line bg-surface p-3 transition-colors
hover:bg-muted-bg/50 border-l-[3px] <state-stripe>
[border-r-2 border-r-fail]   ← only when severity is high
```

- Header row: a primary id/label (`min-w-0 flex-1 truncate font-mono text-xs
  tabular-nums tracking-wider`, full value in `title`) with a badge group pinned
  right. On phones the badge group takes its own full-width line (`w-full
  sm:w-auto`) so the id owns the row.
- Title: `text-sm font-medium leading-snug break-words`.
- Footer: `border-t border-line/60 pt-2` with muted metadata.
- Memoise by `id + version` when a version bump signals a content change.

### 7.2 List group (vertical column)

```
flex w-[85vw] shrink-0 snap-start flex-col border border-line bg-surface/40
md:w-72 border-t-2 border-t-<token>
```

- Header: an optional mono step chip (`01`, `02`…), a title
  (`font-mono text-xs font-semibold uppercase tracking-wider`), and a count chip
  that escalates to `bg-fail-bg text-fail border-fail/40 font-bold` when the
  group holds an item in a failing state.
- Completed groups can render at `opacity-70`.
- Accent identity is the **only** per-group variable; the eight selectable accent
  tokens are the semantic roles in §2.3 plus `line`.

### 7.3 Horizontal scroll region

```
board-like-scroll flex h-full w-full snap-x scroll-pl-4 gap-4 overflow-x-auto p-4
```

- Give the region a **visible scrollbar** via §2.2 and add a `‹`/`›` button pair
  (`hidden … md:flex`) because a trackpad-less mouse can't drag it.
- Edge-fade overlays (`bg-gradient-to-r/l from-bg to-transparent`, `w-10`,
  `pointer-events-none`) indicate overflow. **These two are the only gradients
  permitted.**

### 7.4 Side panel (activity rail)

```
<aside class="flex w-80 shrink-0 flex-col border-l border-line bg-surface/40">
```

- A rollup header (`border-b border-line p-4`) with a small grid of stat cells
  (`border border-line bg-surface p-2.5 text-center`).
- An activity feed: most recent N entries, `divide-y divide-line/40`; each row is
  a button with a mono chip, a message, and a relative timestamp.
- Below `md` it becomes a right-anchored slide-over drawer.

### 7.5 Stat strip (KPI grid)

```
border-b border-line bg-surface/70 px-3 py-2.5 backdrop-blur-sm animate-fadeIn
grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2
```

Each cell: `border border-line bg-surface p-2 text-center`, a `text-lg
tabular-nums` value over a `text-[9px] uppercase tracking-wider` label. Cells
that represent a bad/attention metric escalate their border+fill
(`border-fail bg-fail-bg` / `border-warn bg-warn-bg`) when non-zero.

### 7.6 Data-driven content panel

Keep long-form or marketing content (feature lists, FAQs, architecture, metrics)
in a **data module**, not hard-coded in JSX: `TRUST_METRICS`, `STEPS`, `FAQ`,
`CAPABILITIES`, etc. Render rows with hairline dividers (`border-b border-line
py-2.5 last:border-0`) and step markers in a fixed square
(`flex h-7 w-7 … border border-line bg-surface font-mono text-[11px]`). Any
counts shown to users must be generated from or refreshed against their real
source.

---

## 8. Theming

- Class-based: a single `.dark` class on the root swaps every token.
- Resolution is **pure** and testable: `resolveTheme(stored, prefersDark)` →
  an explicit stored `'light' | 'dark'` always wins; otherwise the OS preference
  is used. Storage key: `theme`.
- The toggle calls `nextTheme(current)`. Lock the precedence and persistence
  rules with unit tests.
- Because `color-scheme` follows the class (§2.4), native form controls switch
  with the theme automatically.

---

## 9. Motion

Deliberately minimal. One tokenised entrance animation is enough
(`fadeIn 180ms ease-out`, opacity + a 2px rise). A live indicator may use a
pulse. Interaction feedback is `transition-colors` on hover and
`active:scale-[0.96–0.98]` on buttons. Add no other keyframes without reason;
motion is a garnish, not a layer.

---

## 10. Responsive

| Breakpoint | Behaviour |
|---|---|
| `< sm` | Header wraps; primary groups are `85vw` snap-scroll; card badge group takes a full line; stat strip 2-up; side panel is a slide-over drawer |
| `sm` (≥640px) | Badge group returns inline; stat strip 4-up; some header labels reveal |
| `md` (≥768px) | Groups become `w-72`; scroll buttons and the docked side panel (`w-80`) appear; mobile-only header controls hide |
| `lg` | Additional header labels reveal |

Assert the `100dvh` override in tests. Prefer content-driven breakpoints over
device names.

---

## 11. Accessibility

- **Contrast targets are part of the contract.** Annotate them in the
  stylesheet and meet them: the neutral text roles should land near 14.7:1 (ink)
  and 5:1 (muted) in light mode, and stay ≥8:1 in dark. Semantic foregrounds
  should be kept roughly 4.9:1–8.2:1.
- **State is encoded three ways** — stripe, label, glyph — so it survives
  greyscale and colour-blindness.
- Interactive icons carry `aria-label` (e.g. `Status: <STATE>`, `Live
  connection`, `Scroll left/right`, `Close panel`).
- `color-scheme` keeps native controls legible in both themes.
- Decorative overlays and gradients are non-interactive (`pointer-events-none` /
  `aria-hidden`).

---

## 12. Anti-Patterns (hard bans)

These are banned and, ideally, machine-checked across your source:

| Banned | Why |
|---|---|
| `shadow-*` utilities | Depth is hairlines only |
| `rounded-full` and any radius | The system is rectilinear |
| `Inter` | Not the chosen voice |
| `Roboto` | Not the chosen voice |
| Emoji as data markers | Use mono id/agent chips instead of person or status emoji |

Additionally:

- **Never interpolate a class name at runtime** (e.g. `` `border-l-${token}` ``).
  A JIT/utility scanner cannot see it; keep every class a literal string and map
  tokens to literal class names.
- **Never reference a raw hex in a component.** Go through a token/utility so
  both themes stay correct.

---

## 13. Token Wiring & How to Change Them

1. **Add or change a colour** → edit the custom property in **both** the light
   and dark blocks of your global stylesheet, then confirm/add the matching
   utility in your theme layer.
2. **Use it** → reference the utility/token, never a raw hex; never interpolate a
   class name.
3. **Add a selectable accent** → extend your token union, label map, and the
   literal class maps together, keeping every class a **literal**.
4. **Add a state** → add it to the canonical status list, the normalize function,
   the style map, and the group ordering — one place each, kept in sync.
5. **Change a font** → update the stack in the theme layer *and* the matching
   `.font-*` rule in the stylesheet.

**Guards worth writing for a new project:** a theme-precedence test, a
token/utility coverage test (every token has a literal class), an anti-pattern
scan (the §12 bans), and a source-contract test that asserts a couple of the
load-bearing classes are present. Cheap tests are what keep a design system from
drifting.

---

## 14. New-Project Quick-Start

- [ ] Global stylesheet declares the **six neutral tokens** + **`color-scheme`** for both themes.
- [ ] Global stylesheet declares the **semantic pairs** (`up/down/warn/block/live/test` + aliases).
- [ ] Theme layer maps every token to a utility and sets three font stacks.
- [ ] Pure `resolveTheme` / `nextTheme` with a unit test; storage key defined.
- [ ] App shell: `flex h-screen flex-col bg-bg text-ink` + `100dvh` override.
- [ ] One `StatusBadge`-style primitive renders stripe + label + `aria-label`.
- [ ] One card, one list group, one stat strip built from the recipes in §7.
- [ ] Responsive pass at ~<640 / 640 / 768 / 1024 px.
- [ ] Anti-pattern scan green (no `shadow-*`, no radius, no `Inter`/`Roboto`, no emoji markers, no interpolated classes).
- [ ] Contrast measured and noted in the stylesheet.
