// MOB-5 regression guard: the mobile-responsive invariants introduced by
// "feat(client): make the board mobile-friendly" (a9bdcd4) must not silently
// regress. This is a *source-contract* test in the same spirit as the server's
// DESIGN.md guard in server/test/kanban.test.js: it reads the real client
// source off disk and asserts the responsive contract holds.
//
// No DOM, no browser, no new dependency — plain node:test + node:assert/strict
// over file contents.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = join(__dirname, '..')

const APP_PATH = join(CLIENT_SRC, 'App.tsx')
const COLUMN_PATH = join(CLIENT_SRC, 'components', 'Column.tsx')
const BOARD_PATH = join(CLIENT_SRC, 'components', 'Board.tsx')
const TASK_CARD_PATH = join(CLIENT_SRC, 'components', 'TaskCard.tsx')
const TASK_SHEET_PATH = join(CLIENT_SRC, 'components', 'TaskSheet.tsx')
const ERROR_BOUNDARY_PATH = join(CLIENT_SRC, 'components', 'ErrorBoundary.tsx')
const CSS_PATH = join(CLIENT_SRC, 'index.css')

const appSource = readFileSync(APP_PATH, 'utf8')
const columnSource = readFileSync(COLUMN_PATH, 'utf8')
const boardSource = readFileSync(BOARD_PATH, 'utf8')
const taskCardSource = readFileSync(TASK_CARD_PATH, 'utf8')
const taskSheetSource = readFileSync(TASK_SHEET_PATH, 'utf8')
const errorBoundarySource = readFileSync(ERROR_BOUNDARY_PATH, 'utf8')
const cssSource = readFileSync(CSS_PATH, 'utf8')

// ---------------------------------------------------------------------------
// App.tsx
// ---------------------------------------------------------------------------

test('App header wraps (flex-wrap) instead of forcing a single row', () => {
  const headerTag = appSource.match(/<header\b[^>]*>/)?.[0]
  assert.ok(headerTag, 'App.tsx must render a <header> element')
  assert.match(
    headerTag,
    /\bflex-wrap\b/,
    'the <header> className must include `flex-wrap` so it wraps on narrow viewports instead of forcing one row (which caused 858px overflow on phones)',
  )
})

test('App shell uses h-screen', () => {
  assert.match(
    appSource,
    /className="[^"]*\bh-screen\b[^"]*"/,
    'the App shell must use `h-screen` (index.css upgrades it to 100dvh where supported)',
  )
})

test('App exposes a mobile-only signal-rail toggle (aria-label + md:hidden)', () => {
  const toggleClass = appSource.match(
    /<button\b[\s\S]*?aria-label="Toggle signal rail"[\s\S]*?className="([^"]*)"/,
  )?.[1]
  assert.ok(
    toggleClass,
    'App.tsx must render the signal-rail toggle <button aria-label="Toggle signal rail"> with a className',
  )
  assert.match(
    toggleClass,
    /\bmd:hidden\b/,
    'the signal-rail toggle must carry `md:hidden` so it only shows below the md breakpoint (desktop keeps the docked rail)',
  )
})

// ---------------------------------------------------------------------------
// components/Column.tsx
// ---------------------------------------------------------------------------

