// v3.2.3 (GH #103 follow-up). The module's real behaviour — blocking a pinch
// or double-tap zoom on a physical iPhone — cannot be exercised here:
// Playwright WebKit is a desktop engine with no touch/gesture pipeline (see
// pinchZoomGuard.ts's header comment for the full reasoning), and this repo's
// plain node:test runner has no DOM at all. What IS verified:
//   1. `isDoubleTap`, the one pure decision, with real unit tests.
//   2. `installPinchZoomGuard`'s DOM *wiring* against a minimal fake
//      `EventTarget`-like document: the right event names, each one
//      `{ passive: false }` (a passive listener's preventDefault() is a
//      silent no-op — the single most common way this kind of guard ships
//      broken), and that the returned cleanup actually removes them.
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
// isDoubleTap — pure
// ---------------------------------------------------------------------------

test('isDoubleTap: two touchends inside the threshold count as a double-tap', () => {
  assert.equal(mod.isDoubleTap(1000, 1000 + mod.DOUBLE_TAP_THRESHOLD_MS), true)
  assert.equal(mod.isDoubleTap(1000, 1150), true)
  assert.equal(mod.isDoubleTap(1000, 1000), true, 'zero delta (same tick) still counts')
})

test('isDoubleTap: two touchends further apart than the threshold do not count', () => {
  assert.equal(mod.isDoubleTap(1000, 1000 + mod.DOUBLE_TAP_THRESHOLD_MS + 1), false)
  assert.equal(mod.isDoubleTap(1000, 5000), false)
})

test('isDoubleTap: a negative delta (clock skew / out-of-order events) never counts', () => {
  assert.equal(mod.isDoubleTap(1000, 999), false)
  assert.equal(mod.isDoubleTap(1000, 0), false)
})

test('isDoubleTap: a custom threshold is honoured', () => {
  assert.equal(mod.isDoubleTap(0, 100, 50), false)
  assert.equal(mod.isDoubleTap(0, 50, 50), true)
})

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

test('installPinchZoomGuard registers a non-passive touchend double-tap guard', () => {
  const doc = makeFakeDoc()
  mod.installPinchZoomGuard(doc)
  const list = doc.listeners.get('touchend')
  assert.equal(list?.length, 1, 'expected exactly one touchend listener')
  assert.equal(list[0].options?.passive, false, 'touchend listener must be { passive: false }')
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

test('the touchend handler only prevents default on a genuine double-tap', () => {
  const doc = makeFakeDoc()
  let now = 1000
  const realDateNow = Date.now
  Date.now = () => now
  try {
    mod.installPinchZoomGuard(doc)
    const [{ handler }] = doc.listeners.get('touchend')

    let prevented = false
    const evt = () => ({ preventDefault: () => { prevented = true } })

    handler(evt()) // first tap: nothing to compare against yet
    assert.equal(prevented, false, 'a lone tap must not be blocked')

    now += 100 // well inside the double-tap window
    prevented = false
    handler(evt())
    assert.equal(prevented, true, 'a second tap inside the threshold must be blocked')

    now += 5000 // well outside the window
    prevented = false
    handler(evt())
    assert.equal(prevented, false, 'a tap long after the previous one must not be blocked')
  } finally {
    Date.now = realDateNow
  }
})

test('the cleanup function removes every listener it installed', () => {
  const doc = makeFakeDoc()
  const cleanup = mod.installPinchZoomGuard(doc)
  for (const type of [...GESTURE_EVENTS, 'touchend']) {
    assert.equal(doc.listeners.get(type)?.length, 1)
  }
  cleanup()
  for (const type of [...GESTURE_EVENTS, 'touchend']) {
    assert.equal(doc.listeners.get(type)?.length, 0, `${type} listener must be removed by cleanup`)
  }
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
