import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))

const result = await build({
  entryPoints: [join(__dirname, 'boardSort.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})

const tmpDir = await mkdtemp(join(tmpdir(), 'boardsort-test-'))
const tmpFile = join(tmpDir, 'boardSort.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const { sortTasks, DEFAULT_SORT, SORT_OPTIONS, SORT_STORAGE_KEY } = await import(
  pathToFileURL(tmpFile).href
)
await rm(tmpDir, { recursive: true, force: true })

const BASE = { project: 'p', status: 'BACKLOG', agent_logs: [], metadata: {}, version: 1 }

function task(id, priority, updated) {
  return { ...BASE, id, title: id, priority, updated }
}

test('priority sort ranks high before medium before low', () => {
  const tasks = [
    task('t-low', 'low', '2026-01-01T00:00:00Z'),
    task('t-high-a', 'high', '2026-01-01T00:00:00Z'),
    task('t-med', 'medium', '2026-01-01T00:00:00Z'),
    task('t-high-b', 'P0', '2026-01-01T00:00:00Z'),
  ]
  const sorted = sortTasks(tasks, 'priority')
  const ids = sorted.map((t) => t.id)
  assert.ok(ids.indexOf('t-high-a') < ids.indexOf('t-med'))
  assert.ok(ids.indexOf('t-high-b') < ids.indexOf('t-med'))
  assert.ok(ids.indexOf('t-med') < ids.indexOf('t-low'))
})

test('priority sort is stable for equal ranks (keeps server recency order)', () => {
  const tasks = [task('first', 'high', 'x'), task('second', 'high', 'x'), task('third', 'high', 'x')]
  const sorted = sortTasks(tasks, 'priority')
  assert.deepEqual(
    sorted.map((t) => t.id),
    ['first', 'second', 'third'],
  )
})

test('updated sort is newest first', () => {
  const tasks = [
    task('a', 'low', '2026-01-01T00:00:00Z'),
    task('c', 'low', '2026-03-01T00:00:00Z'),
    task('b', 'low', '2026-02-01T00:00:00Z'),
  ]
  const sorted = sortTasks(tasks, 'updated')
  assert.deepEqual(
    sorted.map((t) => t.id),
    ['c', 'b', 'a'],
  )
})

test('id sort is lexical A→Z', () => {
  const tasks = [task('zz', 'low', 'x'), task('aa', 'low', 'x'), task('mm', 'low', 'x')]
  const sorted = sortTasks(tasks, 'id')
  assert.deepEqual(
    sorted.map((t) => t.id),
    ['aa', 'mm', 'zz'],
  )
})

test('empty list sorts to an empty list', () => {
  assert.deepEqual(sortTasks([], 'priority'), [])
  assert.deepEqual(sortTasks([], 'updated'), [])
  assert.deepEqual(sortTasks([], 'id'), [])
})

test('sortTasks never mutates the input array', () => {
  const tasks = [task('a', 'low', '2026-01-01T00:00:00Z'), task('b', 'high', '2026-01-01T00:00:00Z')]
  const before = [...tasks]
  sortTasks(tasks, 'priority')
  assert.deepEqual(tasks.map((t) => t.id), before.map((t) => t.id))
})

test('unknown sort falls back to the incoming order (default export shape intact)', () => {
  const tasks = [task('a', 'low', 'x'), task('b', 'high', 'x')]
  const sorted = sortTasks(tasks, /** @type {any} */ ('bogus'))
  assert.deepEqual(
    sorted.map((t) => t.id),
    ['a', 'b'],
  )
})

test('constants expose the contract used by the UI', () => {
  assert.equal(DEFAULT_SORT, 'priority')
  assert.equal(SORT_STORAGE_KEY, 'kanban.sort')
  assert.deepEqual(
    SORT_OPTIONS.map((o) => o.value),
    ['priority', 'updated', 'id'],
  )
})