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
const ABOUT_PATH = join(CLIENT_SRC, 'components', 'About.tsx')
const CSS_PATH = join(CLIENT_SRC, 'index.css')

const appSource = readFileSync(APP_PATH, 'utf8')
const columnSource = readFileSync(COLUMN_PATH, 'utf8')
const boardSource = readFileSync(BOARD_PATH, 'utf8')
const taskCardSource = readFileSync(TASK_CARD_PATH, 'utf8')
const taskSheetSource = readFileSync(TASK_SHEET_PATH, 'utf8')
const errorBoundarySource = readFileSync(ERROR_BOUNDARY_PATH, 'utf8')
const aboutSource = readFileSync(ABOUT_PATH, 'utf8')
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

test('App header inputs expand on tablet/desktop viewports (sm:w-64 agentDraft, sm:w-36 tokenDraft)', () => {
  const agentInput = appSource.match(/placeholder="agent id"[\s\S]*?className="([^"]*)"/)?.[1]
  assert.ok(agentInput, 'App.tsx must render agentDraft input')
  assert.match(
    agentInput,
    /\bsm:w-64\b/,
    'agentDraft input must use sm:w-64 so placeholder is not truncated on tablet viewports',
  )

  // v2.17.0: tokenDraft's className became a template literal (it now also
  // carries a bugReportEnabled-only width reduction — see App.tsx's
  // "bug icon" comment on this input), so it is no longer a plain
  // `className="..."` string; match either form. The placeholder itself is
  // "token" (round 4 — shortened from "api token" so it is never clipped
  // once the clawback above shrinks this input on a coarse pointer; see
  // the test below for the dedicated regression guard).
  const tokenInputMatch = appSource.match(
    /placeholder="token"[\s\S]*?className=(?:"([^"]*)"|\{`([^`]*)`\})/,
  )
  const tokenInput = tokenInputMatch?.[1] ?? tokenInputMatch?.[2]
  assert.ok(tokenInput, 'App.tsx must render tokenDraft input')
  assert.match(
    tokenInput,
    /\bsm:w-36\b/,
    'tokenDraft input must use sm:w-36 on tablet/desktop viewports',
  )
})

test('tokenDraft width reduction (bug-icon slack absorption) stays bounded and resets above xl', () => {
  // v2.17.0 round 3 (tester-caught WebKit header-wrap defect, fixed via
  // App.tsx + scripts/check-header-layout.mjs): the icon's own footprint
  // (27px mouse / 44px coarse) has to come from somewhere in the
  // header-controls row or it wraps one line earlier with the icon on than
  // off (verified with a live Chromium + WebKit sweep, see CHANGELOG
  // 2.17.0). This is scoped to md (the only band where the row is tight)
  // and reset at xl (the row has slack again there) so a regression that
  // widens the scope — or drops the reset — doesn't silently reintroduce a
  // ON-vs-OFF mismatch outside the one band it was measured for.
  // The input's className interpolates a `tokenInputBugIconClawback` const
  // (computed once above the component's `return`, with the full mechanism
  // comment) rather than inlining the ternary — resolve that const's
  // bugReportEnabled-true value from source.
  const tokenInput = appSource.match(
    /const tokenInputBugIconClawback = bugReportEnabled\s*\n\s*\?\s*'([^']*)'/,
  )?.[1]
  assert.ok(tokenInput, 'App.tsx must declare the tokenInputBugIconClawback const')
  assert.match(
    tokenInput,
    /(?:^|\s)md:w-\[calc\(9rem-27px\)\](?:\s|$)/,
    'tokenDraft must cut 27px (the mouse-pointer bug icon width) from its md width',
  )
  assert.match(
    tokenInput,
    /(?:^|\s)md:pointer-coarse:w-\[calc\(9rem-44px\)\](?:\s|$)/,
    'tokenDraft must cut 44px (the coarse-pointer bug icon width) from its md width under pointer-coarse',
  )
  assert.match(
    tokenInput,
    /\bxl:w-36\b/,
    'tokenDraft must reset to w-36 at xl — the row has slack again there, so the reduction must not persist',
  )
})

