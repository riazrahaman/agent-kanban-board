// Header guards for two owner requests:
//
//  1. The Portfolio tab is HIDDEN, not removed: its entry in the header tab
//     group is commented out, while the view, its component, its libs and its
//     tests all stay. A browser whose stored view is 'portfolio' must land on
//     the board instead of a view that no tab leads to (or away from).
//
//  2. On desktop (md and up) the board filter row is DOCKED into the header:
//     the one <BoardFilters> instance is portalled into a header slot, so the
//     board gains a row of height. Below md it stays inline in the board pane
//     behind the phone "Filters" disclosure, exactly as before.
//
// Like the neighbouring layout guards these scan component source: rendered
// geometry (one header row on a wide screen, clean wrapping below that) is
// measured in a real browser by scripts/check-header-layout.mjs.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = join(__dirname, '..')

const appSource = readFileSync(join(CLIENT_SRC, 'App.tsx'), 'utf8')
const filtersSource = readFileSync(join(CLIENT_SRC, 'components', 'BoardFilters.tsx'), 'utf8')
const uiSettingsSource = readFileSync(join(CLIENT_SRC, 'lib', 'uiSettings.ts'), 'utf8')

/** The `[...] as const` tuple list the header tab group maps over. */
function tabGroupSource() {
  const start = appSource.indexOf("['board', 'Board'")
  const end = appSource.indexOf('] as const', start)
  assert.ok(start >= 0 && end > start, 'App.tsx must render the header tab group from a tuple list')
  return appSource.slice(start, end)
}

