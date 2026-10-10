// v3.2.3 (GH #103 follow-up). The module's real behaviour — blocking a pinch
// zoom on a physical iPhone — cannot be exercised here: Playwright WebKit is
// a desktop engine with no touch/gesture pipeline (see pinchZoomGuard.ts's
// header comment for the full reasoning), and this repo's plain node:test
// runner has no DOM at all. What IS verified: `installPinchZoomGuard`'s DOM
// *wiring* against a minimal fake `EventTarget`-like document (the right
// event names, each one `{ passive: false }`, cleanup actually removes
// them), a source-contract check that main.tsx installs it, and — per round-1
// review — a source-contract guard that the `touchend` double-tap guard this
// module originally shipped with does NOT come back: it `preventDefault()`d
// the second of any two touchends within 350ms regardless of target, which
// cancelled the following click for a real user double-tapping two
// different buttons, swiping then quickly tapping a card, or double-tap-
// selecting a word in a textarea. It was also redundant: root
// `touch-action: pan-x pan-y` (index.css) already blocks double-tap-zoom —
// no `pinch-zoom` keyword means no zoom gesture of either kind.
// esbuild bundles the TS source into ESM at test time, mirroring
// authToken.test.mjs / claimCoordinator.test.mjs.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pinchZoomGuardSource = readFileSync(join(__dirname, 'pinchZoomGuard.ts'), 'utf8')

const result = await build({
  entryPoints: [join(__dirname, 'pinchZoomGuard.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})
const tmpDir = await mkdtemp(join(tmpdir(), 'pinchZoomGuard-test-'))
const tmpFile = join(tmpDir, 'pinchZoomGuard.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const mod = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// installPinchZoomGuard — DOM wiring, against a minimal fake document
// ---------------------------------------------------------------------------

function makeFakeDoc() {
  const listeners = new Map() // type -> [{ handler, options }]
  return {
    listeners,
    addEventListener(type, handler, options) {
      const list = listeners.get(type) ?? []
      list.push({ handler, options })
      listeners.set(type, list)
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) ?? []
      listeners.set(
        type,
        list.filter((l) => l.handler !== handler),
      )
    },
  }
}

const GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend']

test('installPinchZoomGuard registers the WebKit gesture events, all non-passive', () => {
  const doc = makeFakeDoc()
  mod.installPinchZoomGuard(doc)
  for (const type of GESTURE_EVENTS) {
    const list = doc.listeners.get(type)
    assert.equal(list?.length, 1, `expected exactly one ${type} listener`)
    assert.equal(
      list[0].options?.passive,
      false,
      `${type} listener must be { passive: false } or preventDefault() is a silent no-op`,
    )
  }
})

test('installPinchZoomGuard registers no other listener type (e.g. no touchend)', () => {
  const doc = makeFakeDoc()
  mod.installPinchZoomGuard(doc)
  assert.deepEqual(
    [...doc.listeners.keys()].sort(),
    [...GESTURE_EVENTS].sort(),
    'installPinchZoomGuard must register exactly the three gesture events and nothing else',
  )
})

test('each gesture listener calls preventDefault when invoked', () => {
  const doc = makeFakeDoc()
  mod.installPinchZoomGuard(doc)
  for (const type of GESTURE_EVENTS) {
    const [{ handler }] = doc.listeners.get(type)
    let prevented = false
    handler({ preventDefault: () => { prevented = true } })
    assert.equal(prevented, true, `${type} handler must call preventDefault()`)
  }
})

test('the cleanup function removes every listener it installed', () => {
  const doc = makeFakeDoc()
  const cleanup = mod.installPinchZoomGuard(doc)
  for (const type of GESTURE_EVENTS) {
    assert.equal(doc.listeners.get(type)?.length, 1)
  }
  cleanup()
  for (const type of GESTURE_EVENTS) {
    assert.equal(doc.listeners.get(type)?.length, 0, `${type} listener must be removed by cleanup`)
  }
})

// ---------------------------------------------------------------------------
// Round-1 review regression guard: no touchend double-tap guard.
// ---------------------------------------------------------------------------

test('pinchZoomGuard.ts never re-adds a touchend listener (regression: it cancelled real clicks)', () => {
  assert.doesNotMatch(
    pinchZoomGuardSource,
    /addEventListener\(\s*['"]touchend['"]/,
    'pinchZoomGuard.ts must not register a touchend listener — a 350ms-window ' +
      'preventDefault() on touchend cancels the following click for a real user ' +
      '(double-tapping two different buttons, swipe-then-tap, double-tap word-select ' +
      'in a textarea), and is redundant: touch-action: pan-x pan-y already blocks ' +
      'double-tap-zoom',
  )
  assert.doesNotMatch(
    pinchZoomGuardSource,
    /isDoubleTap/,
    'the isDoubleTap helper must not come back either — it only existed to support the removed touchend guard',
  )
})

test('installPinchZoomGuard never registers a touchend listener at runtime', () => {
  const doc = makeFakeDoc()
  mod.installPinchZoomGuard(doc)
  assert.equal(doc.listeners.get('touchend'), undefined, 'no touchend listener may be installed')
})

// ---------------------------------------------------------------------------
// main.tsx must actually install the guard — the module above is inert on
// its own until something calls it at startup.
// ---------------------------------------------------------------------------

test('main.tsx installs the pinch-zoom guard at startup', () => {
  const mainSource = readFileSync(join(__dirname, '..', 'main.tsx'), 'utf8')
  assert.match(
    mainSource,
    /import \{ installPinchZoomGuard \} from '\.\/lib\/pinchZoomGuard'/,
    'main.tsx must import installPinchZoomGuard from lib/pinchZoomGuard',
  )
  assert.match(
    mainSource,
    /installPinchZoomGuard\(\)/,
    'main.tsx must call installPinchZoomGuard() so the guard is actually wired up',
  )
})
