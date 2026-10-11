// v3.2.4 phone layout, reviewer round 2: the document scrolls and all
// columns share that one vertical position, so a ~300-card DONE column made
// an enormous page, short columns rendered as tall empty boxes, and swiping
// from deep in DONE to READY landed on empty space. Pure helpers here; the
// rendered behaviour (cap, short columns, sticky column bar, page alignment
// after a swipe) is checked in a real browser (CHANGELOG 3.2.4) and the
// wiring by source contract below.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const result = await build({ entryPoints: [join(__dirname, 'phoneBoard.ts')], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node20' })
const tmpDir = await mkdtemp(join(tmpdir(), 'phoneBoard-test-'))
const tmpFile = join(tmpDir, 'phoneBoard.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const mod = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

const columnSource = readFileSync(join(__dirname, '..', 'components', 'Column.tsx'), 'utf8')
const boardSource = readFileSync(join(__dirname, '..', 'components', 'Board.tsx'), 'utf8')

const range = (n) => Array.from({ length: n }, (_, i) => i)

test('capCards: phones render the first 25 cards and report the hidden remainder', () => {
  assert.equal(mod.PHONE_CARD_LIMIT, 25)
  const { shown, hidden } = mod.capCards(range(300), 25, false)
  assert.equal(shown.length, 25)
  assert.deepEqual(shown, range(25), 'keeps the column order (first 25)')
  assert.equal(hidden, 275)
})

test('capCards: no cap without a limit (desktop/tablet), at or under the limit, or once expanded', () => {
  assert.deepEqual(mod.capCards(range(300), undefined, false), { shown: range(300), hidden: 0 })
  assert.deepEqual(mod.capCards(range(25), 25, false), { shown: range(25), hidden: 0 })
  assert.deepEqual(mod.capCards(range(300), 25, true), { shown: range(300), hidden: 0 })
})

test('snappedColumnIndex rounds to the nearest column and clamps', () => {
  assert.equal(mod.snappedColumnIndex(0, 347.5, 10), 0)
  assert.equal(mod.snappedColumnIndex(340, 347.5, 10), 1)
  assert.equal(mod.snappedColumnIndex(547, 381.5, 10), 1, 'a proximity-snap fling resting between points counts as the nearest column')
  assert.equal(mod.snappedColumnIndex(99999, 347.5, 10), 9)
  assert.equal(mod.snappedColumnIndex(-5, 347.5, 10), 0)
  assert.equal(mod.snappedColumnIndex(100, 0, 10), 0, 'unmeasurable pitch')
  assert.equal(mod.snappedColumnIndex(100, 300, 0), 0)
})

test('columnAlignTarget: a column whose top is hidden under the sticky chrome is brought just under it', () => {
  // deep in DONE: board top far above; switching to READY (same top)
  assert.equal(mod.columnAlignTarget(-3200, 147, 3429), 3429 - 3200 - 147)
  // column top already visible below the chrome -> leave the page alone
  assert.equal(mod.columnAlignTarget(147, 147, 69), null)
  assert.equal(mod.columnAlignTarget(400, 147, 0), null)
  // never negative
  assert.equal(mod.columnAlignTarget(-10, 147, 0), 0)
})

test('Column wiring: cap only when Board passes cardLimit; 44px "Show N more"; header count stays the full total', () => {
  assert.match(columnSource, /capCards\(tasks, cardLimit, expanded\)/)
  assert.match(columnSource, /\{shown\.map\(\(task\) =>/, 'render the capped slice')
  assert.match(columnSource, /prev\.cardLimit === next\.cardLimit/, 'the memo comparator must include cardLimit')
  const btn = columnSource.match(/data-testid="show-more-cards"\s*className="([^"]*)"/)?.[1] ?? ''
  assert.match(btn, /\bpointer-coarse:min-h-11\b/, '44px tap target on touch')
  assert.match(columnSource, /Show \{hidden\} more/)
  assert.match(columnSource, /\{tasks\.length\}/, 'the column header count is the full total, not the capped slice')
})

test('Board wiring: cap + column bar + alignment only in the phone layout', () => {
  assert.match(boardSource, /useMediaQuery\(PHONE_LAYOUT_QUERY\)/)
  assert.match(boardSource, /cardLimit=\{isPhone \? PHONE_CARD_LIMIT : undefined\}/)
  assert.match(boardSource, /\{isPhone && activeColumn && \(/, 'the sticky column bar renders only on phones')
  assert.match(boardSource, /className="column-indicator /)
  assert.match(boardSource, /if \(!isPhone \|\| !el\) return/, 'the alignment effect is phone-only')
  assert.match(boardSource, /performance\.now\(\) - lastUserVScroll < 250\) return/, 'never fight a vertical scroll in progress')
  assert.match(boardSource, /setTimeout\(settle, 150\)/, 'debounced until the horizontal swipe settles')
  assert.match(boardSource, /columnAlignTarget\(/)
})
