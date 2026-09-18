// Tester-added assertions (Pipeline D verification, item 3):
//   a) groupTasks is pure: same input -> same output (fresh deep copy, so the
//      "first === second" shortcut cannot mask a no-op).
//   b) The memo comparators (areEqual) actually gate on id+version:
//     - returns TRUE for unchanged id+version (even when object identity differs)
//     - returns FALSE when version bumps
//   The comparators are captured by bundling each component with a stubbed
//   `react` module (alias) whose `memo()` hands back the comparator, so no
//   jsdom/testing-library is needed.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { groupTasks } from '../board-model.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function task(overrides) {
  return {
    id: 'x',
    title: 't',
    description: '',
    status: 'BACKLOG',
    priority: 'medium',
    assigned_agent: null,
    agent_logs: [],
    metadata: {},
    version: 1,
    ...overrides,
  }
}

test('groupTasks is pure: same input (fresh copy) -> structurally identical output', () => {
  const tasks = [
    task({ id: 'a', status: 'BACKLOG' }),
    task({ id: 'b', status: 'BUILDING', issues: ['i1'] }),
    task({ id: 'c', status: 'DONE' }),
    task({ id: 'd', status: 'wat' }),
  ]
  const first = groupTasks(tasks)
  const freshCopy = tasks.map((t) => ({ ...t, agent_logs: [...t.agent_logs], metadata: { ...t.metadata } }))
  const second = groupTasks(freshCopy)

  assert.deepEqual(second, first, 'same input -> same output (fresh object identities)')
  assert.notEqual(second.BACKLOG, first.BACKLOG, 'no shared bucket arrays between calls')
})

// Stub react: memo(fn, areEqual) => export areEqual so the test can call it.
const reactStub = `
export const memo = (fn, areEqual) => ({ $$typeof: Symbol.for('react.memo'), areEqual })
export const useMemo = (fn) => fn()
export const useCallback = (fn) => fn
export const useState = (init) => [init, () => {}]
export const useEffect = () => {}
export const useRef = (init) => ({ current: init })
export const createElement = (type, props, ...children) => ({ type, props, children })
export default { memo, useMemo, useCallback, useState, useEffect, useRef, createElement }
`

const stubPath = join(__dirname, 'reactStubForMemoTest.mjs')

async function bundleWithStubbedReact(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    alias: { react: stubPath },
  })
  const tmpDir = await mkdtemp(join(tmpdir(), 'memo-cmp-test-'))
  const tmpFile = join(tmpDir, 'bundle.mjs')
  await writeFile(tmpFile, result.outputFiles[0].text)
  const mod = await import(pathToFileURL(tmpFile).href)
  await rm(tmpDir, { recursive: true, force: true })
  return mod
}

test('TaskCard comparator gates re-renders on id+version', async () => {
  const card = await bundleWithStubbedReact(join(__dirname, '..', 'components', 'TaskCard.tsx'))

  const areEqual = card.default.areEqual
  assert.equal(typeof areEqual, 'function', 'custom comparator captured via react stub')

  const onOpen = () => {}
  const taskA = task({ id: 't1', version: 3 })
  const sameRefs = { task: taskA, onOpen }
  assert.equal(areEqual(sameRefs, { task: { ...taskA }, onOpen }), true,
    'unchanged id+version (new object identity) -> comparator returns true')
  assert.equal(areEqual(sameRefs, { task: { ...taskA, version: 4 }, onOpen }), false,
    'version bump -> comparator returns false')
  assert.equal(areEqual(sameRefs, { task: { ...taskA, id: 't2' }, onOpen }), false,
    'id change -> comparator returns false')
  assert.equal(areEqual(sameRefs, { task: taskA, onOpen: () => {} }), false,
    'unstable onOpen -> comparator returns false')
})

test('Column comparator gates re-renders on id+version signature of the bucket', async () => {
  const column = await bundleWithStubbedReact(join(__dirname, '..', 'components', 'Column.tsx'))

  const areEqual = column.default.areEqual
  assert.equal(typeof areEqual, 'function', 'custom comparator captured via react stub')

  const onOpen = () => {}
  const tasksA = [task({ id: 't1', version: 3 }), task({ id: 't2', version: 1 })]
  const propsBase = { status: 'BACKLOG', title: 'Backlog', tasks: tasksA, onOpen }

  assert.equal(areEqual(propsBase, { ...propsBase, tasks: [{ ...tasksA[0] }, { ...tasksA[1] }] }), true,
    'unchanged id+version signatures (fresh array + objects) -> true')
  assert.equal(areEqual(propsBase, { ...propsBase, tasks: [...tasksA, task({ id: 't3' })] }), false,
    'bucket length change -> false')
  assert.equal(areEqual(propsBase, { ...propsBase, tasks: [tasksA[1], tasksA[0]] }), false,
    'reordered members (signature mismatch) -> false')
  assert.equal(areEqual(propsBase, { ...propsBase, tasks: [{ ...tasksA[0], version: 4 }, tasksA[1]] }), false,
    'member version bump -> false')
  assert.equal(areEqual(propsBase, { ...propsBase, onOpen: () => {} }), false,
    'unstable onOpen -> false')
})