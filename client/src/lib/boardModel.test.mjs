// Plain-JS (.mjs) test for the client's board grouping + memoization.
// `board-model.js` and `status.js` are plain ESM (package.json has
// "type": "module"), so they run directly under `node --test` with no
// esbuild bundling. `Column`/`TaskCard` are TSX, so they are bundled to ESM
// at test time via esbuild (already a client devDependency) and their
// React.memo wrapper is asserted on the default export.
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

test('groupTasks is deterministic and bucketed by normalized status', () => {
  const tasks = [
    task({ id: 'a', status: 'BACKLOG' }),
    task({ id: 'b', status: 'BUILDING' }),
    task({ id: 'c', status: 'todo' }),
    task({ id: 'd', status: 'in_progress' }),
    task({ id: 'e', status: 'BUILDING', issues: ['x'] }),
  ]
  const first = groupTasks(tasks)
  const second = groupTasks(tasks)

  assert.deepEqual(first, second, 'same input -> same output')

  assert.deepEqual(first.BACKLOG.map((t) => t.id), ['a', 'c'])
  assert.deepEqual(first.BUILDING.map((t) => t.id), ['b', 'd', 'e'])
  assert.deepEqual(first.ISSUES.map((t) => t.id), ['e'], 'issues mirror into ISSUES bucket')
  assert.equal(first.DONE.length, 0)
})

test('groupTasks normalizes unknown statuses into UNKNOWN bucket', () => {
  const grouped = groupTasks([task({ id: 'z', status: 'wat' })])
  assert.deepEqual(grouped.UNKNOWN.map((t) => t.id), ['z'])
})

test('Column and TaskCard are wrapped in React.memo', async () => {
  const bundle = async (entry) => {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'node20',
    })
    const tmpDir = await mkdtemp(join(tmpdir(), 'memo-test-'))
    const tmpFile = join(tmpDir, 'bundle.mjs')
    await writeFile(tmpFile, result.outputFiles[0].text)
    const mod = await import(pathToFileURL(tmpFile).href)
    await rm(tmpDir, { recursive: true, force: true })
    return mod
  }

  const reactMemo = Symbol.for('react.memo')

  const column = await bundle(join(__dirname, '..', 'components', 'Column.tsx'))
  assert.equal(column.default.$$typeof, reactMemo, 'Column is memoized')

  const card = await bundle(join(__dirname, '..', 'components', 'TaskCard.tsx'))
  assert.equal(card.default.$$typeof, reactMemo, 'TaskCard is memoized')
})
