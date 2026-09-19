// Regression guard for the in-app About / landing page. Two layers:
//  1. data contract — the pure content module keeps the deck-shaped facts the
//     page renders (trust metrics, why-cards, lifecycle, FAQ, tour shots);
//  2. source contract — App.tsx wires an `about` view and About.tsx honours the
//     editorial voice (serif display) without reintroducing banned visual
//     patterns.
//
// The .ts content module is bundled with esbuild at test time (same pattern as
// stageOwners.test.mjs) so this runs on every Node version CI covers.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = join(__dirname, '..')

const result = await build({
  entryPoints: [join(__dirname, 'aboutContent.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})
const tmpDir = await mkdtemp(join(tmpdir(), 'about-test-'))
const tmpFile = join(tmpDir, 'aboutContent.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const content = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

const {
  ABOUT_GITHUB_URL,
  ABOUT_LIVE_URL,
  TRUST_METRICS,
  WHY_CARDS,
  LIFECYCLE_STEPS,
  CAPABILITIES,
  FAQ,
  CURL_SNIPPET,
  TOUR_SHOTS,
} = content

// ---------------------------------------------------------------------------
// Data contract
// ---------------------------------------------------------------------------

test('trust metrics expose four complete, non-empty entries', () => {
  assert.equal(TRUST_METRICS.length, 4)
  for (const m of TRUST_METRICS) {
    assert.ok(m.value && m.label && m.detail, `incomplete trust metric: ${JSON.stringify(m)}`)
  }
})

test('the why-cards keep all three differentiation stories', () => {
  assert.equal(WHY_CARDS.length, 3)
  for (const c of WHY_CARDS) {
    assert.ok(c.title && c.body && c.mechanism, `incomplete why-card: ${JSON.stringify(c)}`)
  }
  // Each story must name the mechanism that answers it.
  const mechanisms = WHY_CARDS.map((c) => c.mechanism).join('\n')
  assert.match(mechanisms, /withMutationLock/)
  assert.match(mechanisms, /reapExpiredClaims/)
  assert.match(mechanisms, /canTransition/)
})

test('the lifecycle covers every happy-path status plus BLOCKED', () => {
  const statuses = LIFECYCLE_STEPS.map((s) => s.status)
  for (const required of ['BACKLOG', 'BUILDING', 'IN_REVIEW', 'IN_TEST', 'DONE', 'BLOCKED']) {
    assert.ok(statuses.includes(required), `lifecycle is missing ${required}`)
  }
})

test('capabilities cite real code locations', () => {
  assert.ok(CAPABILITIES.length >= 8)
  for (const c of CAPABILITIES) {
    assert.ok(c.name && c.code, `incomplete capability: ${JSON.stringify(c)}`)
  }
  assert.ok(
    CAPABILITIES.some((c) => c.code.includes('store.js')),
    'at least one capability must point at the core engine',
  )
})

test('the FAQ answers at least four adoption questions', () => {
  assert.ok(FAQ.length >= 4, `expected >= 4 FAQ entries, got ${FAQ.length}`)
  for (const f of FAQ) {
    assert.ok(f.q && f.a, `incomplete FAQ entry: ${JSON.stringify(f)}`)
  }
  assert.match(FAQ.map((f) => f.q).join('\n'), /database/i, 'the "no database" question is core')
})

test('the curl snippet proves the headless-first contract', () => {
  assert.match(CURL_SNIPPET, /next-claim/)
  assert.match(CURL_SNIPPET, /PATCH/)
  assert.match(CURL_SNIPPET, /X-Agent-Role/)
})

test('every tour shot points at a bundled /landing asset and has alt text', () => {
  assert.ok(TOUR_SHOTS.length >= 4)
  for (const shot of TOUR_SHOTS) {
    assert.match(shot.src, /^\/landing\//, `tour shot must live under /landing: ${shot.src}`)
    assert.ok(shot.alt && shot.caption, `tour shot needs alt + caption: ${JSON.stringify(shot)}`)
  }
})

test('the outbound links point at the real repo and live board', () => {
  assert.equal(ABOUT_GITHUB_URL, 'https://github.com/riazrahaman/agent-kanban-board')
  assert.equal(ABOUT_LIVE_URL, 'https://agent-kanban.riazrahaman.com')
})

// ---------------------------------------------------------------------------
// Source contract
// ---------------------------------------------------------------------------

const aboutSource = await readFileSync(join(CLIENT_SRC, 'components', 'About.tsx'), 'utf8')
const appSource = await readFileSync(join(CLIENT_SRC, 'App.tsx'), 'utf8')

test('About.tsx uses the editorial serif display face and scrolls its own pane', () => {
  assert.match(aboutSource, /\bfont-serif\b/, 'About.tsx must use the serif display face for its H1')
  assert.match(
    aboutSource,
    /overflow-y-auto/,
    'About.tsx must own its scroll container so the fixed shell is not pushed around',
  )
})

test('App.tsx wires the about view end to end', () => {
  assert.match(
    appSource,
    /useState<'board' \| 'portfolio' \| 'about'>/,
    "App.tsx's view union must include 'about'",
  )
  assert.match(appSource, /<About version=\{version\}/, 'App.tsx must render <About version={version} />')
  assert.match(appSource, /\['about', 'About'/, 'App.tsx must expose an About entry in the view switcher')
  assert.doesNotMatch(
    appSource,
    /v === 'about' \? 'board' : 'about'/,
    'the About control must be a segmented switcher, not a toggle that renames itself to Board',
  )
})

// Banned tokens are assembled from fragments on purpose: this test file itself
// must not contain the literal banned strings.
const BANNED_PATTERNS = [
  { name: 'shad' + 'ow-', re: new RegExp('shad' + 'ow-', 'i') },
  { name: 'rounded' + '-full', re: new RegExp('rounded' + '-full', 'i') },
  { name: 'In' + 'ter', re: new RegExp('\\bIn' + 'ter\\b', 'i') },
  { name: 'Rob' + 'oto', re: new RegExp('\\bRob' + 'oto\\b', 'i') },
  { name: 'person glyph', re: new RegExp('\\u{1F464}', 'u') },
]

test('the About page introduces no banned visual patterns', () => {
  for (const { name, re } of BANNED_PATTERNS) {
    assert.doesNotMatch(aboutSource, re, `About.tsx must not contain \`${name}\``)
  }
})
