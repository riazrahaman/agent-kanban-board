// Header guards for two owner requests:
//
//  1. The Portfolio tab is HIDDEN, not removed: its entry in the header tab
//     group is commented out, while the view, its component, its libs and its
//     tests all stay. A browser whose stored view is 'portfolio' must land on
//     the board instead of a view that no tab leads to (or away from).
//
//  2. On desktop the header is three groups — brand + tabs + project picker,
//     the board filters, then count + identity + theme — and the one
//     <BoardFilters> instance is portalled into a header slot, so the board
//     gains a row of height. Off desktop (phones, touch tablets) it stays
//     inline in the board pane behind the "Filters" disclosure, as before.
//
//  3. The Export button, the Metrics toggle and the "read-only" chip are
//     hidden the same way as the Portfolio tab: commented out, code kept.
//
// Like the neighbouring layout guards these scan component source: rendered
// geometry (one header row on a wide screen, clean wrapping below that) is
// measured in a real browser by scripts/check-header-layout.mjs, which also
// checks that the tabs do not move between Board and About and that a long
// assignee name cannot widen the docked assignee select.
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

// Source with every JSX block comment removed: what actually renders.
const live = (source) => source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

const header = appSource.slice(appSource.indexOf('<header'), appSource.indexOf('</header>'))

test('desktop: the one BoardFilters instance is portalled into a header slot', () => {
  assert.equal(
    (appSource.match(/<BoardFilters\b/g) || []).length,
    1,
    'App must render exactly ONE <BoardFilters> (no duplicated controls, labels or state)',
  )
  assert.match(appSource, /import \{ createPortal \} from 'react-dom'/)
  assert.match(
    appSource,
    /\{filtersDocked && filterSlot \? createPortal\(boardFilters, filterSlot\) : null\}/,
    'on desktop the one element is portalled into the header slot',
  )
  // The portal is rendered outside <main>, so a project switch (which swaps
  // the board pane for "Loading tasks…") does not unmount the docked filters
  // and flash the header to another height.
  assert.ok(
    appSource.indexOf('createPortal(boardFilters, filterSlot)') < appSource.indexOf('<main className="app-main '),
    'the portal must not live inside the board pane',
  )
  assert.match(
    appSource,
    /const wantsDockedFilters = isDesktop && view === 'board' && !error && tasks\.length > 0/,
    'docking must not be gated on `loading`',
  )

  const slotAt = header.indexOf('data-testid="header-filter-slot"')
  assert.ok(slotAt >= 0, 'the header must carry the filter slot')
  assert.match(header, /ref=\{setFilterSlot\}\s*role="group"\s*aria-label="Board filters"/, 'the slot is a labelled group and the portal target')
  const slotClass = header.slice(slotAt).match(/className="([^"]*)"/)?.[1].split(/\s+/)
  assert.ok(slotClass, 'the slot must carry a className')
  // Below 117.5rem: always its own full-width header row, under row 1.
  assert.ok(slotClass.includes('order-last') && slotClass.includes('basis-full'), 'the slot is a full second row by default')
  // From 117.5rem: inline in row 1 with a ZERO basis, so it can shrink but
  // can never make the group after it wrap.
  for (const cls of ['min-[117.5rem]:order-none', 'min-[117.5rem]:flex-1', 'min-[117.5rem]:basis-0', 'min-w-0']) {
    assert.ok(slotClass.includes(cls), `the slot needs ${cls}`)
  }
  assert.ok(!slotClass.includes('flex-auto'), 'a content-sized basis would make the layout content-driven again')
})

test('desktop: the header reads brand + tabs + picker, then filters, then identity', () => {
  const order = [
    '<BrandMark />',
    '{isDesktop && viewTabs}',
    '{isDesktop && projectPicker}',
    'data-testid="header-filter-slot"',
    'data-testid="header-controls"',
    'placeholder="agent id"',
    'placeholder="token"',
    '<HeaderHelp />',
    'aria-label="Toggle theme"',
  ].map((needle) => [needle, header.indexOf(needle)])
  for (const [needle, at] of order) assert.ok(at >= 0, `the header must contain ${needle}`)
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i - 1][1] < order[i][1], `${order[i - 1][0]} must come before ${order[i][0]}`)
  }
  // The tabs and the picker are each ONE element placed in one of two spots.
  assert.equal((appSource.match(/<ProjectPicker\b/g) || []).length, 1, 'exactly one <ProjectPicker>')
  assert.equal((appSource.match(/aria-pressed=\{view === value\}/g) || []).length, 1, 'exactly one tab group')
  assert.match(header, /\{!isDesktop && viewTabs\}/, 'off desktop the tabs keep their place in the controls wrapper')
  assert.match(header, /data-testid="header-controls"[\s\S]*?\{!isDesktop && projectPicker\}/, 'off desktop the picker stays behind the controls disclosure')

  // The task count leads the identity group on desktop.
  const chip = header.match(/<span className="([^"]*)">\s*\{isDesktop && filtersActive \? `\$\{filteredTasks\.length\} of \$\{tasks\.length\} tasks` : `\$\{tasks\.length\} tasks`\}/)?.[1]
  assert.ok(chip, 'the header chip must be the filter-aware count on desktop')
  assert.match(chip, /\bmd:order-first\b/, 'the count comes first in the right-hand group')
})

