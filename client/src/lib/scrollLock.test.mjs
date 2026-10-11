// v3.2.4 phone layout: the document scrolls, so overlays (TaskSheet,
// BugReportDialog, the phone Signal Rail drawer) freeze it and restore the
// exact scroll position. Pure lock logic against a fake document/window;
// the rendered behaviour is checked in a real browser (CHANGELOG 3.2.4).
// The hook needs React, so it is stubbed out of the bundle.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const result = await build({
  entryPoints: [join(__dirname, 'scrollLock.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  plugins: [{
    name: 'stub-react',
    setup(b) {
      b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const useEffect = () => {}', loader: 'js' }))
    },
  }],
})
const tmpDir = await mkdtemp(join(tmpdir(), 'scrollLock-test-'))
const tmpFile = join(tmpDir, 'scrollLock.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const mod = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

function fakeEnv(scrollY) {
  const classes = new Set()
  const win = {
    scrollY,
    scrolledTo: null,
    scrollTo(x, y) { this.scrolledTo = y; this.scrollY = y },
  }
  const vars = new Map()
  const doc = {
    documentElement: {
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      style: { setProperty: (k, v) => vars.set(k, v), removeProperty: (k) => vars.delete(k) },
    },
    body: { style: { top: '' } },
  }
  return { doc, win, classes, vars }
}

test('lock pins body at -scrollY and adds the class; release restores the exact position', () => {
  const { doc, win, classes, vars } = fakeEnv(420)
  const release = mod.lockDocumentScroll(doc, win)
  assert.equal(doc.body.style.top, '-420px')
  assert.equal(vars.get('--scroll-lock-y'), '420px', 'lets the sticky header be shifted back into view')
  assert.ok(classes.has(mod.SCROLL_LOCK_CLASS))
  win.scrollY = 0 // body is fixed while locked, so the window reports 0
  release()
  assert.equal(classes.has(mod.SCROLL_LOCK_CLASS), false)
  assert.equal(doc.body.style.top, '')
  assert.equal(win.scrolledTo, 420)
  assert.equal(vars.has('--scroll-lock-y'), false)
  assert.equal(mod.scrollLockCount(), 0)
})

test('stacked overlays: only the last release unlocks, and the FIRST saved position wins', () => {
  const { doc, win, classes } = fakeEnv(300)
  const a = mod.lockDocumentScroll(doc, win)
  win.scrollY = 0
  const b = mod.lockDocumentScroll(doc, win)
  assert.equal(doc.body.style.top, '-300px', 'a nested lock must not overwrite the saved offset with 0')
  a()
  assert.ok(classes.has(mod.SCROLL_LOCK_CLASS), 'still locked while one overlay remains')
  assert.equal(win.scrolledTo, null)
  b()
  assert.equal(classes.has(mod.SCROLL_LOCK_CLASS), false)
  assert.equal(win.scrolledTo, 300)
})

test('a release function is idempotent (double close cannot unbalance the count)', () => {
  const { doc, win } = fakeEnv(10)
  const a = mod.lockDocumentScroll(doc, win)
  a()
  a()
  assert.equal(mod.scrollLockCount(), 0)
  const b = mod.lockDocumentScroll(doc, win)
  assert.equal(mod.scrollLockCount(), 1)
  b()
})

test('PHONE_LAYOUT_QUERY is touch AND below md (Tailwind max-md = width < 48rem)', () => {
  assert.equal(mod.PHONE_LAYOUT_QUERY, '(max-width: 47.99rem) and (pointer: coarse)')
})

function fakeQuery(matches) {
  const listeners = new Set()
  return {
    matches,
    addEventListener: (_t, l) => listeners.add(l),
    removeEventListener: (_t, l) => listeners.delete(l),
    set(m) { this.matches = m; for (const l of [...listeners]) l() },
    listeners,
  }
}
function countingLock() {
  const log = []
  return { log, lock: () => { log.push('lock'); return () => log.push('release') } }
}

test('bindScrollLockToQuery: locks only while the phone query matches', () => {
  const mq = fakeQuery(false)
  const { log, lock } = countingLock()
  const dispose = mod.bindScrollLockToQuery(mq, lock)
  assert.deepEqual(log, [], 'landscape/desktop: nothing to lock')
  dispose()
  assert.equal(mq.listeners.size, 0)
})

test('rotation while locked: leaving the phone layout releases (restores), returning re-locks', () => {
  const mq = fakeQuery(true)
  const { log, lock } = countingLock()
  const dispose = mod.bindScrollLockToQuery(mq, lock)
  assert.deepEqual(log, ['lock'])
  mq.set(false) // rotate to landscape: never leave body fixed in the desktop layout
  assert.deepEqual(log, ['lock', 'release'])
  mq.set(true) // back to portrait with the overlay still open
  assert.deepEqual(log, ['lock', 'release', 'lock'])
  dispose()
  assert.deepEqual(log, ['lock', 'release', 'lock', 'release'])
  assert.equal(mq.listeners.size, 0)
})

test('overlay opened in landscape, then rotated to portrait: the lock applies then', () => {
  const mq = fakeQuery(false)
  const { log, lock } = countingLock()
  const dispose = mod.bindScrollLockToQuery(mq, lock)
  mq.set(true)
  assert.deepEqual(log, ['lock'])
  dispose()
  assert.deepEqual(log, ['lock', 'release'])
})

test('end to end with the real lock: rotate away while locked restores the position and unpins body', () => {
  const { doc, win, classes } = fakeEnv(500)
  const mq = fakeQuery(true)
  const dispose = mod.bindScrollLockToQuery(mq, () => mod.lockDocumentScroll(doc, win))
  assert.equal(doc.body.style.top, '-500px')
  mq.set(false)
  assert.equal(doc.body.style.top, '', 'body must not stay fixed at a negative top in the desktop layout')
  assert.equal(classes.has(mod.SCROLL_LOCK_CLASS), false)
  assert.equal(win.scrolledTo, 500)
  dispose()
  assert.equal(mod.scrollLockCount(), 0)
})
