// Contract-scan regression guard for the "Report a bug" UI (v2.16.0,
// opt-public-bug-reports; entry point moved to a header icon and the dialog
// got iOS-overflow/zoom/bottom-clearance fixes in v2.17.0,
// mobile-dialog-theme-auto-bugicon) — same style as mobileToolbar.test.mjs /
// columnColors.test.mjs: assert on the raw source text rather than mounting
// React, since this project has no DOM test runner. Covers the DESIGN.md
// contract (hairlines only, square corners, no banned fonts or raw-HTML
// injection), the honeypot's accessibility shape, lazy Turnstile loading,
// and that the entry point is wired from App.tsx's header and the About
// page end to end.
//
// Banned tokens below are assembled from fragments on purpose (same
// convention as about.test.mjs): this test file must not contain the
// literal strings make sec's git-grep is watching for, or the check would
// flag its OWN source.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = join(__dirname, '..')

const dialogSource = readFileSync(join(CLIENT_SRC, 'components', 'BugReportDialog.tsx'), 'utf8')
const appSource = readFileSync(join(CLIENT_SRC, 'App.tsx'), 'utf8')
const aboutSource = readFileSync(join(CLIENT_SRC, 'components', 'About.tsx'), 'utf8')
const apiSource = readFileSync(join(CLIENT_SRC, 'api.ts'), 'utf8')
const headerHelpSource = readFileSync(join(CLIENT_SRC, 'components', 'HeaderHelp.tsx'), 'utf8')

test('the dialog lazy-loads the Turnstile script only when the sheet opens', () => {
  assert.match(
    dialogSource,
    /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/,
    'must load the explicit-render Turnstile script',
  )
  assert.match(
    dialogSource,
    /if \(!open \|\| !siteKey\) return/,
    'the script/widget must not be created before the sheet is open and a site key exists',
  )
})

test('the widget renders with the shared TURNSTILE_ACTION, flexible sizing, and is reset after a failed submit', () => {
  assert.match(dialogSource, /action:\s*TURNSTILE_ACTION/)
  assert.match(dialogSource, /size:\s*'flexible'/, 'the widget must size to its container, not a fixed 300px box')
  const bugReportLibSource = readFileSync(join(CLIENT_SRC, 'lib', 'bugReport.ts'), 'utf8')
  assert.match(bugReportLibSource, /TURNSTILE_ACTION\s*=\s*'bug-report'/)
  assert.match(
    dialogSource,
    /window\.turnstile\.reset\(widgetIdRef\.current\)/,
    'a failed submit must reset the widget (a Turnstile token is single-use)',
  )
})

test('submit is gated on a captcha token existing', () => {
  assert.match(dialogSource, /canSubmitBugReport\(title, description, turnstileToken\)/)
  assert.match(dialogSource, /disabled=\{!canSubmit\}/)
})

test('the honeypot field is off-screen (not display:none), aria-hidden, and unreachable by Tab', () => {
  const honeypotBlock = dialogSource.slice(
    dialogSource.indexOf('<div aria-hidden="true"'),
    dialogSource.indexOf('<div ref={widgetContainerRef}'),
  )
  assert.match(honeypotBlock, /aria-hidden="true"/)
  assert.match(honeypotBlock, /tabIndex=\{-1\}/)
  // Moved off-screen via positioning, never via a `hidden`/`display:none`
  // class — some bots special-case display:none and skip "filling" it.
  assert.match(honeypotBlock, /className="[^"]*-left-\[9999px\][^"]*"/)
  // Reject the standalone `hidden` utility class as a space-separated token
  // (Tailwind's display:none) — NOT substrings like `overflow-hidden`, which
  // this box legitimately uses to clip its off-screen position.
  const classAttr = honeypotBlock.match(/className="([^"]*)"/)?.[1] ?? ''
  const classTokens = classAttr.split(/\s+/)
  assert.ok(!classTokens.includes('hidden'), `honeypot className must not include the bare "hidden" utility: ${classAttr}`)
  assert.match(honeypotBlock, /id="bug-report-website"/)
})

test('the form shows the public-on-GitHub notice and char counters for both fields', () => {
  assert.match(dialogSource, /Reports are public on GitHub\. Do not include passwords, tokens or personal data\./)
  assert.match(dialogSource, /remainingChars\(title, TITLE_MAX\)/)
  assert.match(dialogSource, /remainingChars\(description, DESCRIPTION_MAX\)/)
})

test('status updates are announced via aria-live', () => {
  assert.match(dialogSource, /aria-live="polite"/)
})

test('Escape closes the sheet, matching TaskSheet\'s dialog convention', () => {
  assert.match(dialogSource, /e\.key === 'Escape'/)
})

test('touch ergonomics: pointer-coarse 44px targets and 16px inputs, per DESIGN.md', () => {
  assert.match(dialogSource, /pointer-coarse:min-h-11/)
  assert.match(dialogSource, /pointer-coarse:text-base/)
})

