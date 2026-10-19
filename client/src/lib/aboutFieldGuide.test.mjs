// Regression guard for the rebuilt About page — "Field Guide Nº 02 · The Agent
// Board" (v3.5.0). It complements about.test.mjs (which pins the data contract
// and the trust-metric cross-check) by pinning the NEW article shape:
//
//   * the twelve chapters and their ELI5 / under-the-hood / snippet / gotcha
//     grammar, each pointing at a file that actually exists;
//   * the chapter-9 environment table;
//   * the chapter-10 Ask-the-Board client helper and its error mapping;
//   * the field-guide masthead/hero/grid hooks in About.tsx and index.css.
//
// The .ts content module is bundled with esbuild at test time (same pattern as
// about.test.mjs / stageOwners.test.mjs) so this runs on every Node CI covers.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = join(__dirname, '..')
const REPO_ROOT = join(CLIENT_SRC, '..', '..')

const result = await build({
  entryPoints: [join(__dirname, 'aboutContent.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})
const tmpDir = await mkdtemp(join(tmpdir(), 'about-field-guide-'))
const tmpFile = join(tmpDir, 'aboutContent.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const content = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

const { CHAPTERS, ENV_VARS, ASK_SCOPE_NOTE, FIELD_GUIDE, HERO } = content

const aboutSource = readFileSync(join(CLIENT_SRC, 'components', 'About.tsx'), 'utf8')
const askSource = readFileSync(join(CLIENT_SRC, 'lib', 'ask.ts'), 'utf8')
const cssSource = readFileSync(join(CLIENT_SRC, 'index.css'), 'utf8')

// ---------------------------------------------------------------------------
// The article
// ---------------------------------------------------------------------------

test('the field guide has exactly twelve numbered chapters, in order', () => {
  assert.equal(CHAPTERS.length, 12)
  assert.deepEqual(
    CHAPTERS.map((c) => c.number),
    ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'],
  )
  const ids = CHAPTERS.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length, 'chapter ids must be unique (they are DOM anchors)')
  // The architecture chapter sits between the client chapter and configuration.
  assert.deepEqual(
    ids.slice(-4),
    ['architecture', 'config', 'ask', 'faq'],
    'the architecture chapter must precede Configuration',
  )
  for (const c of CHAPTERS) {
    assert.ok(c.title && c.emoji, `chapter ${c.number} needs a title and emoji`)
  }
})

test('every chapter keeps the ELI5 / under-the-hood / snippet / gotcha grammar', () => {
  for (const c of CHAPTERS) {
    assert.ok(c.eli5 && c.eli5.length > 20, `chapter ${c.id} needs an ELI5 line`)
    assert.ok(c.underTheHood && c.underTheHood.length > 40, `chapter ${c.id} needs an under-the-hood paragraph`)
    assert.ok(c.snippet && c.snippet.label && c.snippet.code, `chapter ${c.id} needs a labelled real snippet`)
    assert.ok(c.gotcha && c.gotcha.length > 20, `chapter ${c.id} needs a gotcha line`)
  }
})

test('every chapter points at at least one real file that exists on disk', () => {
  for (const c of CHAPTERS) {
    assert.ok(Array.isArray(c.files) && c.files.length >= 1, `chapter ${c.id} must name a file`)
    for (const f of c.files) {
      assert.ok(
        existsSync(join(REPO_ROOT, f)),
        `chapter ${c.id} references a file that does not exist: ${f}`,
      )
    }
  }
})

test('chapter 1 maps the lifecycle and notes the normalised legacy spellings + terminal DONE', () => {
  const states = CHAPTERS.find((c) => c.id === 'states')
  assert.ok(states, 'the eight-states chapter must exist')
  const text = `${states.underTheHood} ${states.gotcha}`
  assert.match(text, /server\/state-machine\.js/)
  // The pre-v3 spellings are described, lowercased, as normalised aliases.
  assert.match(text, /todo/i)
  assert.match(text, /building/i)
  assert.match(text, /in_test/i)
  assert.match(states.gotcha, /terminal/i)
})

test('the credentials chapter shows how to generate a credential value on every OS', () => {
  const auth = CHAPTERS.find((c) => c.id === 'auth')
  assert.ok(auth, 'the who-may-write chapter must exist')
  const code = auth.snippet.code
  assert.match(code, /macOS and Linux/)
  assert.match(code, /openssl rand -hex 24/)
  assert.match(code, /Windows PowerShell/)
  assert.match(code, /RandomNumberGenerator|RNGCryptoServiceProvider/)
  assert.match(code, /require\('crypto'\)\.randomBytes\(24\)/)
  // The sample tokens must look like placeholders, never like live credentials.
  assert.match(code, /tok-build/)
})

test('chapter 3 states the reaper reclaims to READY and lists the three reasons', () => {
  const reaper = CHAPTERS.find((c) => c.id === 'reaper')
  assert.ok(reaper)
  const text = `${reaper.underTheHood} ${reaper.gotcha} ${reaper.snippet.code}`
  assert.match(text, /orphan_normalized/)
  assert.match(text, /progress_stalled/)
  assert.match(text, /lease_expired/)
  assert.match(text, /KANBAN_PROGRESS_STALL_MS/)
  assert.match(reaper.gotcha, /READY/)
})

test('the architecture chapter documents teardown, not just the mount order', () => {
  // The About page is the only place a reader is told how the process is
  // composed. After v3.5.1 it is also where they are told how it comes apart,
  // and the ORDER is the whole point: ending the SSE streams after
  // server.close() would deadlock on the connections close() is waiting for.
  const arch = CHAPTERS.find((c) => c.id === 'architecture')
  assert.ok(arch, 'the architecture chapter must exist')
  const prose = `${arch.underTheHood} ${arch.snippet.code}`
  assert.match(prose, /SIGTERM/)
  assert.match(prose, /drainSseStreams/)
  assert.match(prose, /server\.close\(\)/)

  // The claim is only true if the drain is described BEFORE the close.
  const snippet = arch.snippet.code
  assert.ok(
    snippet.indexOf('drainSseStreams') < snippet.indexOf('server.close()'),
    'the snippet must show the drain ahead of the close, which is the actual contract',
  )
})

test('the client chapter explains what a redeploy does to the one open stream', () => {
  const client = CHAPTERS.find((c) => c.id === 'client')
  assert.ok(client, 'the client chapter must exist')
  assert.match(
    client.underTheHood,
    /EventSource/,
    'a reader watching the board through a deploy needs to know the stream returns by itself',
  )
})

// ---------------------------------------------------------------------------
// The environment table (chapter 10)
// ---------------------------------------------------------------------------

test('the environment table documents every required board variable', () => {
  const names = new Set(ENV_VARS.map((v) => v.name))
  for (const required of [
    'KANBAN_PROJECT_TOKENS',
    'KANBAN_ADMIN_TOKEN',
    'KANBAN_AUTH_SECRET',
    'KANBAN_READ_AUTH',
    'KANBAN_CLAIM_TTL_MS',
    'KANBAN_MIN_LEASE_MS',
    'KANBAN_MAX_LEASE_MS',
    'KANBAN_PROGRESS_STALL_MS',
    'KANBAN_REAP_ENABLED',
    'KANBAN_STORAGE_BACKEND',
    'KANBAN_DATA_DIR',
    'KANBAN_ASK_OPENROUTER_API_KEY',
    'KANBAN_ASK_PASSWORD',
    'KANBAN_ASK_MODEL',
    'KANBAN_ASK_DAILY_CAP',
    'KANBAN_ASK_PER_IP_PER_HOUR',
    'KANBAN_ASK_TIMEOUT_MS',
    'KANBAN_ASK_MAX_PROMPT_TOKENS',
    'KANBAN_ASK_MAX_OUTPUT_TOKENS',
  ]) {
    assert.ok(names.has(required), `the config table must document ${required}`)
  }
  for (const v of ENV_VARS) {
    assert.ok(v.name && v.purpose, `incomplete env entry: ${JSON.stringify(v)}`)
  }
})

test('the environment table mirrors the generated configuration reference', () => {
  const docs = readFileSync(join(REPO_ROOT, 'docs', 'CONFIGURATION.md'), 'utf8')
  for (const v of ENV_VARS) {
    assert.ok(docs.includes(`\`${v.name}\``), `docs/CONFIGURATION.md must still document ${v.name}`)
  }
})

// ---------------------------------------------------------------------------
// The Ask card (chapter 11)
// ---------------------------------------------------------------------------

test('the ask client helper uses the /api base, the x-ask-pass header and a localStorage key', () => {
  assert.match(askSource, /\/api/)
  assert.match(askSource, /getAskConfig/)
  assert.match(askSource, /askQuestion/)
  assert.match(askSource, /\/ask\/config/)
  assert.match(askSource, /'x-ask-pass': password/)
  assert.match(askSource, /'kanban\.askPass'/)
  // The password must never be smuggled into a query string.
  assert.doesNotMatch(askSource, /password=|ask\?/i)
})

test('the ask helper throws a typed error carrying status + server error code', () => {
  assert.match(askSource, /class AskError extends Error/)
  assert.match(askSource, /readonly status: number/)
  assert.match(askSource, /readonly code: string/)
  assert.match(askSource, /body\?\.error/)
})

test('the Ask card maps 401/429/502-503 to specific messages', () => {
  assert.match(aboutSource, /Wrong password\./)
  assert.match(aboutSource, /Too many attempts — please wait a moment\./)
  assert.match(aboutSource, /The assistant is temporarily unavailable\./)
  assert.match(aboutSource, /err\.status === 401/)
  assert.match(aboutSource, /err\.status === 429/)
  assert.match(aboutSource, /err\.status === 502 \|\| err\.status === 503/)
})

test('the ask scope is described as a prompt instruction, not a hard guarantee', () => {
  assert.match(ASK_SCOPE_NOTE, /instructed to stay/i)
  assert.doesNotMatch(ASK_SCOPE_NOTE, /cannot answer off-topic/i)
  const ask = CHAPTERS.find((c) => c.id === 'ask')
  assert.match(ask.gotcha, /prompt instruction, not a hard fence/i)
})

// ---------------------------------------------------------------------------
// The field-guide shell (UI hooks)
// ---------------------------------------------------------------------------

test('About.tsx renders the masthead, hero and per-chapter anchors', () => {
  assert.match(aboutSource, /about-view/)
  assert.match(aboutSource, /FIELD_GUIDE/)
  assert.match(aboutSource, /HERO/)
  assert.match(aboutSource, /CHAPTERS\.map/)
  assert.match(aboutSource, /clamp\(2\.5rem,5\.6vw,4\.5rem\)/)
  assert.match(aboutSource, /IntersectionObserver/)
  assert.match(FIELD_GUIDE.kicker, /Field Guide/)
  assert.ok(HERO.accentOne && HERO.accentTwo, 'the hero must expose its italic accent words')
})

test('the hero headline is bold sans with the accents — and only the accents — in the serif', () => {
  // Instrument Serif ships no bold weight, so a headline set entirely in it
  // renders light and literary rather than authoritative. The benchmark pages
  // (token-tv / stack-field-guide `guide.css` .hero h1) set the headline in
  // the sans at 700 and use the serif italic for the accent words only.
  const h1 = aboutSource.match(/<h1[\s\S]*?<\/h1>/)
  assert.ok(h1, 'the hero must render an <h1>')
  assert.match(h1[0], /font-bold/, 'the headline carries real weight')
  assert.doesNotMatch(
    h1[0].replace(/<em[\s\S]*?<\/em>/g, ''),
    /font-serif/,
    'only the <em> accents may be set in the serif',
  )
  for (const accent of [/HERO\.accentOne/, /HERO\.accentTwo/]) {
    const em = h1[0].match(new RegExp(`<em[^>]*>\\s*{${accent.source.replace('\\.', '\\.')}}`))
    assert.ok(em, `${accent} must be wrapped in an <em>`)
  }
  assert.match(h1[0], /font-serif[^"]*italic/, 'the accents are serif italic')
})

test('Ask-the-Board is the lead feature, rendered once, in the hero', () => {
  const heroStart = aboutSource.indexOf('<header id="top"')
  const heroEnd = aboutSource.indexOf('</header>', heroStart)
  assert.ok(heroStart > 0 && heroEnd > heroStart, 'the hero header must exist')
  assert.match(
    aboutSource.slice(heroStart, heroEnd),
    /<AskCard \/>/,
    'the console belongs in the hero, above the fold — not eleven chapters down',
  )
  // Exactly one console on the page: the ask chapter cross-links up to it
  // rather than rendering a second, duplicate form.
  assert.equal(aboutSource.match(/<AskCard \/>/g).length, 1)
  assert.match(aboutSource, /chapter\.id === 'ask' &&[\s\S]{0,400}href="#top"/)
})

test('in-page anchors clear the sticky chapter bar via a measured --toc-h', () => {
  // Hardcoded scroll-margin utilities went stale whenever the bar changed
  // height (one scrolling row on phones, taller on desktop, absent behind the
  // wide-screen rail), landing headings underneath it — stack-field-guide #5.
  assert.match(cssSource, /\.about-view \[id\]\s*\{[^}]*scroll-margin-top:\s*calc\(var\(--toc-h\)/)
  assert.match(aboutSource, /ResizeObserver/, 'About.tsx must re-measure the bar')
  assert.match(aboutSource, /setProperty\('--toc-h'/)
})

test('the back-to-origin control records a scroll offset and arms before retiring (#113)', () => {
  // The counterpart to the Top control: Top always goes to the hero, this
  // returns you to the sentence you jumped away from.
  assert.match(aboutSource, /← Back to/, 'the control must render its origin label')
  assert.match(aboutSource, /const goBack = \(\) =>/)
  // An offset, not an element: returning to the origin CHAPTER's heading is
  // not the same as returning to where the reader actually was.
  assert.match(aboutSource, /setBackTo\(\{ top: from, label: fromLabel, left: false \}\)/)
  // The `left` guard is load-bearing. A smooth jump fires scroll events from
  // the origin outwards, so an unguarded "are we back yet" test is true on the
  // first one and cancels the offer before the reader has gone anywhere.
  assert.match(aboutSource, /if \(!prev\.left\) return away > \d+ \? \{ \.\.\.prev, left: true \} : prev/)
})

test('the back control is offered only when the jump actually went somewhere', () => {
  assert.match(
    aboutSource,
    /id !== activeSection && distance > window\.innerHeight \/ 2/,
    'a chip on every click is noise, not an affordance',
  )
})

test('the page width pays for the chapter rail on top of the reading column', () => {
  // v3.5.0 capped the whole shell, so the rail and its gap came out of the
  // text: 1088px of article with 332px of empty paper either side at a 2000px
  // viewport, against 1380/180 for the guide this is modelled on.
  assert.match(cssSource, /\.about-shell\s*\{[^}]*max-width:\s*calc\(var\(--guide-measure\) \+ var\(--guide-rail\)\)/)
  assert.match(aboutSource, /about-shell/)
  assert.doesNotMatch(aboutSource, /max-w-\[1400px\]/, 'the flat cap is what caused the narrow column')
  // The measure grows on very wide screens instead of turning them into margin.
  for (const bp of ['1900px', '2400px']) {
    assert.ok(
      cssSource.includes(`@media (min-width: ${bp})`),
      `the reading measure must widen at ${bp}`,
    )
  }
  // --guide-rail must track the rail's real width + gap, or the column
  // silently changes size.
  assert.match(cssSource, /--guide-rail:\s*15\.5rem/)
  assert.match(aboutSource, /w-\[13rem\][^"]*flex-none/)
  assert.match(aboutSource, /flex gap-10/)
})

test('the sticky chapter bar is opaque, and the wide-screen rail defaults to hidden first', () => {
  const toc = cssSource.match(/\.about-toc\s*\{([^}]*)\}/)
  assert.ok(toc, 'index.css must declare the sticky chapter bar')
  assert.match(toc[1], /position:\s*sticky/)
  assert.match(toc[1], /background-color:\s*var\(--bg\)/)
  // A translucent/blurred sticky bar can fail to composite in Safari and
  // disappear mid-scroll (token-tv guide.css #6).
  assert.doesNotMatch(toc[1], /backdrop-filter/)
  assert.doesNotMatch(aboutSource, /about-toc[^"]*backdrop-blur/)
  // `.about-rail { display: none }` must come BEFORE the rule that turns it on;
  // same specificity means source order decides, and the other way round the
  // rail never appears at any width. Anchored on the rail's own two rules
  // rather than on the media query, since more than one block now opens at
  // this breakpoint.
  const hidden = cssSource.indexOf('.about-rail {\n  display: none;')
  const shown = cssSource.indexOf('.about-rail {\n    display: block;')
  assert.ok(hidden > 0, 'the rail must default to hidden')
  assert.ok(shown > hidden, 'the rail default must precede the rule that shows it')
})

test('index.css scopes the 28px grid to .about-view and keeps the phone override', () => {
  const rule = cssSource.match(/\.about-view\s*\{([^}]*background-size[^}]*)\}/)
  assert.ok(rule, 'index.css must declare a .about-view grid rule')
  assert.match(rule[1], /background-size:\s*28px 28px/)
  assert.match(rule[1], /linear-gradient/)
  // The phone-layout override must survive the new background rule.
  const phoneBlock = cssSource.slice(
    cssSource.indexOf('@media (max-width: 47.99rem) and (pointer: coarse)'),
  )
  assert.match(phoneBlock, /\.about-view\s*\{[\s\S]*?overflow-y:\s*visible/)
  assert.match(phoneBlock, /\.about-view\s*\{[\s\S]*?height:\s*auto/)
})
