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

test('the toolbar root wraps and every control group can shrink', () => {
  const root = filtersSource.match(/<div className="([^"]*flex flex-wrap[^"]*)"/)?.[1]
  assert.ok(root, 'BoardFilters must render a wrapping root row')
  assert.match(root, /\bflex-wrap\b/, 'the toolbar root must wrap')

  // The control group (the container holding the selects/buttons) must carry
  // min-w-0 so flex is allowed to shrink it below its content width.
  assert.match(
    filtersSource,
    /className="flex min-w-0 flex-wrap items-center gap-2"/,
    'the toolbar control group must be `flex min-w-0 flex-wrap items-center gap-2`',
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
