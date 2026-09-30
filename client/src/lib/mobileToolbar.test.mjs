// v2.5.9 regression guard: the board toolbar controls must stay reachable on
// a phone.
//
// Report (2026-09-25): on a 390px viewport the BoardFilters inner control group
// (Sort / Export / Colors / Metrics) laid out 720px wide, did NOT wrap, and was
// clipped by the parent `overflow-hidden` column — `elementFromPoint` at the
// controls' centres returned null, so they could not be tapped at all. The
// header also wrapped to four rows (~158px, 19% of a 390x844 viewport).
//
// A className assertion cannot measure that clipping, so this test asserts the
// *shrink-and-wrap contract* that makes it impossible: each toolbar group must
// be allowed to shrink (min-w-0) and wrap, and nothing in the toolbar may pin a
// rigid non-shrinking row on small screens.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = join(__dirname, '..')

const filtersSource = readFileSync(join(CLIENT_SRC, 'components', 'BoardFilters.tsx'), 'utf8')
const appSource = readFileSync(join(CLIENT_SRC, 'App.tsx'), 'utf8')
// The "Columns" control lives in its own component that BoardFilters imports and
// renders inline. A source scan of BoardFilters.tsx alone cannot see that
// button, so read it too — this is exactly the gap that let the ColumnColors
// trigger keep a bare `py-1` after the first v2.5.9 pass.
const columnColorsSource = readFileSync(
  join(CLIENT_SRC, 'components', 'ColumnColorsControl.tsx'),
  'utf8',
)

test('the filter toolbar never pins a rigid, non-shrinking control row', () => {
  // The exact regression: a control group that cannot shrink and cannot wrap.
  assert.doesNotMatch(
    filtersSource,
    /className="flex items-center gap-2"/,
    'the toolbar control group must not be a rigid `flex items-center gap-2` row — it cannot shrink or wrap and gets clipped by the board column on phones',
  )
  assert.doesNotMatch(
    filtersSource,
    /\bflex-none\b/,
    'the toolbar controls must not be forced `flex-none`; under the docked signal rail that reintroduces clipping',
  )
})