test('the Portfolio tab entry is commented out, not deleted', () => {
  const tabs = tabGroupSource()
  assert.match(
    tabs,
    /^\s*\/\/\s*\['portfolio', 'Portfolio', [^\n]*\],\s*$/m,
    'the Portfolio tab entry must stay in the tab list as a commented-out line so it can be restored',
  )
  const live = tabs
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  assert.doesNotMatch(live, /portfolio/i, 'no live tab entry may point at the portfolio view')
  assert.match(live, /\['board', 'Board'/, 'the Board tab stays')
  assert.match(live, /\['about', 'About'/, 'the About tab stays')
  assert.match(tabs, /hidden at the owner's request/i, 'the comment must say why the tab is hidden')
  assert.match(tabs, /restore/i, 'the comment must say how to restore the tab')
})

test('the tab group no longer announces a portfolio view', () => {
  const label = appSource.match(/role="group"\s*aria-label="([^"]*)"/)?.[1]
  assert.ok(label, 'the header tab group must carry an aria-label')
  assert.doesNotMatch(label, /portfolio/i, 'the tab group label must not name a view it cannot reach')
  assert.match(label, /board/i)
  assert.match(label, /about/i)
})

test('the Portfolio view itself is kept intact behind the hidden tab', () => {
  assert.ok(existsSync(join(CLIENT_SRC, 'components', 'Portfolio.tsx')), 'Portfolio.tsx must remain')
  assert.ok(existsSync(join(CLIENT_SRC, 'lib', 'portfolioMetrics.ts')), 'portfolioMetrics.ts must remain')
  assert.ok(existsSync(join(CLIENT_SRC, 'lib', 'portfolioMetrics.test.mjs')), 'its tests must remain')
  assert.match(appSource, /import Portfolio from '\.\/components\/Portfolio'/, 'App.tsx must still import Portfolio')
  assert.match(appSource, /\{view === 'portfolio' && \(\s*<Portfolio\b/, 'the portfolio render branch must remain')
  assert.match(appSource, /useState<'board' \| 'portfolio' \| 'about'>/, "the view union must still include 'portfolio'")
  assert.match(uiSettingsSource, /export type AppView = 'board' \| 'portfolio' \| 'about'/)
})

test("a stored 'portfolio' view is coerced to the board where App reads it", () => {
  assert.match(
    appSource,
    /useState<'board' \| 'portfolio' \| 'about'>\(\(\) => resolveVisibleView\(readStoredView\(\)\)\)/,
    'App must pass the stored view through resolveVisibleView so a hidden view cannot strand the browser',
  )
  assert.match(
    uiSettingsSource,
    /export const HIDDEN_VIEWS: readonly AppView\[\] = \['portfolio'\]/,
    "uiSettings must list 'portfolio' as the hidden view",
  )
})

test('desktop: the one BoardFilters instance is portalled into a header slot', () => {
  assert.equal(
    (appSource.match(/<BoardFilters\b/g) || []).length,
    1,
    'App must render exactly ONE <BoardFilters> (no duplicated controls, labels or state)',
  )
  assert.match(appSource, /import \{ createPortal \} from 'react-dom'/)
  assert.match(
    appSource,
    /\{filtersDocked && filterSlot \? createPortal\(boardFilters, filterSlot\) : boardFilters\}/,
    'the same element must go either into the header slot or inline in the board pane, never both',
  )

  // The slot sits inside the header, after the brand block and before the
  // right-hand controls.
  const header = appSource.slice(appSource.indexOf('<header'), appSource.indexOf('</header>'))
  const slotAt = header.indexOf('data-testid="header-filter-slot"')
  assert.ok(slotAt >= 0, 'the header must carry the filter slot')
  assert.ok(header.indexOf('<BrandMark />') < slotAt, 'the slot must come after the brand block')
  assert.ok(slotAt < header.indexOf('role="group"'), 'the slot must come before the view tabs')
  assert.ok(slotAt < header.indexOf('data-testid="header-controls"'), 'the slot must come before the header controls')
  assert.match(header, /ref=\{setFilterSlot\}/, 'the slot element is what the portal targets')

  const slotClass = header.slice(slotAt).match(/className="([^"]*)"/)?.[1]
  assert.ok(slotClass, 'the slot must carry a className')
  assert.match(slotClass, /\bflex-auto\b/, 'the slot needs a content-sized flex basis so it wraps as a unit instead of overflowing')
  assert.match(slotClass, /\bmin-w-0\b/, 'the slot must be allowed to shrink (and wrap inside) on a line of its own')

  const headerTag = appSource.match(/<header\b[^>]*>/)?.[0]
  assert.match(headerTag, /\bflex-wrap\b/, 'the header must wrap so the filter group can drop to a second line')
})

test('phones: the filters stay inline in the board pane (docking is md and up only)', () => {
  assert.match(
    appSource,
    /const isDesktop = useMediaQuery\('\(min-width: 48rem\)'\)/,
    'docking must key on the md breakpoint (48rem), the same one the rest of the shell uses',
  )
  assert.match(appSource, /const wantsDockedFilters = isDesktop && boardReady/)
  assert.match(
    appSource,
    /const filtersDocked = wantsDockedFilters && filterSlot !== null/,
    'filters dock only on desktop, only while the board is showing them, and only once the slot exists',
  )
  // The slot is not even rendered unless docking is wanted, and is `hidden`
  // below md, so the phone header is laid out exactly as without it.
  assert.match(appSource, /\{wantsDockedFilters && \(\s*<div\s*ref=\{setFilterSlot\}/)
  const slotClass = appSource
    .slice(appSource.indexOf('data-testid="header-filter-slot"'))
    .match(/className="([^"]*)"/)?.[1]
  assert.match(slotClass, /(?:^|\s)hidden(?:\s|$)/, 'the slot must be hidden by default')
  assert.match(slotClass, /\bmd:block\b/, 'the slot may only appear from md up')

  // The inline render lives in the board pane, above the board frame.
  const paneAt = appSource.indexOf('className="board-pane ')
  const inlineAt = appSource.indexOf('createPortal(boardFilters, filterSlot) : boardFilters')
  assert.ok(paneAt >= 0 && inlineAt > paneAt, 'the inline filters must render inside the board pane')
  assert.ok(inlineAt < appSource.indexOf('className="board-frame '), 'and above the board frame')

  // The phone disclosure is untouched by the docked variant.
  assert.match(filtersSource, /aria-label="Toggle filters and actions"/)
  assert.match(filtersSource, /filtersOpen \? 'flex w-full basis-full' : 'hidden'/)
})

test('the docked variant sits flush in the header (no strip of its own)', () => {
  assert.match(filtersSource, /docked\?: boolean/, 'BoardFilters must expose a `docked` prop')
  assert.match(appSource, /<BoardFilters\s+docked=\{filtersDocked\}/, 'App must pass the docked state down')

  const root = filtersSource.match(/<div className="([^"]*flex flex-wrap[^"]*)"/)?.[1]
  assert.ok(root, 'BoardFilters must render a wrapping root row')
  assert.match(root, /\bborder-b\b/, 'inline: the row keeps its bottom border')
  for (const cls of ['data-[docked=true]:border-b-0', 'data-[docked=true]:bg-transparent', 'data-[docked=true]:p-0']) {
    assert.ok(root.split(/\s+/).includes(cls), `docked: the root must drop its strip via ${cls}`)
  }
  assert.match(filtersSource, /data-docked=\{docked \? 'true' : 'false'\}/)

  // Docked, the secondary controls flow in the same wrapping row as the
  // search box and the count instead of wrapping as one block.
  assert.match(
    filtersSource,
    /className=\{`min-w-0 flex-wrap items-center gap-2 sm:flex \$\{[^`]*\} data-\[docked=true\]:contents`\}/,
    'the control group must dissolve (display: contents) when docked',
  )
  // And the search box is narrower than the inline 180px / max-w-xs one.
  assert.match(filtersSource, /docked \? 'min-w-\[120px\] max-w-\[10rem\]' : 'min-w-\[180px\] max-w-xs'/)
})

test('only one task count shows while the filters are docked in the header', () => {
  const chip = appSource.match(/\{!filtersDocked && \(\s*<span className="([^"]*)">\s*\{tasks\.length\} tasks\s*<\/span>\s*\)\}/)
  assert.ok(chip, 'the header "N tasks" chip must render only when the filters are NOT docked')
  assert.equal(
    (appSource.match(/\{tasks\.length\} tasks/g) || []).length,
    1,
    'App must not render a second plain task count',
  )
  // The filter-aware count is the one that stays.
  assert.match(filtersSource, /\{filteredCount\} of \{totalCount\} tasks/)
  assert.match(filtersSource, /<span>\{totalCount\} tasks<\/span>/)
})

test('the header narrows the agent id only while the filters are docked', () => {
  const headerTag = appSource.match(/<header\b[^>]*>/)?.[0]
  assert.match(headerTag, /data-filters-docked=\{filtersDocked \? 'true' : 'false'\}/)
  assert.match(headerTag, /\bgroup\/header\b/, 'the header must be a named group for the docked variants')
  const agentInput = appSource.match(/placeholder="agent id"[\s\S]*?className="([^"]*)"/)?.[1]
  assert.ok(agentInput, 'App.tsx must render the agent id input')
  assert.ok(
    agentInput.split(/\s+/).includes('group-data-[filters-docked=true]/header:w-32'),
    'the agent id input must narrow to 128px while the filters are docked',
  )
})
