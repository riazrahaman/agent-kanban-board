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
