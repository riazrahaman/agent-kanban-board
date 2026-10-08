// Contract-scan regression guard for the footer "Report a bug" link
// (v2.16.3, report-bug-footer-link) — same style as bugReportContract.test.mjs
// / mobileToolbar.test.mjs: assert on the raw source text rather than
// mounting React, since this project has no DOM test runner.
//
// Why this exists: a phone visitor could only reach "Report a bug" through
// the header's "i" help popover (behind the `⋯` disclosure — 3 taps) or by
// scrolling to the About page. This adds a third, always-reachable entry: a
// slim footer link at the very end of the page content, below `<main>`, that
// must never cover the board/rail/cards (so NOT fixed/sticky) and must not
// grow or shrink the header.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = join(__dirname, '..')

const footerSource = readFileSync(join(CLIENT_SRC, 'components', 'AppFooter.tsx'), 'utf8')
const appSource = readFileSync(join(CLIENT_SRC, 'App.tsx'), 'utf8')

test('App.tsx mounts AppFooter as a sibling of <main>, outside the per-view branches', () => {
  assert.match(appSource, /import AppFooter from '\.\/components\/AppFooter'/)
  assert.match(
    appSource,
    /<AppFooter\s+bugReportEnabled=\{bugReportEnabled\}\s+onReportBug=\{\(\) => setBugReportOpen\(true\)\}\s*\/>/,
    'App.tsx must render <AppFooter bugReportEnabled=... onReportBug=.../> wired to the same state as the header/About entries',
  )
  const mainClose = appSource.indexOf('</main>')
  const footerUse = appSource.indexOf('<AppFooter')
  assert.ok(mainClose > -1 && footerUse > mainClose, 'AppFooter must be rendered AFTER </main> closes, not nested inside it')
})

test('AppFooter renders nothing at all when the feature flag is off (zero layout change by default)', () => {
  assert.match(
    footerSource,
    /if \(!bugReportEnabled\) return null/,
    'the component must bail out to null, not just hide its contents, when the flag is off',
  )
})

test('AppFooter is a real <footer> landmark with a native <button>, not a link styled as a button', () => {
  assert.match(footerSource, /<footer\b[^>]*>/)
  assert.match(footerSource, /<button\s+type="button"/)
  assert.match(footerSource, />\s*Report a bug\s*</, 'must render a clear, literal "Report a bug" label')
  assert.match(footerSource, /onClick=\{onReportBug\}/)
})

// Anchored on the `className="..."` attribute specifically (not just the
// `<footer` tag name), because the doc comment above the component also
// mentions the literal text "<footer>" in prose — matching the bare tag name
// would pick up that comment's "<footer>" (no attributes) instead of the
// real JSX element.
const footerClassName = footerSource.match(/<footer\s+className="([^"]*)"/)?.[1] ?? ''

test('the footer is never fixed or sticky — it must not be able to cover the board, the Signal rail or a card', () => {
  assert.ok(footerClassName, 'AppFooter.tsx must render <footer className="...">')
  assert.doesNotMatch(footerClassName, /\bfixed\b/, '<footer> must not use `fixed` positioning')
  assert.doesNotMatch(footerClassName, /\bsticky\b/, '<footer> must not use `sticky` positioning')
  // `shrink-0` so it keeps its natural (tiny) height inside the `flex-col`
  // shell instead of being compressed to nothing by `<main>`'s `flex-1`.
  assert.match(footerClassName, /\bshrink-0\b/)
})

test('touch ergonomics: the link meets the 44px pointer-coarse target via min-height, not extra padding', () => {
  assert.match(footerSource, /pointer-coarse:min-h-11/)
})

test('the footer carries a hairline top border using the existing design tokens, and muted/mono/uppercase styling like other secondary labels', () => {
  assert.match(footerClassName, /\bborder-t\b/)
  assert.match(footerClassName, /\bborder-line\b/)
  const buttonTag = footerSource.match(/<button\s+type="button"[\s\S]*?>/)?.[0] ?? ''
  assert.match(buttonTag, /\bfont-mono\b/)
  assert.match(buttonTag, /\buppercase\b/)
  assert.match(buttonTag, /\btext-muted\b/)
})

test('AppFooter introduces no banned DESIGN.md patterns', () => {
  const BANNED = [
    { name: 'shad' + 'ow-', re: new RegExp('shad' + 'ow-', 'i') },
    { name: 'rounded' + '-full', re: new RegExp('rounded' + '-full', 'i') },
    { name: 'any border radius', re: /\brounded\b|\brounded-[a-z]+\b/ },
    { name: 'In' + 'ter', re: new RegExp('\\bIn' + 'ter\\b', 'i') },
    { name: 'Rob' + 'oto', re: new RegExp('\\bRob' + 'oto\\b', 'i') },
    { name: 'danger' + 'ouslySetInnerHTML', re: new RegExp('danger' + 'ouslySetInnerHTML') },
  ]
  for (const { name, re } of BANNED) {
    assert.doesNotMatch(footerSource, re, `AppFooter.tsx must not contain \`${name}\``)
  }
  // Tailwind border classes interpolated into a template string are invisible
  // to the JIT scanner (DESIGN.md §12 / columnColors.test.mjs convention).
  assert.doesNotMatch(
    footerSource,
    /\$\{[^}]*border-[a-z-]+[^}]*\}/,
    'must not interpolate a Tailwind border class inside a template string',
  )
})

test('the header toolbar itself still contains no "Report a bug" button (the footer link is a THIRD entry point, not a toolbar change)', () => {
  // App.tsx's <header>...</header> block must not gain a "Report a bug"
  // literal just because the footer (a sibling of <header>, far below it in
  // the file) now has one elsewhere in the same file.
  const headerBlock = appSource.slice(appSource.indexOf('<header'), appSource.indexOf('</header>'))
  assert.doesNotMatch(
    headerBlock,
    /Report a bug/,
    'the <header> block must not render a "Report a bug" label — it still lives only in HeaderHelp\'s popover and (now) the footer',
  )
})