test('the toolbar root wraps and the secondary controls can shrink', () => {
  const root = filtersSource.match(/<div className="([^"]*flex flex-wrap[^"]*)"/)?.[1]
  assert.ok(root, 'BoardFilters must render a wrapping root row')
  assert.match(root, /\bflex-wrap\b/, 'the toolbar root must wrap')

  // v2.9.1: the secondary filter controls collapse behind a phone disclosure
  // (class `min-w-0 flex-wrap ... sm:flex`) and must carry min-w-0 so flex is
  // allowed to shrink them below their content width.
  assert.match(
    filtersSource,
    /className=\{`min-w-0 flex-wrap items-center gap-2 sm:flex/,
    'the filter control group must keep `min-w-0` and be `sm:flex` so it can shrink and only shows inline from sm up',
  )
})

function borderedControlClasses(source) {
  // py-1.5 on phones (>=~30px tall) is the touch floor; sm:py-1 restores the
  // denser desktop rhythm. Match only the interactive controls: the <select>
  // tags and buttons carrying a literal className.
  const selects = source.match(/<select\b[\s\S]*?className="([^"]*)"/g) || []
  const buttons = [...source.matchAll(/<button\b[\s\S]*?className=(?:"([^"]*)"|\{[\s\S]*?'([^']*)')/g)]
  // Keep only bordered controls that flow inline. Excluded: the absolute
  // clear-search "×" glyph (not a bordered control) and the fixed 16px colour
  // swatches (`h-4 w-4`) — these are deliberately tiny chips, not tap targets.
  return [...selects, ...buttons.map((m) => `${m[1] ?? m[2] ?? ''}`)].filter(
    (cls) => cls.includes('border') && !(cls.includes('h-4') && cls.includes('w-4')),
  )
}

test('every toolbar input/select/button keeps a phone-sized tap target', () => {
  // Scan BOTH the toolbar and the "Columns" control it imports and renders: the
  // latter is a separate component, so a BoardFilters-only scan cannot see it.
  const controls = [
    ...borderedControlClasses(filtersSource),
    ...borderedControlClasses(columnColorsSource),
  ]
  assert.ok(controls.length >= 6, `expected toolbar controls, found ${controls.length}`)
  for (const cls of controls) {
    assert.match(
      cls,
      /py-1\.5/,
      `every toolbar control needs a py-1.5 phone tap target, got: ${cls}`,
    )
  }
  assert.match(filtersSource, /sm:py-1/, 'desktop density (sm:py-1) must be preserved')
  assert.match(columnColorsSource, /sm:py-1/, 'the Columns control must keep desktop density too')
})

test('selects are clamped so they cannot exceed the row width', () => {
  const selects = filtersSource.match(/<select\b[\s\S]*?className="([^"]*)"/g) || []
  assert.equal(selects.length, 3, 'BoardFilters renders priority, assignee and sort selects')
  for (const sel of selects) {
    assert.match(sel, /max-w-full/, 'each toolbar select must clamp to `max-w-full`')
  }
})

test('the header keeps a compact phone rhythm and does not force a tall stack', () => {
  const headerTag = appSource.match(/<header\b[^>]*>/)?.[0]
  assert.ok(headerTag, 'App.tsx must render a <header> element')
  assert.match(headerTag, /\bflex-wrap\b/, 'the header must still wrap')
  // Phone padding must be exactly `py-2` (not `py-2.5`): assert the token is
  // whitespace-delimited so a `.5` suffix cannot satisfy it via a word boundary.
  assert.match(
    headerTag,
    /(?:^|\s)py-2(?=\s)/,
    'the header must use a tighter phone padding (exactly py-2) so it does not eat a fifth of the viewport',
  )
  assert.match(appSource, /text-base[^"]*sm:text-lg/, 'the title must scale down on phones')
})

// ---------------------------------------------------------------------------
// v2.9.1 mobile-rendering guards (mobile-rendering-issues.md).
// ---------------------------------------------------------------------------

test('the header collapses secondary controls behind a phone disclosure', () => {
  // Issue 1: the header's secondary controls must NOT all be visible on phones.
  // A `⋯` disclosure (md:hidden) toggles them; the identity/token/theme block
  // lives inside a `hidden`-when-closed container that only goes inline at md.
  assert.match(
    appSource,
    /aria-label="Toggle board controls"/,
    'the header must expose a phone-only controls disclosure button',
  )
  assert.match(
    appSource,
    /className="ml-auto border border-line bg-surface px-2\.5 py-1\.5[^"]*md:hidden"/,
    'the controls disclosure must be phone-only (md:hidden)',
  )
  assert.match(
    appSource,
    /data-testid="header-controls"/,
    'the collapsible header control block must be identifiable',
  )
  // The block is `hidden` unless the disclosure is open, and always `md:flex`.
  assert.match(
    appSource,
    /headerOpen \? 'flex w-full basis-full' : 'hidden'/,
    'the header control block must be hidden when the disclosure is closed',
  )
  assert.match(
    appSource,
    /items-center gap-2 md:flex md:gap-3/,
    'the header control block must always show inline from md up',
  )
})

test('the filter bar collapses secondary controls behind a phone disclosure', () => {
  // Issue 1: the filter bar must not free-wrap into ~5 rows on phones.
  assert.match(
    filtersSource,
    /aria-label="Toggle filters and actions"/,
    'BoardFilters must expose a phone-only filters disclosure',
  )
  assert.match(
    filtersSource,
    /className="[^"]*sm:hidden"/,
    'the filters disclosure must be phone-only (sm:hidden)',
  )
  assert.match(
    filtersSource,
    /data-testid="filter-controls"/,
    'the collapsible filter control block must be identifiable',
  )
  assert.match(
    filtersSource,
    /sm:flex \$\{/,
    'the filter control block must always show inline from sm up',
  )
})

test('the column scroll-arrow buttons never overlay card content on phones', () => {
  // Issue 2: the absolute arrows sat on top of cards in an 85vw column.
  const boardSource = readFileSync(join(CLIENT_SRC, 'components', 'Board.tsx'), 'utf8')
  const arrows = [...boardSource.matchAll(/aria-label="Scroll columns[^"]*"[\s\S]*?className="([^"]*)"/g)]
  assert.equal(arrows.length, 2, 'Board.tsx must render both scroll-arrow buttons')
  for (const [, cls] of arrows) {
    assert.match(cls, /\bhidden\b/, 'each scroll arrow must be hidden by default')
    assert.match(cls, /\bmd:flex\b/, 'each scroll arrow may only reappear from md up')
  }
})

test('the column scroll-arrow buttons provide high-contrast tactile affordance (v2.14.5)', () => {
  const boardSource = readFileSync(join(CLIENT_SRC, 'components', 'Board.tsx'), 'utf8')
  const arrows = [...boardSource.matchAll(/aria-label="Scroll columns[^"]*"[\s\S]*?className="([^"]*)"/g)]
  assert.equal(arrows.length, 2, 'Board.tsx must render both scroll-arrow buttons')
  for (const [, cls] of arrows) {
    assert.match(cls, /\bborder-2\b/, 'each scroll arrow must have a bold 2px border')
    assert.match(cls, /\bborder-ink\b/, 'each scroll arrow must use solid ink border for high contrast')
    assert.match(cls, /\bh-11\b/, 'each scroll arrow must have ample click height')
    assert.match(cls, /\bw-8\b/, 'each scroll arrow must have ample click width')
    assert.match(cls, /\btext-lg\b/, 'each scroll arrow must have prominent glyph size')
  }
})

test('the card header stacks the badge group so the id keeps real width', () => {
  // Issue 3: the id collapsed to a sliver against a wide badge row on mobile.
  const cardSource = readFileSync(join(CLIENT_SRC, 'components', 'TaskCard.tsx'), 'utf8')
  const badgeGroup = cardSource.match(
    /<div className="([^"]*shrink-0[^"]*items-center gap-1\.5[^"]*)"/,
  )?.[1]
  assert.ok(badgeGroup, 'the card header must render a badge group')
  assert.match(badgeGroup, /\bw-full\b/, 'the badge group must take a full row on phones')
  assert.match(badgeGroup, /\bsm:w-auto\b/, 'the badge group returns inline from sm up')
})

// ---------------------------------------------------------------------------
// GH #76 / #77: touch ergonomics, keyed on `pointer: coarse`.
//
// #76: iOS Safari zooms the page on focus when a text control's computed
// font-size is < 16px; the mono controls are 11px. #77: at 320-430px the tabs,
// the `⋯` header menu and the filter row were 29-31px tall, under the 44px
// touch-target floor. Both fixes apply only under `(pointer: coarse)` so mouse
// and trackpad users keep the dense desktop layout at every width (a width
// breakpoint cannot tell a 768px tablet from a 768px desktop window).
// ---------------------------------------------------------------------------

const cssSource = readFileSync(join(CLIENT_SRC, 'index.css'), 'utf8')
const headerHelpSource = readFileSync(join(CLIENT_SRC, 'components', 'HeaderHelp.tsx'), 'utf8')
const projectPickerSource = readFileSync(join(CLIENT_SRC, 'components', 'ProjectPicker.tsx'), 'utf8')
const COARSE_TARGET = /\bpointer-coarse:min-h-11\b/

test('touch devices get >=16px text in every form control (no iOS focus zoom)', () => {
  const idx = cssSource.search(/@media \(pointer: coarse\) \{/)
  assert.ok(idx >= 0, 'index.css must carry an @media (pointer: coarse) block')
  const block = cssSource.slice(idx, cssSource.indexOf('}\n}', idx) + 3)
  for (const tag of ['input', 'select', 'textarea']) {
    assert.match(block, new RegExp(`\\b${tag}\\b`), `the coarse-pointer rule must cover <${tag}>`)
  }
  const size = Number(block.match(/font-size:\s*(\d+)px/)?.[1])
  assert.ok(size >= 16, `coarse-pointer form controls need >= 16px, got ${size}`)
  // It must be unlayered: Tailwind emits `text-[11px]` inside @layer utilities,
  // and only an unlayered rule reliably outranks it. Brace depth 0 = top level.
  const before = cssSource.slice(0, idx)
  const depth = (before.match(/\{/g) || []).length - (before.match(/\}/g) || []).length
  assert.equal(depth, 0, 'the coarse-pointer font rule must sit at the top level, not inside @layer/@theme')
})

test('header tabs, menu and controls reach 44px on coarse pointers', () => {
  const tabs = appSource.match(/aria-pressed=\{view === value\}[\s\S]*?className=\{`([^`]*)`/)?.[1]
  assert.ok(tabs, 'App.tsx must render the Board/Portfolio/About tabs')
  assert.match(tabs, COARSE_TARGET, 'the view tabs need a 44px touch height')

  const menu = appSource.match(/aria-label="Toggle board controls"[\s\S]*?className="([^"]*)"/)?.[1]
  assert.ok(menu, 'App.tsx must render the header menu button')
  assert.match(menu, COARSE_TARGET, 'the icon-only header menu needs a 44px touch height')
  assert.match(menu, /\bpointer-coarse:min-w-11\b/, 'the icon-only header menu needs a 44px touch width')

  for (const label of ['Bind this board to an agent id', 'API token for mutating requests']) {
    const cls = appSource.match(new RegExp(`aria-label="${label}[^"]*"[\\s\\S]*?className="([^"]*)"`))?.[1]
    assert.ok(cls, `App.tsx must render the "${label}" input`)
    assert.match(cls, COARSE_TARGET, `the "${label}" input needs a 44px touch height`)
  }
  for (const label of ['Toggle signal rail', 'Toggle theme']) {
    // className sits before aria-label on one button and after it on the
    // other, so scan the whole <button>...</button> element around the label.
    const at = appSource.indexOf(`aria-label="${label}"`)
    const element = at < 0 ? '' : appSource.slice(appSource.lastIndexOf('<button', at), appSource.indexOf('</button>', at))
    const cls = element.match(/className="([^"]*)"/)?.[1]
    assert.ok(cls, `App.tsx must render the "${label}" button`)
    assert.match(cls, COARSE_TARGET, `the "${label}" button needs a 44px touch height`)
  }

  assert.match(headerHelpSource, COARSE_TARGET, 'the header help "i" needs a 44px touch height')
  assert.match(headerHelpSource, /\bpointer-coarse:min-w-11\b/, 'the icon-only help "i" needs a 44px touch width')
  const picker = projectPickerSource.match(/aria-haspopup="listbox"[\s\S]*?className="([^"]*)"/)?.[1]
  assert.ok(picker, 'ProjectPicker must render its trigger')
  assert.match(picker, COARSE_TARGET, 'the project picker trigger needs a 44px touch height')
  assert.match(projectPickerSource, /role="option"[\s\S]*?pointer-coarse:min-h-11/, 'project options need a 44px touch height')
})