test('row 1 cannot depend on whether the filters are docked', () => {
  // Nothing in the header may key its size on the docked state, or the tabs /
  // identity group would shift between Board and About.
  assert.doesNotMatch(header, /filters-docked/, 'no docked-state variants on header controls')
  assert.doesNotMatch(header.replace(/\{filtersDocked[^}]*\}/g, ''), /filtersDocked/, 'no control may render conditionally on filtersDocked')
  const agentInput = appSource.match(/placeholder="agent id"[\s\S]*?className="([^"]*)"/)?.[1]
  assert.ok(agentInput, 'App.tsx must render the agent id input')
  assert.match(agentInput, /\bmd:w-36\b/, 'the agent id input is a fixed 144px from md up')
  assert.doesNotMatch(agentInput, /\b(?:lg|xl|2xl):w-/, 'and does not change width at wider breakpoints')
  // A long "claim: … · error" chip may not widen the group without bound.
  const claim = appSource.match(/<span\s+className="([^"]*)"\s+title=\{`claim: /)?.[1]
  assert.ok(claim, 'the claim chip must carry a title with the full text')
  assert.match(claim, /\bmax-w-\[12rem\]/)
  assert.match(claim, /\btruncate\b/)
})

test('off desktop the filters stay inline in the board pane', () => {
  assert.match(appSource, /const isDesktop = useMediaQuery\(DESKTOP_HEADER_QUERY\)/)
  assert.match(
    uiSettingsSource,
    /export const DESKTOP_HEADER_QUERY = '\(min-width: 48rem\) and \(pointer: fine\), \(min-width: 64rem\)'/,
    'desktop = md+ with a fine pointer, or lg+; a landscape phone / portrait tablet must not dock',
  )
  assert.match(
    appSource,
    /const filtersDocked = wantsDockedFilters && filterSlot !== null/,
    'filters dock only on desktop, only while the board has tasks, and only once the slot exists',
  )
  assert.match(appSource, /\{wantsDockedFilters && \(\s*<div\s*ref=\{setFilterSlot\}/, 'the slot is rendered only while wanted')

  // Inline render: inside the board pane, above the board frame, and keyed
  // on !isDesktop (not on the slot), so desktop never mounts it inline first.
  const paneAt = appSource.indexOf('className="board-pane ')
  const inlineAt = appSource.indexOf('{!isDesktop && boardFilters}')
  assert.ok(paneAt >= 0 && inlineAt > paneAt, 'the inline filters must render inside the board pane')
  assert.ok(inlineAt < appSource.indexOf('className="board-frame '), 'and above the board frame')

  // The phone disclosure is untouched by the docked variant.
  assert.match(filtersSource, /aria-label="Toggle filters and actions"/)
  assert.match(filtersSource, /filtersOpen \? 'flex w-full basis-full' : 'hidden'/)
})

test('the docked variant sits flush in the header and cannot be widened by its content', () => {
  assert.match(filtersSource, /docked\?: boolean/, 'BoardFilters must expose a `docked` prop')
  assert.match(appSource, /<BoardFilters\s+docked=\{filtersDocked\}/, 'App must pass the docked state down')

  const root = filtersSource.match(/<div className="([^"]*flex flex-wrap[^"]*)"/)?.[1].split(/\s+/)
  assert.ok(root, 'BoardFilters must render a wrapping root row')
  assert.ok(root.includes('border-b'), 'inline: the row keeps its bottom border')
  for (const cls of [
    'data-[docked=true]:border-b-0',
    'data-[docked=true]:bg-transparent',
    'data-[docked=true]:p-0',
    // Sharing row 1 (from 117.5rem) it shrinks instead of wrapping.
    'min-[117.5rem]:data-[docked=true]:flex-nowrap',
    'group/filters',
  ]) {
    assert.ok(root.includes(cls), `docked: the root needs ${cls}`)
  }
  assert.match(filtersSource, /data-docked=\{docked \? 'true' : 'false'\}/)

  assert.match(
    filtersSource,
    /className=\{`min-w-0 flex-wrap items-center gap-2 sm:flex \$\{[^`]*\} data-\[docked=true\]:contents`\}/,
    'the control group must dissolve (display: contents) when docked',
  )
  assert.match(filtersSource, /docked \? 'min-w-\[120px\] max-w-\[10rem\]' : 'min-w-\[180px\] max-w-xs'/)

  // B1: a native select is as wide as its longest option. Docked, every
  // select is capped and allowed to shrink, so a 70-character agent id in the
  // assignee list cannot add a header row.
  const selects = [...filtersSource.matchAll(/<select\b[\s\S]*?aria-label="([^"]*)"[\s\S]*?className="([^"]*)"/g)]
  assert.equal(selects.length, 3)
  for (const [, label, cls] of selects) {
    const classes = cls.split(/\s+/)
    assert.ok(classes.includes('group-data-[docked=true]/filters:min-w-0'), `${label}: must be allowed to shrink when docked`)
    assert.ok(
      classes.some((c) => /^group-data-\[docked=true\]\/filters:max-w-\[1[02]rem\]$/.test(c)),
      `${label}: must be width-capped when docked`,
    )
  }
})

test('one task count: the docked filters render none, the header chip is filter-aware', () => {
  assert.match(
    filtersSource,
    /\{!docked && \(\s*<div className="ml-auto shrink-0[^"]*">/,
    'BoardFilters must not render its count while docked',
  )
  assert.match(filtersSource, /\{filteredCount\} of \{totalCount\} tasks/, 'the inline count stays filter-aware')
  assert.equal((header.match(/tasks\.length\} tasks/g) || []).length, 2, 'the header renders a single chip (both branches of one expression)')
  assert.match(appSource, /const filtersActive = isFilterActive\(\{/)
  assert.match(filtersSource, /const isFiltered = isFilterActive\(\{ search, priority, assignee, severity \}\)/, 'both counts use the same definition of "filtered"')
})

test('Export, Metrics and the read-only chip are commented out, not deleted', () => {
  const liveFilters = live(filtersSource)
  for (const [label, why] of [
    ['Export tasks as JSON', /security\s+issue/i],
    ['Toggle metrics dashboard', /owner's request/i],
  ]) {
    assert.ok(filtersSource.includes(`aria-label="${label}"`), `the "${label}" button code must remain in BoardFilters.tsx`)
    assert.ok(!liveFilters.includes(`aria-label="${label}"`), `the "${label}" button must not render`)
    const at = filtersSource.indexOf(`aria-label="${label}"`)
    const comment = filtersSource.slice(filtersSource.lastIndexOf('{/*', at), at)
    assert.match(comment, why, `the comment around "${label}" must say why it is hidden`)
    assert.match(comment, /un-comment/i, `the comment around "${label}" must say how to restore it`)
  }
  // Still rendered: the controls the owner kept.
  for (const label of ['Filter tasks by search term', 'Filter tasks by priority', 'Filter tasks by assignee', 'Sort tasks within columns', 'Reset all filters']) {
    assert.ok(liveFilters.includes(`aria-label="${label}"`), `"${label}" must still render`)
  }
  assert.match(liveFilters, /<ColumnColorsControl\b/, 'the Columns control must still render')

  // The export code path still compiles and is still wired.
  assert.match(appSource, /const handleExport = useCallback\(/)
  assert.match(appSource, /onExport=\{handleExport\}/)
  assert.match(filtersSource, /onExport\?: \(\) => void/)

  // Metrics: code kept, but the dashboard cannot be stuck open.
  assert.match(uiSettingsSource, /export const METRICS_TOGGLE_HIDDEN: boolean = true/)
  assert.match(appSource, /const metricsShown = METRICS_TOGGLE_HIDDEN \? false : showMetrics/)
  assert.match(appSource, /\{metricsShown && \(\s*<MetricsDashboard\b/, 'the dashboard renders only through metricsShown')
  assert.doesNotMatch(appSource, /\{showMetrics && \(/, 'the stored flag alone must not open the dashboard')
  assert.match(appSource, /import MetricsDashboard from '\.\/components\/MetricsDashboard'/)
  assert.ok(existsSync(join(CLIENT_SRC, 'components', 'MetricsDashboard.tsx')))

  // read-only chip.
  const liveApp = live(appSource)
  assert.ok(appSource.includes('{!tokenSaved && ('), 'the read-only chip code must remain in App.tsx')
  assert.ok(!liveApp.includes('{!tokenSaved && ('), 'the read-only chip must not render')
  assert.doesNotMatch(liveApp, />\s*read-only\s*</, 'no live "read-only" label in the header')
})
