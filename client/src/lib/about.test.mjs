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
import { readFileSync, readdirSync } from 'node:fs'
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
  STACK_ROWS,
  CLAIM_FLOW,
  RECLAIM_FLOW,
  RECLAIM_INTRO,
  SAFETY_LAYERS,
  SAFETY_FOOTER,
  ARCH_LAYERS,
  ARCH_INTRO,
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

test('the trust metrics report the real suite sizes (no stale counts)', () => {
  // Cross-check against the ACTUAL suite files rather than hardcoding the
  // expected numbers. Hardcoding them here is exactly what let this metric go
  // stale: this test was named "no stale counts" while asserting a fixed '203'
  // against a suite that had grown to 222, so it could never detect drift.
  // Counted from the files themselves: `it(`/`test(` declarations per suite.
  const SERVER_TEST_DIR = join(CLIENT_SRC, '..', '..', 'server', 'test')
  const clientDir = CLIENT_SRC

  const countCases = (dir, filter) => {
    let total = 0
    const walk = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!filter(entry.name)) continue
        const body = readFileSync(full, 'utf8')
        // `it('...'` / `test('...'` declarations, ignoring commented lines.
        total += (body.match(/^\s*(?:await\s+)?(?:it|test)\s*\(/gm) || []).length
      }
    }
    walk(dir)
    return total
  }

  const serverActual = countCases(SERVER_TEST_DIR, (n) => n.endsWith('.test.js'))
  const clientActual = countCases(clientDir, (n) => n.endsWith('.test.mjs'))

  const server = TRUST_METRICS.find((m) => /server/i.test(m.label))
  const client = TRUST_METRICS.find((m) => /client/i.test(m.label))

  // Guard the guard: if discovery silently finds nothing, fail loudly rather
  // than passing vacuously.
  assert.ok(serverActual > 0, 'must find server test cases to compare against')
  assert.ok(clientActual > 0, 'must find client test cases to compare against')

  assert.equal(
    server.value,
    String(serverActual),
    `About page claims ${server.value} server tests but the suite declares ${serverActual}`,
  )
  assert.equal(
    client.value,
    String(clientActual),
    `About page claims ${client.value} client tests but the suite declares ${clientActual}`,
  )
})