test('tokenDraft placeholder is short enough to survive the bug-icon width clawback, in BOTH feature states', () => {
  // v2.17.0 round 4 (tester-caught clip, coarse pointer, 768-1100px,
  // feature ON): "api token" needed ~86-89px at 16px mono but this input's
  // inner width drops to ~84px once bugReportEnabled's clawback (see the
  // test above) shrinks it to 100px on a coarse pointer — a 2-5px clip.
  // "token" is unconditional (not inside the bugReportEnabled ternary)
  // precisely so the placeholder's own width is never a second,
  // feature-dependent variable in the ON==OFF header invariant: it must
  // read the same regardless of whether the clawback is active.
  assert.match(
    appSource,
    /placeholder="token"/,
    'tokenDraft placeholder must be the short "token" (not "api token", which clips once the bug-icon clawback shrinks the input)',
  )
  assert.doesNotMatch(
    appSource,
    /placeholder="api token"/,
    'the old, longer "api token" placeholder must not reappear',
  )
  // The accessible name stays fully descriptive — only the visible
  // placeholder shortened.
  const tokenInputBlock = appSource.slice(
    appSource.indexOf('placeholder="token"'),
    appSource.indexOf('placeholder="token"') + 400,
  )
  assert.match(
    tokenInputBlock,
    /aria-label="API token for mutating requests"/,
    'tokenDraft must keep its full, descriptive aria-label even though the placeholder shortened',
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
  // GH #87 regression: v2.15.10 gave this element touch-action: pan-y and
  // Board.tsx's scroll container touch-action: pan-x. Per the touch-action
  // spec, the *effective* touch-action on a touched element is the
  // intersection of its own touch-action and every ancestor's — intersecting
  // pan-y (child) with pan-x (ancestor) resolves to none, which suppressed
  // ALL swiping (horizontal board scroll *and* vertical column scroll) on
  // touch devices. The fix drops both single-axis declarations entirely (the
  // browser's default touch-action: auto already lets each scroll container
  // claim whichever axis it actually scrolls) and uses overscroll-y-contain
  // instead, purely to stop vertical column scrolling from chaining to the
  // body — a non-conflicting, same-axis-only rule.
  assert.match(
    columnSource,
    /\boverscroll-y-contain\b/,
    'Column.tsx task list must include `overscroll-y-contain` so vertical scrolling does not chain to the page',
  )
  // The two Tailwind class names below are assembled from concatenated
  // string fragments rather than written out as a single contiguous literal,
  // because Tailwind v4's content scanner has no JS parser — it just scans
  // raw file bytes for candidate class names — so writing the banned names
  // out in full here (even inside a regex) would itself get scanned and emit
  // an unused utility into the compiled CSS.
  const bannedPanY = new RegExp('\\b' + 'touch-' + 'pan-y\\b')
  const bannedPanX = new RegExp('\\b' + 'touch-' + 'pan-x\\b')
  assert.doesNotMatch(
    columnSource,
    bannedPanY,
    'Column.tsx must not reintroduce touch-action: pan-y — intersected with Board.tsx\'s horizontal pan rule this resolves to touch-action: none and blocks all swiping (GH #87)',
  )
  assert.doesNotMatch(
    columnSource,
    bannedPanX,
    'Column.tsx must not carry touch-action: pan-x either — any single-axis touch-action here can conflict with Board.tsx\'s scroll container',
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
  assert.match(
    scrollContainer,
    /\bsnap-proximity\b/,
    'the horizontal scroll container must include `snap-proximity`',
  )
  // GH #87 regression — see the matching note in the Column.tsx test above:
  // touch-action: pan-x here, intersected with Column.tsx's former
  // touch-action: pan-y, resolved to an effective touch-action: none and
  // blocked all touch swiping/scrolling. overscroll-x-contain replaces it: it
  // only stops the board's own horizontal scroll from chaining up to a parent
  // scroller (which, left unchecked, is one way an edge swipe can get
  // reinterpreted as iOS's back/forward navigation gesture), and it does not
  // constrain which axis can pan.
  assert.match(
    scrollContainer,
    /\boverscroll-x-contain\b/,
    'the horizontal scroll container must include `overscroll-x-contain` to discourage its scroll from chaining into iOS edge-swipe navigation',
  )
  // See the matching note in the Column.tsx test above: these are assembled
  // from concatenated string fragments, not written out as a contiguous
  // literal, so Tailwind v4's text-based content scanner can't pick up the
  // banned class names and emit them as unused utilities in the compiled CSS.
  const bannedPanX = new RegExp('\\b' + 'touch-' + 'pan-x\\b')
  const bannedPanY = new RegExp('\\b' + 'touch-' + 'pan-y\\b')
  assert.doesNotMatch(
    scrollContainer,
    bannedPanX,
    'the horizontal scroll container must not reintroduce touch-action: pan-x — intersected with Column.tsx\'s vertical pan rule this resolves to touch-action: none and blocks all swiping (GH #87)',
  )
  assert.doesNotMatch(
    scrollContainer,
    bannedPanY,
    'the horizontal scroll container must not carry touch-action: pan-y either — any single-axis touch-action here can conflict with Column.tsx\'s scroll container',
  )
})

test('Board layout stretches vertically and tightens mobile padding (GH #99)', () => {
  assert.match(
    boardSource,
    /className="relative flex h-full min-w-0 flex-1 items-stretch"/,
    'Board container must use items-stretch so columns extend to bottom',
  )
  assert.match(
    boardSource,
    /p-2 pb-2 sm:p-4/,
    'Board scroll container must use compact mobile padding to reclaim vertical space',
  )
  // v3.2.3 (GH #103 follow-up): the "avoid artificial 5rem padding" contract
  // this test originally guarded against is deliberately reverted here. It
  // was true only paired with the `dvh` shell active at the time (see
  // index.css's `.h-screen` comment): with that shell, 5rem of padding WAS
  // pure dead scroll space, nothing scrollable lived below it. The shell is
  // now `100lvh` (does not shrink when Safari's floating toolbar shows), so
  // the same padding now gives the last card real room to scroll clear of
  // that toolbar instead. `md:pb-2` keeps desktop/tablet (no floating
  // toolbar, no safe-area concern) exactly as dense as before.
  assert.match(
    columnSource,
    /pb-\[calc\(5rem\+env\(safe-area-inset-bottom,0px\)\)\] md:pb-2/,
    'Column cards scroll container must reserve safe-area + ~5rem of bottom scroll room below md, for iOS Safari\'s floating toolbar, and reset to dense pb-2 at md+',
  )
  assert.match(
    columnSource,
    /flex h-full w-\[85vw\]/,
    'Column must carry h-full so it fills the scroller height',
  )
  assert.match(
    cssSource,
    /font-family:\s*var\(--font-sans\)\s*!important/,
    'index.css must apply proportional font-sans to coarse pointer form controls with !important',
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

// v3.2.3 (GH #103 follow-up): lvh is sized AFTER the dvh block (source order)
// so it wins on every engine that supports both, without removing the dvh
// fallback above — see index.css's comment for the full dvh-vs-lvh reasoning.
test('index.css further overrides .h-screen to 100lvh (the LARGE viewport, does not shrink for the floating toolbar)', () => {
  const dvhIdx = cssSource.search(/@supports\s*\(\s*height:\s*100dvh\s*\)/)
  const lvhIdx = cssSource.search(/@supports\s*\(\s*height:\s*100lvh\s*\)/)
  assert.ok(dvhIdx >= 0, 'the 100dvh @supports block must still exist')
  assert.ok(lvhIdx >= 0, 'index.css must contain an `@supports (height:100lvh)` block')
  assert.ok(lvhIdx > dvhIdx, 'the 100lvh block must come AFTER the 100dvh block so it wins on engines supporting both')
  const lvhBlock = cssSource.slice(lvhIdx, cssSource.indexOf('}\n}', lvhIdx) + 3)
  assert.match(lvhBlock, /\.h-screen\s*\{[\s\S]*?height:\s*100lvh/, 'the 100lvh block must override .h-screen')
})

test('index.css disables WebKit\'s text autosizer so explicit text-* sizes are not inflated', () => {
  assert.match(
    cssSource,
    /-webkit-text-size-adjust:\s*100%/,
    'index.css must set -webkit-text-size-adjust: 100% to stop iOS Safari inflating prose text in narrow columns',
  )
  assert.match(
    cssSource,
    /(?<!-webkit-)text-size-adjust:\s*100%/,
    'index.css must also set the standard (non-prefixed) text-size-adjust: 100%',
  )
})

test('index.css gives html/body/#root touch-action: pan-x pan-y to block pinch/double-tap zoom without blocking scroll', () => {
  const idx = cssSource.search(/html,\s*\n\s*body,\s*\n\s*#root\s*\{/)
  assert.ok(idx >= 0, 'index.css must declare an `html, body, #root` rule')
  const block = cssSource.slice(idx, cssSource.indexOf('}', idx) + 1)
  assert.match(
    block,
    /touch-action:\s*pan-x pan-y/,
    'html/body/#root must carry `touch-action: pan-x pan-y` — iOS honours this (unlike user-scalable=no) and, per the touch-action intersection rule, it can only ever REMOVE pinch-zoom from a descendant\'s effective value, never narrow which scroll axis a nested scroller is allowed to use',
  )
  // The exact regression this guards against: `pan-x` or `pan-y` ALONE here
  // would, per the same intersection rule Board.tsx/Column.tsx already rely
  // on (GH #87), knock out the OTHER axis for every scrollable descendant —
  // vertical column scrolling, horizontal board scrolling, or sheet/dialog
  // scrolling, depending on which single axis was chosen.
  assert.doesNotMatch(
    block,
    /touch-action:\s*pan-x\s*;/,
    'must not be the single-axis `pan-x` alone — that would block all vertical scrolling everywhere (column lists, sheets, dialogs)',
  )
  assert.doesNotMatch(
    block,
    /touch-action:\s*pan-y\s*;/,
    'must not be the single-axis `pan-y` alone — that would block the board\'s horizontal column scroll',
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

// ---------------------------------------------------------------------------
// TaskSheet mobile layout — MOB-6
//
// On a short viewport the sheet's four flex children all competed for height and
// the description region (the only child that could shrink) collapsed to a few
// lines, or to zero with the keyboard open. The fix pins a minimum on that
// region AND lets the sheet itself scroll, because a minimum alone pushes the
// bottom composer past the `fixed` aside's edge where it is unreachable.
//
// Assertions are token-based, not whole-className matches: an earlier revision
// of this block pinned the exact string and thereby locked in a real bug (a bare
// `flex` had been added to the region, which made it a flex ROW and laid the
// Description / Assignment / Comments / Agent Log sections out side by side).
// Token checks assert the property, so an incidental class cannot pass.
//
// These are source-contract assertions: they read the real component off disk.
// ---------------------------------------------------------------------------

// Split a className into its individual utility tokens.
const tokensOf = (cls) => cls.split(/\s+/).filter(Boolean)

test('TaskSheet description region stacks its sections and cannot be squeezed away', () => {
  // The region is the only div carrying all three of these.
  const region = [...taskSheetSource.matchAll(/className="([^"]*)"/g)]
    .map((m) => m[1])
    .find((cls) => {
      const t = tokensOf(cls)
      return t.includes('flex-1') && t.includes('overflow-y-auto') && t.includes('space-y-4')
    })
  assert.ok(
    region,
    'TaskSheet must render a content region combining `flex-1 overflow-y-auto space-y-4`',
  )

  const tokens = tokensOf(region)

  // The floor: without it the region collapses to a few lines on short viewports.
  const floor = tokens.find((t) => /^min-h-(\[\d+(px|rem)\]|\d+)$/.test(t))
  assert.ok(
    floor,
    `the content region needs a \`min-h-\` floor or it collapses on short viewports (got: ${region})`,
  )
  const px = floor.includes('[')
    ? (floor.includes('px') ? Number(floor.match(/\[(\d+)px\]/)[1]) : Number(floor.match(/\[(\d+)rem\]/)[1]) * 16)
    : Number(floor.replace('min-h-', '')) * 4 // Tailwind numeric scale = 0.25rem
  assert.ok(
    px >= 140,
    `the region floor must keep the heading plus ~4 lines visible: >=140px (got ${floor} = ${px}px)`,
  )

  // A bare `flex` here turns the region into a flex ROW: the sections then sit
  // side by side in a narrow strip instead of stacking. `flex-col` is fine;
  // bare `flex` is not.
  assert.ok(
    !tokens.includes('flex') || tokens.includes('flex-col'),
    'the content region must NOT carry a bare `flex` (that makes it a flex row and lays the sections out side by side); use `flex-col` or no flex at all',
  )
})

test('TaskSheet <aside> scrolls when its fixed children exceed the viewport', () => {
  const aside = taskSheetSource.match(/<aside\b[\s\S]{0,400}?\}\s*>/)?.[0]
  assert.ok(aside, 'TaskSheet.tsx must render the <aside> element')

  const tokens = aside
    .split(/className=\{?\[?/)
    .flatMap((chunk) => [...chunk.matchAll(/'([^']+)'/g)].map((m) => m[1]))
    .join(' ')
    .split(/\s+/)
    .filter(Boolean)

  assert.ok(
    tokens.includes('overflow-y-auto'),
    'the <aside> must be scrollable — a min-height on the region without this clips the bottom composer off-screen',
  )
  assert.ok(
    tokens.includes('overscroll-contain'),
    'the <aside> must use `overscroll-contain` so sheet scrolling cannot chain to the page and collapse the iOS URL bar',
  )
  assert.ok(
    tokens.includes('h-screen') || tokens.includes('h-dvh'),
    'the <aside> must use `h-screen`/`h-dvh` (index.css upgrades h-screen to 100dvh) rather than `h-full`, which can resolve to the URL-bar-hidden height',
  )
  // Same failure mode as the region bug, one level up: if the aside ever lost
  // `flex-col` it would become a flex ROW and lay the header, region and both
  // composers side by side across the viewport.
  assert.ok(
    !tokens.includes('flex') || tokens.includes('flex-col'),
    'the <aside> must carry `flex-col` alongside `flex` — without it the sheet lays out as a row',
  )
  // The scroll-reset effect is inert unless the aside actually carries the ref.
  assert.match(
    aside,
    /ref=\{sheetRef\}/,
    'the <aside> must carry `ref={sheetRef}`, or the MOB-6 scroll reset has nothing to act on',
  )
})

test('TaskSheet header and both composer forms are pinned against the region', () => {
  // Select each element by its token set rather than by an anchor + distance
  // window. An earlier revision anchored on a nearby attribute with a character
  // window, which is fragile in both directions: too tight and the element's own
  // className falls outside it; too wide and a NEIGHBOURING element's `shrink-0`
  // satisfies the assertion. Token sets are unambiguous.
  const all = [...taskSheetSource.matchAll(/className="([^"]*)"/g)].map((m) => tokensOf(m[1]))
  const find = (pred, label) => {
    const hit = all.filter(pred)
    assert.equal(
      hit.length,
      1,
      `expected exactly one ${label} in TaskSheet.tsx, found ${hit.length} — the selector is ambiguous, so this test must be updated`,
    )
    return hit[0]
  }

  const header = find(
    (t) => t.includes('shrink-0') && t.includes('border-b'),
    'sheet header (shrink-0 + border-b)',
  )
  assert.ok(header.includes('shrink-0'), 'the sheet header must carry `shrink-0`')

  const comment = find(
    (t) => t.includes('shrink-0') && t.includes('pb-2') && t.includes('border-t'),
    'comment composer (shrink-0 + border-t + pb-2)',
  )
  assert.ok(comment.includes('shrink-0'), 'the comment composer must carry `shrink-0`')

  const log = find(
    (t) => t.includes('shrink-0') && t.includes('border-t') && !t.includes('pb-2'),
    'log composer (shrink-0 + border-t, no pb-2)',
  )
  assert.ok(log.includes('shrink-0'), 'the log composer must carry `shrink-0`')

  // Both composers and the header must be pinned together: if any one of them
  // can shrink, it reclaims height from the description region instead.
  for (const [label, tokens] of [['header', header], ['comment composer', comment], ['log composer', log]]) {
    assert.ok(
      tokens.includes('shrink-0'),
      `the ${label} must keep \`shrink-0\` so the description region absorbs the compression`,
    )
  }
})

test('TaskSheet resets its scroll offset when a different card is opened', () => {
  assert.match(
    taskSheetSource,
    /use(Effect|LayoutEffect)\(\(\) => \{[\s\S]*?scrollTop = 0[\s\S]*?\}, \[task\?\.id\]\)/,
    'a now-scrollable sheet must reset scrollTop when the open task changes, otherwise a newly opened card renders mid-panel',
  )
})

// ---------------------------------------------------------------------------
// components/About.tsx
// ---------------------------------------------------------------------------

test('About page responsive layout invariants', async (t) => {
  await t.test('About scroll container uses overflow-x-hidden', () => {
    const scrollContainer = aboutSource.match(/<div className="([^"]*overflow-y-auto[^"]*)">/)?.[1]
    assert.ok(scrollContainer, 'About.tsx must render an overflow-y-auto scroll container')
    assert.match(
      scrollContainer,
      /\boverflow-x-hidden\b/,
      'About.tsx scroll container must include `overflow-x-hidden` to prevent horizontal clipping',
    )
  })

  await t.test('About multi-column container uses justify-start and lg:justify-center', () => {
    const flexContainer = aboutSource.match(/<div className="([^"]*justify-start[^"]*)">/)?.[1]
    assert.ok(flexContainer, 'About.tsx must render a container with justify-start')
    assert.match(
      flexContainer,
      /\bjustify-start\b/,
      'About multi-column container must use `justify-start` on mobile',
    )
    assert.match(
      flexContainer,
      /\blg:justify-center\b/,
      'About multi-column container must upgrade to `lg:justify-center` on desktop',
    )
  })

  await t.test('About article uses w-full min-w-0 max-w-3xl flex-1', () => {
    const articleTag = aboutSource.match(/<article className="([^"]*)">/)?.[1]
    assert.ok(articleTag, 'About.tsx must render an <article> element')
    assert.match(articleTag, /\bw-full\b/, 'About article must include `w-full`')
    assert.match(articleTag, /\bmin-w-0\b/, 'About article must include `min-w-0`')
    assert.match(articleTag, /\bmax-w-3xl\b/, 'About article must include `max-w-3xl`')
    assert.match(articleTag, /\bflex-1\b/, 'About article must include `flex-1`')
  })

  await t.test('About grid items in orchestrator skill carry min-w-0', () => {
    const skillGrid = aboutSource.match(/<div className="mt-3 grid gap-3 sm:grid-cols-2">([\s\S]*?)<\/div>\s*<\/section>/)?.[1]
    assert.ok(skillGrid, 'About.tsx must render the orchestrator skill grid')
    const gridItems = [...skillGrid.matchAll(/<div className="([^"]*)">\s*<div[^>]*>\s*(?:Install|Enforces)/g)]
    assert.equal(gridItems.length, 2, 'must find Install and Enforces cards in orchestrator skill grid')
    for (const match of gridItems) {
      assert.match(
        match[1],
        /\bmin-w-0\b/,
        `orchestrator skill card (${match[1]}) must carry \`min-w-0\` to prevent pre/code overflow blowout`,
      )
    }
  })

  await t.test(
    'About strict engine capabilities container uses responsive flex stacking (divide-y divide-line, flex-col sm:flex-row)',
    () => {
      const engineSection = aboutSource.match(/<section id="strict-engine"[\s\S]*?<\/section>/)?.[0]
      assert.ok(engineSection, 'About.tsx must render #strict-engine section')
      assert.match(
        engineSection,
        /className="[^"]*\bdivide-y\b[^"]*\bdivide-line\b[^"]*"/,
        'capabilities container must carry `divide-y divide-line`',
      )
      assert.match(
        engineSection,
        /className="[^"]*\bflex\b[^"]*\bflex-col\b[^"]*\bsm:flex-row\b[^"]*"/,
        'capability row must carry `flex flex-col sm:flex-row` for responsive stacking',
      )
    },
  )
})