test('Column is responsive (w-[85vw] below md, md:w-72 from md up) and snap-start', async (t) => {
  assert.ok(
    columnSource.includes('w-[85vw]'),
    'Column.tsx must declare the phone column width literal `w-[85vw]`',
  )
  assert.ok(
    columnSource.includes('md:w-72'),
    'Column.tsx must upgrade to `md:w-72` on desktop',
  )
  assert.match(
    columnSource,
    /\bsnap-start\b/,
    'Column.tsx must include `snap-start` so scroll snapping aligns to a column edge',
  )

  // The other half of the responsive contract: a card must never be able to
  // widen its column. These live as a subtest (not a new top-level `test(`)
  // because about.test.mjs counts top-level declarations and cross-checks them
  // against aboutContent.ts's "client tests" metric — see the note there.
  await t.test('TaskCard wraps long unbroken tokens instead of widening the column', () => {
    // Regression: a title consisting of one 59-char unspaced token
    // (AOV_BUILD_PROGRESS/TEST_REPORT/HANDOVER/CLAUDE.md/CHANGELOG) grew the
    // title <p> past the card, which grew the card past the DONE column, whose
    // `overflow-y-auto` list computes overflow-x:auto and so silently scrolled
    // sideways. Measured live at 1280px: the title <p> was 242px wide but
    // overflowed by 278px, and the DONE list was clientWidth 286 /
    // scrollWidth 543. Length alone was not the cause — control titles of
    // 45/52/79 chars with a longest token of 29 chars never overflowed.
    //
    // `break-words` (overflow-wrap:break-word) alone is insufficient: it does
    // not break a token that exceeds the line box in every engine, so
    // `[overflow-wrap:anywhere]` is required too. `overflow-wrap:anywhere`
    // uniquely also shrinks min-content size, which is what stops the card
    // from forcing the column wider. `break-all` would break the token as well
    // but discards the preference for breaking at spaces first, so it is not
    // used.
    const titleTag = taskCardSource.match(/<p\b[^>]*>/)?.[0]
    assert.ok(titleTag, 'TaskCard.tsx must render the title <p>')
    assert.match(
      titleTag,
      /\[overflow-wrap:anywhere\]/,
      'the title <p> must carry `[overflow-wrap:anywhere]` so one long unspaced token breaks inside the card',
    )
    assert.match(
      titleTag,
      /\bbreak-words\b/,
      'the title <p> must carry `break-words` so titles with spaces still break at spaces first',
    )

    // Task ids are unspaced tokens too — but an id is an IDENTIFIER, not prose,
    // and wrapping it was a regression. `overflow-wrap:anywhere` lowers the
    // element's min-content size; inside the header's flex row, where the span
    // had `min-width:auto` and `flex-shrink:1`, that let the span absorb nearly
    // all the shrink and collapse the 28-char `init-agent-investment-advisor`
    // into a ~30px sliver wrapped character-by-character over 11 lines (header
    // row 176px tall vs 21px for a normal card). 64 of 142 live cards had a
    // multi-line header id. The id must therefore stay on ONE line and
    // ellipsise, with the badge group pinned so it cannot be squeezed.
    const idTag = taskCardSource.match(/<span[^>]*>\s*\{task\.id\}/)?.[0]
    assert.ok(idTag, 'TaskCard.tsx must render the task id <span>{task.id}</span>')
    assert.match(
      idTag,
      /\btruncate\b/,
      'the task id <span> must carry `truncate` so an over-long id ellipsises on ONE line instead of wrapping',
    )
    assert.match(
      idTag,
      /\bmin-w-0\b/,
      'the task id <span> must carry `min-w-0`: without it, `min-width:auto` lets the flex row shrink it to a sliver',
    )
    assert.match(
      idTag,
      /\bflex-1\b/,
      'the task id <span> must carry `flex-1` so it claims the row rather than being squeezed by the badge group',
    )
    assert.doesNotMatch(
      idTag,
      /\[overflow-wrap:anywhere\]/,
      'the task id <span> must NOT carry `[overflow-wrap:anywhere]` — it lowers min-content and caused the sliver regression',
    )
    assert.match(
      idTag,
      /title=\{task\.id\}/,
      'the task id <span> must expose the full value via `title` since it can be ellipsised',
    )
    // v2.9.1: the badge group is pinned (`shrink-0`) so it can never squeeze
    // the id, and on phones it takes its own full-width line (`w-full
    // sm:w-auto`) so it stops competing with the id on an 85vw column.
    const badgeGroup = taskCardSource.match(
      /<div className="([^"]*shrink-0[^"]*items-center gap-1\.5[^"]*)"/,
    )?.[1]
    assert.ok(badgeGroup, 'the card header must render a badge group')
    assert.match(
      badgeGroup,
      /\bshrink-0\b/,
      'the header badge group must carry `shrink-0` so it cannot squeeze the id',
    )
    assert.match(
      badgeGroup,
      /\bw-full\b[^"]*\bsm:w-auto\b/,
      'the header badge group must stack full-width on phones (`w-full sm:w-auto`) so it does not compete with the id',
    )

    assert.doesNotMatch(
      taskCardSource,
      /\bbreak-all\b/,
      'TaskCard.tsx must not use `break-all`: it breaks mid-word even when a space break was available',
    )

    // A 9th site, found by sweeping the live board rather than by reading the
    // drawer: the card's assigned_agent span. Measured 266px past its row at
    // 1280px (row 242px wide, span grew to 508px), and the row is a flex row
    // with no wrapping, so the card itself was pushed wider.
    //
    // An agent id is an IDENTIFIER, so the same correction as the header id
    // applies: it must stay on one line and ellipsise rather than wrap, or the
    // flex row shrinks it into a sliver. The full value stays reachable via
    // `title`, and the sibling issues badge is pinned with `shrink-0`.
    const agentCls = taskCardSource.match(
      /className="([^"]*)"[^>]*>\s*\{task\.assigned_agent\}/,
    )?.[1]
    assert.ok(agentCls, 'TaskCard.tsx must render the assigned_agent <span>')
    assert.match(
      agentCls,
      /\btruncate\b/,
      'the TaskCard assigned_agent <span> must carry `truncate`: an agent id is an identifier and must stay on ONE line',
    )
    assert.match(
      agentCls,
      /\bmin-w-0\b/,
      'the TaskCard assigned_agent <span> must carry `min-w-0` so the flex row cannot shrink it to a sliver',
    )
    assert.doesNotMatch(
      agentCls,
      /\[overflow-wrap:anywhere\]/,
      'the TaskCard assigned_agent <span> must NOT carry `[overflow-wrap:anywhere]`: it lowers min-content and invites the sliver regression',
    )
    assert.match(
      taskCardSource,
      /title=\{task\.assigned_agent\}/,
      'the assigned_agent <span> must expose the full value via `title` since it can be ellipsised',
    )
    assert.match(
      taskCardSource,
      /shrink-0 font-mono text-\[10px\] tabular-nums text-warn/,
      'the card issues badge must carry `shrink-0` so it cannot squeeze the agent id',
    )
  })
})