test('the why-cards keep all the differentiation stories', () => {
  assert.equal(WHY_CARDS.length, 4)
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

test('the stack table covers every layer with a real code location', () => {
  assert.ok(STACK_ROWS.length >= 5, `expected a full stack, got ${STACK_ROWS.length} rows`)
  for (const r of STACK_ROWS) {
    assert.ok(r.layer && r.choice && r.why && r.location, `incomplete stack row: ${JSON.stringify(r)}`)
  }
  const locs = STACK_ROWS.map((r) => r.location).join('\n')
  assert.match(locs, /store\.js/, 'the core engine row must point at store.js')
  assert.match(locs, /server\.js/, 'the transport row must point at server.js')
  assert.ok(ARCH_INTRO.length > 0, 'the architecture section needs an intro')
})

test('the claim flow walks the real next-claim path in order', () => {
  assert.ok(CLAIM_FLOW.length >= 6, `expected a full flow, got ${CLAIM_FLOW.length} steps`)
  for (const s of CLAIM_FLOW) {
    assert.ok(s.label && s.title && s.detail, `incomplete flow step: ${JSON.stringify(s)}`)
  }
  const text = CLAIM_FLOW.map((s) => `${s.title} ${s.detail}`).join('\n')
  assert.match(text, /next-claim/, 'the flow must start from the next-claim route')
  assert.match(text, /withMutationLock/, 'the flow must pass through the mutation lock')
  assert.match(text, /applyClaim/, 'the flow must describe applyClaim writing the owner')
  assert.match(text, /persist/i, 'the flow must state persist-before-memory')
  assert.match(text, /notify/, 'the flow must end by pushing an SSE diff')
})

test('the safety layers name all three guards plus the persist-first footer', () => {
  assert.equal(SAFETY_LAYERS.length, 3)
  const text = SAFETY_LAYERS.map((s) => `${s.name} ${s.detail}`).join('\n')
  assert.match(text, /If-Match|version/, 'concurrency guard must mention version/If-Match')
  assert.match(text, /canTransition/, 'state-machine guard must be named')
  assert.match(text, /canRoleTransition/, 'role guard must be named')
  assert.match(text, /lease/i, 'lease ownership guard must be named')
  assert.match(SAFETY_FOOTER, /withMutationLock/)
  assert.match(SAFETY_FOOTER, /persist/i)
})

test('the reclaim flow explains the stall → reaper → Telegram alert path', () => {
  assert.ok(RECLAIM_FLOW.length >= 5, `expected the full reclaim story, got ${RECLAIM_FLOW.length} steps`)
  for (const s of RECLAIM_FLOW) {
    assert.ok(s.label && s.title && s.detail, `incomplete reclaim step: ${JSON.stringify(s)}`)
  }
  const text = RECLAIM_FLOW.map((s) => `${s.title} ${s.detail}`).join('\n')
  assert.match(text, /heartbeat/i, 'the story must start from a stalled heartbeat')
  assert.match(text, /reapExpiredClaims/, 'the reaper must be named')
  assert.match(text, /reclaimTaskInner/, 'the reclaim path must be named')
  assert.match(text, /notifier\.js/, 'the notifier must be named as the delivery mechanism')
  assert.match(text, /Telegram/i, 'the alert target must be named')
  assert.match(text, /fail-silent|never breaks/i, 'the failure isolation guarantee must be stated')
  assert.ok(RECLAIM_INTRO.length > 0, 'the reclaim section needs an intro')
})

test('the why-cards cover the silent-reclaim failure mode', () => {
  assert.equal(WHY_CARDS.length, 4)
  const mechanisms = WHY_CARDS.map((c) => c.mechanism).join('\n')
  assert.match(mechanisms, /notifier\.js/, 'the silent-reclaim card must name the notifier')
})

test('the FAQ answers the "how will I know an agent died" question', () => {
  const faq = FAQ.map((f) => `${f.q} ${f.a}`).join('\n')
  assert.match(faq, /KANBAN_TELEGRAM_BOT_TOKEN/, 'the alert setup env var must be documented')
  assert.match(faq, /KANBAN_TELEGRAM_CHAT_ID/, 'the alert chat env var must be documented')
  assert.match(faq, /off by default/i, 'the opt-in default must be stated')
})

test('the six-layer summary mirrors the system design chapter', () => {
  assert.equal(ARCH_LAYERS.length, 6)
  for (const s of ARCH_LAYERS) {
    assert.ok(s.label && s.title && s.detail, `incomplete arch layer: ${JSON.stringify(s)}`)
  }
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

test('About.tsx adds the architecture section without dropping existing sections', () => {
  // the addon is present
  assert.match(aboutSource, /Architecture &amp; code flow/, 'the architecture addon must be rendered')
  assert.match(aboutSource, /STACK_ROWS/, 'the stack table must be data-driven')
  assert.match(aboutSource, /CLAIM_FLOW/, 'the claim flow must be data-driven')
  assert.match(aboutSource, /SAFETY_LAYERS/, 'the safety layers must be data-driven')
  assert.match(aboutSource, /RECLAIM_FLOW/, 'the reclaim-alert flow must be data-driven')
  assert.match(aboutSource, /ARCH_LAYERS/, 'the six-layer summary must be data-driven')
  // the pre-existing sections are all still there (additive, not a rewrite)
  for (const section of [
    'TRUST_METRICS',
    'WHY_CARDS',
    'LIFECYCLE_STEPS',
    'CAPABILITIES',
    'TOUR_SHOTS',
    'CURL_SNIPPET',
    'FAQ',
  ]) {
    assert.match(aboutSource, new RegExp(section), `existing section ${section} must be preserved`)
  }
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