test('every filter-row control reaches 44px on coarse pointers', () => {
  const controls = [
    ...borderedControlClasses(filtersSource),
    ...borderedControlClasses(columnColorsSource),
  ]
  assert.ok(controls.length >= 6, `expected toolbar controls, found ${controls.length}`)
  for (const cls of controls) {
    assert.match(cls, COARSE_TARGET, `every toolbar control needs a 44px coarse-pointer target, got: ${cls}`)
  }
  const search = filtersSource.match(/aria-label="Filter tasks by search term"\s*className="([^"]*)"/)?.[1]
  assert.ok(search, 'BoardFilters must render the search input')
  assert.match(search, COARSE_TARGET, 'the search input needs a 44px touch height')
  assert.match(search, /\bpointer-coarse:pr-11\b/, 'the search input must reserve room for the 44px clear button')
  const clear = filtersSource.match(/aria-label="Clear search"\s*className="([^"]*)"/)?.[1]
  assert.ok(clear, 'BoardFilters must render the clear-search button')
  assert.match(clear, /\bpointer-coarse:min-w-11\b/, 'the clear-search glyph needs a 44px touch width')
  assert.match(clear, COARSE_TARGET, 'the clear-search glyph needs a 44px touch height')
})

test('the 44px touch sizing never leaks to fine pointers (desktop density unchanged)', () => {
  for (const [name, src] of [
    ['App.tsx', appSource],
    ['BoardFilters.tsx', filtersSource],
    ['ColumnColorsControl.tsx', columnColorsSource],
    ['HeaderHelp.tsx', headerHelpSource],
    ['ProjectPicker.tsx', projectPickerSource],
  ]) {
    assert.doesNotMatch(
      src,
      /(?<![\w:-])min-[hw]-11\b/,
      `${name}: 44px min sizes must be gated behind pointer-coarse:, never unprefixed`,
    )
  }
})