// ---------------------------------------------------------------------------
// components/TaskSheet.tsx — the task detail drawer
// ---------------------------------------------------------------------------

// The same long-unbroken-token defect fixed on TaskCard was found on 8 more
// render sites in the drawer. Measured live at 1280px by injecting
// `AOV_BUILD_PROGRESS/TEST_REPORT/HANDOVER/CLAUDE.md/CHANGELOG_SUMMARY_AND_NOTES`
// (no hyphens, no spaces — slashes/underscores are not break opportunities) and
// comparing the text node's widest Range rect against the parent's content-box
// right edge. Overflows before the fix, in px:
//   id 213, title 405, project 81, assigned_agent 81,
//   description 270, stage_owners 99, log.agent_id 121, log.message 205.
//
// One systemic `p, span, h1…{overflow-wrap:anywhere}` rule was measured and
// REJECTED: it also re-wrapped unrelated badges that were fine (the status
// badge `BACKLOG` broke mid-word to 2 lines, 19px -> 34px tall, at normal
// content), because a global rule cannot tell a layout container from a leaf.
// So each site carries the class explicitly, mirroring the TaskCard fix.
test('TaskSheet wraps every unbroken-token render site (and not the nowrap ones)', async (t) => {
  // Each entry: a stable JSX pattern whose captured className is asserted. The
  // pattern matches the element even when the class is absent, so the assertion
  // below is what fails — the guard cannot pass vacuously.
  //
  // `kind` splits the two contracts. PROSE (title, description, log message,
  // raw error text) must WRAP: one long unspaced token would otherwise paint
  // outside the drawer. IDENTIFIERS (task id, project slug, agent ids) must NOT
  // wrap — they must stay on ONE line and ellipsise, because wrapping lowers
  // min-content size and a flex row will then shrink the element into a sliver.
  // That is exactly the 2.3.8 regression: `init-agent-investment-advisor`
  // collapsed to 30px wide, wrapped character-by-character over 11 lines.
  const SITES = [
    ['id', /className="([^"]*)"[^>]*>\s*\{task\.id\}/, 213, 'identifier'],
    ['title', /className="([^"]*)"[^>]*>\s*\{decodeStored\(task\.title\)\}/, 405, 'prose'],
    ['project', /className="([^"]*)"[^>]*>\s*\{task\.project\}/, 81, 'identifier'],
    ['assigned_agent', /className="([^"]*)"[^>]*>\s*\{task\.assigned_agent\}/, 81, 'identifier'],
    ['description', /className="([^"]*)"[^>]*>\s*\{decodeStored\(task\.description\)/, 270, 'prose'],
    ['stage_owners', /className="([^"]*)"[^>]*>\s*\{formatStageOwners\(task\.stage_owners\)\}/, 99, 'identifier'],
    ['log.agent_id', /className="([^"]*)"[^>]*>\s*\{log\.agent_id\}/, 121, 'identifier'],
    ['log.message', /className="([^"]*)"[^>]*>\s*\{decodeStored\(log\.message\)\}/, 205, 'prose'],
  ]

  let verified = 0
  for (const [name, pattern, measuredOverflowPx, kind] of SITES) {
    const cls = taskSheetSource.match(pattern)?.[1]
    assert.ok(
      cls,
      `TaskSheet.tsx must still render the \`${name}\` element (pattern ${pattern}) — ` +
        'if this node was renamed, update this guard rather than dropping the site',
    )
    if (kind === 'prose') {
      assert.match(
        cls,
        /\[overflow-wrap:anywhere\]/,
        `TaskSheet \`${name}\` is prose and must carry \`[overflow-wrap:anywhere]\`: it overflowed by ${measuredOverflowPx}px ` +
          'at 1280px with one long unspaced token, because `anywhere` (unlike `break-word`) also shrinks ' +
          "the element's min-content size",
      )
      assert.match(
        cls,
        /\bbreak-words\b/,
        `TaskSheet \`${name}\` must also carry \`break-words\` so content with spaces breaks at spaces first`,
      )
    } else {
      assert.match(
        cls,
        /\btruncate\b/,
        `TaskSheet \`${name}\` is an IDENTIFIER (overflowed ${measuredOverflowPx}px before the fix) and must carry \`truncate\` ` +
          'so it stays on ONE line and ellipsises instead of wrapping',
      )
      assert.match(
        cls,
        /\bmin-w-0\b/,
        `TaskSheet \`${name}\` must carry \`min-w-0\`: in a flex row, \`min-width:auto\` lets it be squeezed into a sliver`,
      )
      assert.doesNotMatch(
        cls,
        /\[overflow-wrap:anywhere\]/,
        `TaskSheet \`${name}\` must NOT carry \`[overflow-wrap:anywhere]\`: wrapping an identifier lowers min-content and caused the sliver regression`,
      )
    }
    verified += 1
  }
  assert.equal(verified, 8, 'all 8 measured drawer sites must be covered by this guard')

  // Every identifier site must also expose its full value, since it ellipsises.
  // The tooltip may carry a label prefix (e.g. `Project: ${task.project}`), so
  // match the interpolated expression rather than the whole attribute value.
  for (const [name, pattern, , kind] of SITES) {
    if (kind !== 'identifier') continue
    const expr = { id: 'task\\.id', project: 'task\\.project', assigned_agent: 'task\\.assigned_agent',
      stage_owners: 'formatStageOwners\\(task\\.stage_owners\\)', 'log.agent_id': 'log\\.agent_id' }[name]
    assert.match(
      taskSheetSource,
      new RegExp(`title=\\{[^}]*${expr}[^}]*\\}`),
      `TaskSheet \`${name}\` must expose the full value via \`title\` because it can be ellipsised`,
    )
  }

  // The timestamp that shares the log-agent flex row must be pinned, or it can
  // squeeze the agent badge instead.
  assert.match(
    taskSheetSource,
    /shrink-0 font-mono text-\[10px\] tabular-nums text-ink/,
    'the log timestamp must carry `shrink-0` so it cannot squeeze the agent id',
  )

  // `break-all` would also stop the overflow but breaks mid-word even when a
  // space break was available, so it must not be used as the fix.
  assert.doesNotMatch(
    taskSheetSource,
    /\bbreak-all\b/,
    'TaskSheet.tsx must not use `break-all`',
  )

  // The other end of the same class of bug: a node that renders a raw thrown
  // message. `err.message` is arbitrary text — it can be one unbroken
  // path/URL/identifier — and this `p` sits in a `p-4` box with no clipping,
  // so an unbroken message painted past the form edge.
  const submitErr = taskSheetSource.match(
    /className="([^"]*)"[^>]*>\{error\}/,
  )?.[1]
  assert.ok(submitErr, 'TaskSheet.tsx must render {error && <p>{error}</p>}')
  assert.match(
    submitErr,
    /\[overflow-wrap:anywhere\]/,
    'the failed-submit error <p> must carry `[overflow-wrap:anywhere]` for a raw unbroken message',
  )
  assert.match(
    submitErr,
    /\bbreak-words\b/,
    'the failed-submit error <p> must also carry `break-words` for messages with spaces',
  )

  // The one drawer node that must NOT be wrapped: the metadata <pre> already
  // scrolls itself (`overflow-auto`), and wrapping it would reformat JSON.
  const preTag = taskSheetSource.match(/<pre className="([^"]*)">/)?.[1]
  assert.ok(preTag, 'TaskSheet.tsx must render the metadata <pre>')
  assert.match(preTag, /\boverflow-auto\b/, 'the metadata <pre> must keep scrolling itself')
  assert.doesNotMatch(
    preTag,
    /overflow-wrap/,
    'the metadata <pre> must NOT be wrapped: it scrolls, and wrapping would reformat the JSON',
  )

  // An already-`truncate` node keeps nowrap and is clipped, so wrapping it would
  // replace an ellipsis with a wrapped (taller) box.
  await t.test('nowrap/truncate nodes are left to ellipsis', () => {
    for (const cls of [...taskSheetSource.matchAll(/className="([^"]*\btruncate\b[^"]*)"/g)].map((m) => m[1])) {
      assert.doesNotMatch(
        cls,
        /overflow-wrap/,
        `a \`truncate\` node in TaskSheet must not gain overflow-wrap: nowrap already wins, and the point of truncate here is the ellipsis (${cls})`,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// components/ErrorBoundary.tsx
// ---------------------------------------------------------------------------

test('ErrorBoundary wraps a raw thrown message so it cannot paint outside the boundary', () => {
  // This node renders `error.message` verbatim — an arbitrary thrown string,
  // which may be a single unbroken path/URL/identifier. It sits inside a
  // `p-4` box with no overflow clipping, so an unbroken message painted past
  // the panel edge.
  const msgTag = errorBoundarySource.match(
    /<p className="([^"]*)">\s*\{this\.state\.error\.message\}/,
  )?.[1]
  assert.ok(msgTag, 'ErrorBoundary.tsx must render {this.state.error.message}')
  assert.match(
    msgTag,
    /\[overflow-wrap:anywhere\]/,
    'the error message <p> must carry `[overflow-wrap:anywhere]` for a raw unbroken token',
  )
  assert.match(
    msgTag,
    /\bbreak-words\b/,
    'the error message <p> must also carry `break-words` for messages with spaces',
  )
})

// ---------------------------------------------------------------------------
// components/Board.tsx
// ---------------------------------------------------------------------------

test('Board scroll container snaps horizontally and scrolls x (snap-x, scroll-pl-4, overflow-x-auto)', () => {
  const scrollContainer = boardSource.match(/<div\b[^>]*ref=\{scrollRef\}[^>]*>/)?.[0]
  assert.ok(scrollContainer, 'Board.tsx must render the scroll container via ref={scrollRef}')
  assert.match(
    scrollContainer,
    /\bsnap-x\b/,
    'the horizontal scroll container must include `snap-x`',
  )
  assert.match(
    scrollContainer,
    /\bscroll-pl-4\b/,
    'the horizontal scroll container must include `scroll-pl-4` so the first column snaps with the padding',
  )
  assert.match(
    scrollContainer,
    /\boverflow-x-auto\b/,
    'the horizontal scroll container must include `overflow-x-auto`',
  )
})

// ---------------------------------------------------------------------------
// index.css
// ---------------------------------------------------------------------------

test('index.css overrides .h-screen inside @supports (height:100dvh)', () => {
  assert.match(
    cssSource,
    /@supports\s*\(\s*height:\s*100dvh\s*\)\s*\{[\s\S]*?\.h-screen\s*\{[\s\S]*?height:\s*100dvh/,
    'index.css must contain an `@supports (height:100dvh)` block that overrides `.h-screen` with `height: 100dvh` (100vh overflows under mobile URL bars)',
  )
})

// ---------------------------------------------------------------------------
// Banned visual patterns across all client TS/TSX source
// ---------------------------------------------------------------------------

// Banned tokens are assembled from fragments on purpose: this test file itself
// must not contain the literal banned strings.
const BANNED_PATTERNS = [
  { name: 'shad' + 'ow-', re: new RegExp('shad' + 'ow-', 'i') },
  { name: 'rounded' + '-full', re: new RegExp('rounded' + '-full', 'i') },
  { name: 'In' + 'ter', re: new RegExp('\\bIn' + 'ter\\b', 'i') },
  { name: 'Rob' + 'oto', re: new RegExp('\\bRob' + 'oto\\b', 'i') },
]

function collectTsSources(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectTsSources(full))
    else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')))
      out.push(full)
  }
  return out
}

test('client .ts/.tsx source stays free of banned visual patterns', () => {
  const files = collectTsSources(CLIENT_SRC)
  assert.ok(files.length > 0, 'expected to discover client TS/TSX sources')
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const { name, re } of BANNED_PATTERNS) {
      assert.doesNotMatch(
        source,
        re,
        `${file.includes(CLIENT_SRC) ? file.slice(CLIENT_SRC.length + 1) : file} must not contain the banned visual pattern \`${name}\``,
      )
    }
  }
})