// iOS/WebKit fixes (v2.17.0): the sheet must never be able to widen the
// document's scrollable area (observed as the page panning horizontally on
// an iPhone with the sheet open — see BugReportDialog.tsx's comment), and
// the submit button must stay reachable above a floating bottom toolbar.
test('the sheet cannot widen the document: overflow-x clipped at both the panel and the document root', () => {
  const asideBlock = dialogSource.slice(dialogSource.indexOf('<aside'), dialogSource.indexOf('style={{ height'))
  assert.match(asideBlock, /\boverflow-x-hidden\b/, 'the <aside> itself must clip horizontal overflow (e.g. the honeypot\'s off-screen offset)')
  assert.match(asideBlock, /max-w-\[100vw\]/, 'an unconditional viewport-width cap on top of max-w-md')
  const cssSource = readFileSync(join(CLIENT_SRC, 'index.css'), 'utf8')
  assert.match(
    cssSource,
    /html,\s*\nbody\s*\{\s*\n\s*overflow-x:\s*hidden;/,
    'index.css must clip overflow-x at the document root as a second line of defense',
  )
})

test('the closed sheet is inert (out of tab order and the a11y tree immediately, not just visually hidden)', () => {
  assert.match(dialogSource, /inert=\{!open \? true : undefined\}/)
})

test('the sheet uses 100dvh, not a static viewport unit, so mobile chrome cannot clip it', () => {
  assert.match(dialogSource, /height:\s*'100dvh'/)
})

test('the submit button is pinned outside the scrollable body and reachable above mobile chrome via safe-area padding', () => {
  const footerBlock = dialogSource.slice(
    dialogSource.lastIndexOf('{!success && ('),
    dialogSource.lastIndexOf('</aside>'),
  )
  assert.match(footerBlock, /shrink-0/, 'the footer must not be compressed by the scrollable body\'s flex-1')
  assert.match(
    footerBlock,
    /pb-\[calc\(1rem_\+_env\(safe-area-inset-bottom\)\)\]/,
    'bottom padding must account for the safe-area inset so a floating toolbar cannot cover the button',
  )
  assert.match(footerBlock, /form="bug-report-form"/, 'the button lives outside <form> but must still submit it')
  const formOpenIdx = dialogSource.indexOf('<form id="bug-report-form"')
  assert.ok(formOpenIdx > -1, 'the form must carry a stable id for the external submit button to reference')
})

test('the scrollable body is a flex child that can shrink (min-h-0), not an unbounded flex-1', () => {
  const bodyBlock = dialogSource.slice(dialogSource.indexOf('Scrollable body'), dialogSource.indexOf('<p className="border border-line bg-muted-bg'))
  assert.match(bodyBlock, /\bmin-h-0\b/, 'a flex-1 child needs min-h-0 to actually scroll instead of growing its flex container')
  assert.match(bodyBlock, /overflow-y-auto overscroll-contain/)
})

test('the Turnstile mount point is capped so a wider-than-container widget cannot force the sheet wider', () => {
  const mountLine = dialogSource.match(/<div ref=\{widgetContainerRef\}[^/]*\/>/)?.[0] ?? ''
  assert.match(mountLine, /max-w-full/)
  assert.match(mountLine, /overflow-hidden/)
})

test('the dialog introduces no banned DESIGN.md patterns', () => {
  const BANNED = [
    { name: 'shad' + 'ow-', re: new RegExp('shad' + 'ow-', 'i') },
    { name: 'rounded' + '-full', re: new RegExp('rounded' + '-full', 'i') },
    { name: 'any border radius', re: /\brounded\b|\brounded-[a-z]+\b/ },
    { name: 'In' + 'ter', re: new RegExp('\\bIn' + 'ter\\b', 'i') },
    { name: 'Rob' + 'oto', re: new RegExp('\\bRob' + 'oto\\b', 'i') },
    { name: 'danger' + 'ouslySetInnerHTML', re: new RegExp('danger' + 'ouslySetInnerHTML') },
  ]
  for (const { name, re } of BANNED) {
    assert.doesNotMatch(dialogSource, re, `BugReportDialog.tsx must not contain \`${name}\``)
  }
})

test('App.tsx wires the feature flag and the dialog', () => {
  assert.match(appSource, /getBugReportConfig\(\)/, 'App.tsx must fetch the feature flag')
  assert.match(
    appSource,
    /\[bugReportEnabled, setBugReportEnabled\] = useState\(false\)/,
    'the feature flag must default closed until the fetch resolves',
  )
  assert.match(appSource, /<BugReportDialog\b/, 'the dialog must be mounted in the app shell')
})

// Regression guard (v2.17.0, mobile-dialog-theme-auto-bugicon): the entry
// point moved from HeaderHelp's popover (v2.16.0) and a footer link
// (v2.16.3, now removed) to a small icon button living directly in the
// header toolbar, immediately beside the theme toggle. Round 2 of the
// ORIGINAL v2.16.0 work showed a standalone labelled header button widens
// the toolbar enough to wrap it onto an extra row at several mid viewports
// — this time the icon is unlabelled (icon-only, like the "i" help button
// and the board-controls `⋯` toggle) specifically to keep it narrow, and
// scripts/check-header-layout.mjs re-verifies header height ON vs OFF at
// every width instead of relying on the entry point costing zero width by
// construction.
test('the header icon button sits in App.tsx, gated on the flag, immediately beside the theme toggle', () => {
  assert.match(
    appSource,
    /aria-label="Report a bug"/,
    'App.tsx must render a "Report a bug" icon button',
  )
  const btnIdx = appSource.indexOf('aria-label="Report a bug"')
  assert.ok(btnIdx > -1)
  const guardIdx = appSource.lastIndexOf('{bugReportEnabled &&', btnIdx)
  assert.ok(guardIdx > -1 && guardIdx < btnIdx, 'the icon button must be gated on bugReportEnabled')
  // "immediately beside": the next rendered button after the guarded icon
  // must be the theme toggle, with nothing else (no other control) between
  // them other than the icon's own <svg>.
  const themeBtnIdx = appSource.indexOf('aria-label="Toggle theme"')
  assert.ok(themeBtnIdx > btnIdx, 'the theme toggle must immediately follow the bug icon in source order')
  const themeBtnOpenIdx = appSource.lastIndexOf('<button', themeBtnIdx)
  const between = appSource.slice(appSource.indexOf('</button>', btnIdx), themeBtnOpenIdx)
  assert.ok(
    (between.match(/<button/g) || []).length === 0,
    'no other <button> may sit between the bug icon and the theme toggle',
  )
})

test('the bug icon is inline SVG (no icon library import, no emoji glyph) and carries aria-hidden', () => {
  const btnBlock = appSource.slice(
    appSource.indexOf('aria-label="Report a bug"'),
    appSource.indexOf('</button>', appSource.indexOf('aria-label="Report a bug"')),
  )
  assert.match(btnBlock, /<svg\b/, 'must render an inline <svg>, not an emoji or icon-font glyph')
  assert.match(btnBlock, /aria-hidden="true"/, 'the decorative svg must be hidden from the a11y tree (the button itself carries the label)')
  assert.doesNotMatch(btnBlock, /react-icons|lucide|heroicons|font-awesome/i, 'must not depend on an icon library')
})

test('the bug icon button meets the 44px coarse touch target and matches the theme toggle\'s border/surface tokens', () => {
  const labelIdx = appSource.indexOf('aria-label="Report a bug"')
  const openIdx = appSource.lastIndexOf('<button', labelIdx)
  const closeAngleIdx = appSource.indexOf('>', appSource.indexOf('className=', labelIdx))
  const btnTag = appSource.slice(openIdx, closeAngleIdx + 1)
  assert.match(btnTag, /pointer-coarse:min-h-11/)
  assert.match(btnTag, /pointer-coarse:min-w-11/)
  assert.match(btnTag, /\bborder-line\b/)
  assert.match(btnTag, /\bbg-surface\b/)
})

test('HeaderHelp.tsx no longer hosts a "Report a bug" entry (moved to the header icon) but keeps its popover and containment fix', () => {
  assert.doesNotMatch(
    headerHelpSource,
    /Report a bug/,
    'the popover must only explain the agent id / api token fields now',
  )
  assert.match(headerHelpSource, /role="dialog"/, 'the operator-field popover itself must still exist')
  assert.match(headerHelpSource, /\bmax-lg:fixed\b/, 'the popover containment fix (round 4) must survive the entry-point move')
  assert.match(headerHelpSource, /\blg:absolute\b/)
})

test('no footer "Report a bug" entry point remains anywhere (component deleted, v2.17.0)', () => {
  assert.doesNotMatch(appSource, /AppFooter/, 'App.tsx must not import or mount AppFooter')
  assert.doesNotMatch(appSource, /<footer\b/i, 'App.tsx must not render a <footer> landmark')
})

test('About.tsx exposes the same entry point, gated on the same flag', () => {
  assert.match(aboutSource, /bugReportEnabled/)
  assert.match(aboutSource, /onReportBug/)
})

test('api.ts never sends auth headers on the bug-report endpoints (anonymous by design)', () => {
  const configFn = apiSource.slice(
    apiSource.indexOf('export async function getBugReportConfig'),
    apiSource.indexOf('export async function getBugReportConfig') + 300,
  )
  const submitFn = apiSource.slice(
    apiSource.indexOf('export async function submitBugReport'),
    apiSource.indexOf('export async function submitBugReport') + 600,
  )
  assert.doesNotMatch(configFn, /readHeaders|authHeaders|Authorization/)
  assert.doesNotMatch(submitFn, /readHeaders|authHeaders|Authorization/)
})

test('api.ts never throws on a failed submit — it returns a typed result the form can branch on', () => {
  const submitFn = apiSource.slice(
    apiSource.indexOf('export async function submitBugReport'),
    apiSource.indexOf('export async function submitBugReport') + 600,
  )
  assert.doesNotMatch(submitFn, /throw new Error/)
})
