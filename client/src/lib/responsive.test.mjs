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
const CSS_PATH = join(CLIENT_SRC, 'index.css')

const appSource = readFileSync(APP_PATH, 'utf8')
const columnSource = readFileSync(COLUMN_PATH, 'utf8')
const boardSource = readFileSync(BOARD_PATH, 'utf8')
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

test('Column is responsive (w-[85vw] below md, md:w-72 from md up) and snap-start', () => {
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
