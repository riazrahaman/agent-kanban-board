// GH #103 follow-up (v3.2.3, hardened v3.2.4). The module's real behaviour —
// blocking a pinch zoom on a physical iPhone — cannot be exercised here:
// neither Playwright WebKit (a desktop engine) nor Chromium touch emulation
// implements iOS Safari's pinch pipeline, and node:test has no DOM. What IS
// verified, against a minimal fake EventTarget: the wiring (touchmove,
// gesture* on BOTH document and window, each passive:false +
// capture), the decision logic (2+-finger touchmove prevented, 1-finger
// NOT), that no wheel listener is ever registered (it killed desktop
// ctrl+wheel zoom and forced main-thread wheel scrolling), cleanup, that main.tsx
// installs it, and that the reviewed-out `touchend` double-tap guard (it
// cancelled real clicks) never comes back.
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
const ALL_EVENTS = ['touchmove', ...GESTURE_EVENTS]

function fire(target, type, init) {
  let prevented = false
  for (const { handler } of target.listeners.get(type) ?? []) {
    handler({ ...init, preventDefault: () => { prevented = true } })
  }
  return prevented
}

test('installPinchZoomGuard registers every listener on BOTH document and window, non-passive + capture', () => {
  const doc = makeFakeDoc()
  const win = makeFakeDoc()
  mod.installPinchZoomGuard(doc, win)
  for (const target of [doc, win]) {
    for (const type of ALL_EVENTS) {
      const list = target.listeners.get(type)
      assert.equal(list?.length, 1, `expected exactly one ${type} listener`)
      assert.equal(
        list[0].options?.passive,
        false,
        `${type} listener must be { passive: false } or preventDefault() is a silent no-op`,
      )
      assert.equal(list[0].options?.capture, true, `${type} listener must be capture-phase`)
    }
    assert.deepEqual([...target.listeners.keys()].sort(), [...ALL_EVENTS].sort(), 'no other listener types')
  }
})

test('a two-finger touchmove is preventDefault()ed (pinch blocked)', () => {
  const doc = makeFakeDoc()
  mod.installPinchZoomGuard(doc, null)
  assert.equal(fire(doc, 'touchmove', { touches: { length: 2 } }), true)
  assert.equal(fire(doc, 'touchmove', { touches: { length: 3 } }), true)
})

test('a one-finger touchmove is NOT preventDefault()ed (scrolling/swiping untouched)', () => {
  const doc = makeFakeDoc()
  mod.installPinchZoomGuard(doc, null)
  assert.equal(fire(doc, 'touchmove', { touches: { length: 1 } }), false)
  assert.equal(fire(doc, 'touchmove', { touches: { length: 1 }, scale: 1 }), false)
})

test('a WebKit touchmove with scale != 1 is preventDefault()ed even if touches is missing', () => {
  assert.equal(mod.isPinchTouch({ scale: 1.4, preventDefault() {} }), true)
  assert.equal(mod.isPinchTouch({ scale: 1, preventDefault() {} }), false)
  assert.equal(mod.isPinchTouch({ preventDefault() {} }), false)
})

test('each gesture listener calls preventDefault when invoked', () => {
  const doc = makeFakeDoc()
  mod.installPinchZoomGuard(doc, null)
  for (const type of GESTURE_EVENTS) {
    assert.equal(fire(doc, type, {}), true, `${type} handler must call preventDefault()`)
  }
})

test('no wheel listener: desktop ctrl+wheel zoom and compositor wheel scrolling stay intact', () => {
  const doc = makeFakeDoc()
  const win = makeFakeDoc()
  mod.installPinchZoomGuard(doc, win)
  assert.equal(doc.listeners.get('wheel'), undefined)
  assert.equal(win.listeners.get('wheel'), undefined)
  assert.doesNotMatch(pinchZoomGuardSource, /\['wheel'|addEventListener\(\s*['"]wheel['"]/, 'pinchZoomGuard.ts must never register a wheel listener')
})

test('the cleanup function removes every listener it installed, from both targets', () => {
  const doc = makeFakeDoc()
  const win = makeFakeDoc()
  const cleanup = mod.installPinchZoomGuard(doc, win)
  cleanup()
  for (const target of [doc, win]) {
    for (const type of ALL_EVENTS) {
      assert.equal(target.listeners.get(type)?.length, 0, `${type} listener must be removed by cleanup`)
    }
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
  mod.installPinchZoomGuard(doc, null)
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
