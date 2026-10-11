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
  const doc = {
    documentElement: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } },
    body: { style: { top: '' } },
  }
  return { doc, win, classes }
}

test('lock pins body at -scrollY and adds the class; release restores the exact position', () => {
  const { doc, win, classes } = fakeEnv(420)
  const release = mod.lockDocumentScroll(doc, win)
  assert.equal(doc.body.style.top, '-420px')
  assert.ok(classes.has(mod.SCROLL_LOCK_CLASS))
  win.scrollY = 0 // body is fixed while locked, so the window reports 0
  release()
  assert.equal(classes.has(mod.SCROLL_LOCK_CLASS), false)
  assert.equal(doc.body.style.top, '')
  assert.equal(win.scrolledTo, 420)
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
