import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))

const result = await build({
  entryPoints: [join(__dirname, 'filterTasks.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})

const tmpDir = await mkdtemp(join(tmpdir(), 'filter-test-'))
const tmpFile = join(tmpDir, 'filterTasks.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const { filterTasks } = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

const SAMPLE_TASKS = [
  {
    id: 'TASK-1',
    project: 'kanbann',
    title: 'Fix auth session bug',
    description: 'Investigate token expiry',
    status: 'BUILDING',
    priority: 'high',
    assigned_agent: 'builder-1',
    agent_logs: [],
    metadata: {},
    version: 1,
  },
  {
    id: 'TASK-2',
    project: 'kanbann',
    title: 'Add search bar',
    description: 'Filter tasks by keyword',
    status: 'BACKLOG',
    priority: 'P0',
    assigned_agent: null,
    branch: 'feat/search',
    agent_logs: [],
    metadata: {},
    version: 1,
  },
  {
    id: 'TASK-3',
    project: 'kanbann',
    title: 'Update documentation',
    description: 'Write ONBOARDING guide',
    status: 'DONE',
    priority: 'low',
    assigned_agent: 'docs-writer',
    agent_logs: [],
    metadata: {},
    version: 1,
  },
]

test('returns all tasks when criteria are empty', () => {
  const res = filterTasks(SAMPLE_TASKS, { search: '', priority: 'all', assignee: 'all' })
  assert.equal(res.length, 3)
})

test('filters tasks by search matching title or description', () => {
  const byTitle = filterTasks(SAMPLE_TASKS, { search: 'auth', priority: 'all', assignee: 'all' })
  assert.equal(byTitle.length, 1)
  assert.equal(byTitle[0].id, 'TASK-1')

  const byDesc = filterTasks(SAMPLE_TASKS, { search: 'keyword', priority: 'all', assignee: 'all' })
  assert.equal(byDesc.length, 1)
  assert.equal(byDesc[0].id, 'TASK-2')
})

test('filters tasks by search matching id or branch', () => {
  const byId = filterTasks(SAMPLE_TASKS, { search: 'TASK-3', priority: 'all', assignee: 'all' })
  assert.equal(byId.length, 1)
  assert.equal(byId[0].id, 'TASK-3')

  const byBranch = filterTasks(SAMPLE_TASKS, { search: 'feat/search', priority: 'all', assignee: 'all' })
  assert.equal(byBranch.length, 1)
  assert.equal(byBranch[0].id, 'TASK-2')
})

test('filters tasks by priority matching normalized rank', () => {
  const high = filterTasks(SAMPLE_TASKS, { search: '', priority: 'high', assignee: 'all' })
  // TASK-1 (high) and TASK-2 (P0) both normalize to high
  assert.equal(high.length, 2)
  assert.ok(high.some((t) => t.id === 'TASK-1'))
  assert.ok(high.some((t) => t.id === 'TASK-2'))

  const low = filterTasks(SAMPLE_TASKS, { search: '', priority: 'low', assignee: 'all' })
  assert.equal(low.length, 1)
  assert.equal(low[0].id, 'TASK-3')
})

test('filters tasks by assignee including unassigned', () => {
  const unassigned = filterTasks(SAMPLE_TASKS, { search: '', priority: 'all', assignee: 'unassigned' })
  assert.equal(unassigned.length, 1)
  assert.equal(unassigned[0].id, 'TASK-2')

  const builder = filterTasks(SAMPLE_TASKS, { search: '', priority: 'all', assignee: 'builder-1' })
  assert.equal(builder.length, 1)
  assert.equal(builder[0].id, 'TASK-1')
})

test('filters tasks by multiple combined criteria', () => {
  const match = filterTasks(SAMPLE_TASKS, { search: 'search', priority: 'high', assignee: 'unassigned' })
  assert.equal(match.length, 1)
  assert.equal(match[0].id, 'TASK-2')

  const noMatch = filterTasks(SAMPLE_TASKS, { search: 'search', priority: 'low', assignee: 'unassigned' })
  assert.equal(noMatch.length, 0)
})
