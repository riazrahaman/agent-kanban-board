// Contract-scan regression guard for the "Report a bug" UI (v2.16.0,
// opt-public-bug-reports) — the same style as mobileToolbar.test.mjs /
// columnColors.test.mjs: assert on the raw source text rather than
// mounting React, since this project has no DOM test runner. Covers the
// DESIGN.md contract (hairlines only, square corners, no banned fonts or
// raw-HTML injection), the honeypot's accessibility shape, lazy Turnstile
// loading, and that the entry point is wired from both the header and the
// About page end to end.
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

test('the widget renders with the shared TURNSTILE_ACTION and is reset after a failed submit', () => {
  assert.match(dialogSource, /action:\s*TURNSTILE_ACTION/)
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

test('App.tsx wires the feature flag and the dialog, but owns no header button itself', () => {
  assert.match(appSource, /getBugReportConfig\(\)/, 'App.tsx must fetch the feature flag')
  assert.match(
    appSource,
    /\[bugReportEnabled, setBugReportEnabled\] = useState\(false\)/,
    'the feature flag must default closed until the fetch resolves',
  )
  assert.match(appSource, /<BugReportDialog\b/, 'the dialog must be mounted in the app shell')
  assert.match(
    appSource,
    /<HeaderHelp\s+bugReportEnabled=\{bugReportEnabled\}/,
    'App.tsx must forward the flag + opener into HeaderHelp, not render its own button',
  )
})

// Regression guard (v2.16.0): a standalone "Report a bug" button in the
// header's flex toolbar row widened it enough to push the row to wrap at
// several mid viewports (824-1100px measured in real Chrome) even though it
// never wraps with the feature off. The entry point was moved INSIDE
// HeaderHelp's popover, which is taken out of the header's flex flow at
// EVERY breakpoint (`max-lg:fixed` on phones/tablets, `lg:absolute` from
// 1024px up — see the containment fix below), so it costs zero width in the
// toolbar regardless of the feature flag — asserted here by construction
// (no button literal in App.tsx's header markup at all, and the one in
// HeaderHelp.tsx sits inside that out-of-flow subtree).
test('the header toolbar itself contains no "Report a bug" button (moved into the HeaderHelp popover)', () => {
  assert.doesNotMatch(
    appSource,
    /Report a bug/,
    'App.tsx must not render a "Report a bug" label anywhere — the entry point lives in HeaderHelp.tsx\'s popover now',
  )

  const popoverOpen = headerHelpSource.indexOf("role=\"dialog\"")
  // lastIndexOf, not indexOf: the doc comment above the component already
  // mentions "Report a bug" in prose — the actual rendered entry (what this
  // assertion cares about) is the LAST occurrence, inside the JSX.
  const reportBugIdx = headerHelpSource.lastIndexOf('Report a bug')
  assert.ok(popoverOpen > -1, 'HeaderHelp.tsx must still render its popover')
  assert.ok(reportBugIdx > -1, 'HeaderHelp.tsx must render the "Report a bug" entry')
  assert.ok(
    reportBugIdx > popoverOpen,
    'the "Report a bug" entry must be INSIDE the popover markup, not a sibling in the flex toolbar',
  )
  // The popover's wrapper must be taken out of the header's flex flow at
  // EVERY breakpoint — `max-lg:fixed` on phones/tablets (where it becomes a
  // viewport-anchored sheet so it can never clip off-screen regardless of
  // where the "i" button lands) and `lg:absolute` from 1024px up (the
  // original anchored-dropdown look, safe once there is enough room). Either
  // branch takes it out of flow; what it must NEVER be is `static` (the
  // flex-participating default), which would cost toolbar width again.
  const popoverBlock = headerHelpSource.slice(headerHelpSource.indexOf('{open && ('), reportBugIdx)
  assert.match(popoverBlock, /\bmax-lg:fixed\b/, 'the popover must use a viewport-anchored fixed position below `lg` so it can never clip off-screen')
  assert.match(popoverBlock, /\blg:absolute\b/, 'the popover must stay out-of-flow (`absolute`) from `lg` up too, never static')
})

test('HeaderHelp.tsx gates the entry on the enabled flag and closes the popover before opening the dialog', () => {
  assert.match(headerHelpSource, /bugReportEnabled && onReportBug/)
  assert.match(
    headerHelpSource,
    /setOpen\(false\)\s*\n\s*onReportBug\(\)/,
    'must close the popover before opening the dialog so Escape/focus hand off cleanly',
  )
  assert.match(headerHelpSource, /pointer-coarse:min-h-11/, 'the entry must still meet the 44px touch target')
})

// Regression guard (v2.16.0 round 4): `absolute right-0 w-80` clipped the
// popover off the LEFT edge of the viewport whenever the "i" button's own
// x-position was less than 320px — measured at 320-390px (~44% clipped) and
// again at 768-820px (the full header-controls row crowds the button
// rightward). `right:0` anchors to the BUTTON, never the viewport, so no
// width/max-width tweak alone can fix it — verified with a real headless
// Chrome via scripts/check-header-layout.mjs's popover-containment check
// (which also proves non-vacuity: reverting to the old class makes it fail).
test('the popover cannot clip off-screen: unconditional width cap plus a viewport-anchored fallback below `lg`', () => {
  const popoverBlock = headerHelpSource.slice(
    headerHelpSource.indexOf('{open && ('),
    headerHelpSource.lastIndexOf('Report a bug'),
  )
  assert.match(
    popoverBlock,
    /max-w-\[calc\(100vw-1\.5rem\)\]/,
    'an unconditional max-width safety net must apply at every breakpoint, not just below `lg`',
  )
  assert.match(
    popoverBlock,
    /max-lg:inset-x-3/,
    'below `lg` the popover must be positioned by VIEWPORT margins (inset-x), not by the button\'s x-position',
  )
  assert.doesNotMatch(
    popoverBlock,
    /className="absolute right-0/,
    'must never go back to an unconditional `absolute right-0` with no breakpoint guard — that is exactly what clipped',
  )
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
