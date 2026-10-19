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
  const res = filterTasks(SAMPLE_TASKS, { search: '', priority: 'all', assignee: 'all', severity: [] })
  assert.equal(res.length, 3)
})

test('filters tasks by search matching title or description', () => {
  const byTitle = filterTasks(SAMPLE_TASKS, { search: 'auth', priority: 'all', assignee: 'all', severity: [] })
  assert.equal(byTitle.length, 1)
  assert.equal(byTitle[0].id, 'TASK-1')

  const byDesc = filterTasks(SAMPLE_TASKS, { search: 'keyword', priority: 'all', assignee: 'all', severity: [] })
  assert.equal(byDesc.length, 1)
  assert.equal(byDesc[0].id, 'TASK-2')
})

test('filters tasks by search matching id or branch', () => {
  const byId = filterTasks(SAMPLE_TASKS, { search: 'TASK-3', priority: 'all', assignee: 'all', severity: [] })
  assert.equal(byId.length, 1)
  assert.equal(byId[0].id, 'TASK-3')

  const byBranch = filterTasks(SAMPLE_TASKS, { search: 'feat/search', priority: 'all', assignee: 'all', severity: [] })
  assert.equal(byBranch.length, 1)
  assert.equal(byBranch[0].id, 'TASK-2')
})

test('filters tasks by priority matching normalized rank', () => {
  const high = filterTasks(SAMPLE_TASKS, { search: '', priority: 'high', assignee: 'all', severity: [] })
  // TASK-1 (high) and TASK-2 (P0) both normalize to high
  assert.equal(high.length, 2)
  assert.ok(high.some((t) => t.id === 'TASK-1'))
  assert.ok(high.some((t) => t.id === 'TASK-2'))

  const low = filterTasks(SAMPLE_TASKS, { search: '', priority: 'low', assignee: 'all', severity: [] })
  assert.equal(low.length, 1)
  assert.equal(low[0].id, 'TASK-3')
})

test('filters tasks by assignee including unassigned', () => {
  const unassigned = filterTasks(SAMPLE_TASKS, { search: '', priority: 'all', assignee: 'unassigned', severity: [] })
  assert.equal(unassigned.length, 1)
  assert.equal(unassigned[0].id, 'TASK-2')

  const builder = filterTasks(SAMPLE_TASKS, { search: '', priority: 'all', assignee: 'builder-1', severity: [] })
  assert.equal(builder.length, 1)
  assert.equal(builder[0].id, 'TASK-1')
})

test('filters tasks by multiple combined criteria', () => {
  const match = filterTasks(SAMPLE_TASKS, { search: 'search', priority: 'high', assignee: 'unassigned', severity: [] })
  assert.equal(match.length, 1)
  assert.equal(match[0].id, 'TASK-2')

  const noMatch = filterTasks(SAMPLE_TASKS, { search: 'search', priority: 'low', assignee: 'unassigned', severity: [] })
  assert.equal(noMatch.length, 0)
})

const SEVERITY_TASKS = [
  {
    id: 'GREEN-1',
    project: 'kanbann',
    title: 'Green task',
    description: '',
    status: 'IN_PROGRESS',
    priority: 'high',
    assigned_agent: 'a',
    stage_owners: { IN_PROGRESS: 'a', IN_REVIEW: 'b' },
    agent_logs: [],
    metadata: {},
    version: 1,
  },
  {
    id: 'AMBER-1',
    project: 'kanbann',
    title: 'Amber task',
    description: '',
    status: 'IN_PROGRESS',
    priority: 'medium',
    assigned_agent: 'a',
    stage_owners: { IN_PROGRESS: 'a', IN_REVIEW: 'a' },
    agent_logs: [],
    metadata: {},
    version: 1,
  },
  {
    id: 'RED-1',
    project: 'kanbann',
    title: 'Red task',
    description: '',
    status: 'DONE',
    priority: 'low',
    assigned_agent: 'a',
    stage_owners: { IN_PROGRESS: 'a', IN_REVIEW: 'a', VALIDATION: 'a', READY_TO_SHIP: 'a' },
    agent_logs: [],
    metadata: {},
    version: 1,
  },
]

test('filters tasks by severity (green/amber/red multi-select)', () => {
  const green = filterTasks(SEVERITY_TASKS, { search: '', priority: 'all', assignee: 'all', severity: ['green'] })
  assert.equal(green.length, 1)
  assert.equal(green[0].id, 'GREEN-1')

  const amber = filterTasks(SEVERITY_TASKS, { search: '', priority: 'all', assignee: 'all', severity: ['amber'] })
  assert.equal(amber.length, 1)
  assert.equal(amber[0].id, 'AMBER-1')

  const red = filterTasks(SEVERITY_TASKS, { search: '', priority: 'all', assignee: 'all', severity: ['red'] })
  assert.equal(red.length, 1)
  assert.equal(red[0].id, 'RED-1')
})

test('severity multi-select unions selections', () => {
  const union = filterTasks(SEVERITY_TASKS, {
    search: '',
    priority: 'all',
    assignee: 'all',
    severity: ['green', 'red'],
  })
  assert.equal(union.length, 2)
  assert.ok(union.some((t) => t.id === 'GREEN-1'))
  assert.ok(union.some((t) => t.id === 'RED-1'))
})

test('severity filter combines with other criteria', () => {
  const match = filterTasks(SEVERITY_TASKS, {
    search: 'Green',
    priority: 'high',
    assignee: 'all',
    severity: ['green'],
  })
  assert.equal(match.length, 1)
  assert.equal(match[0].id, 'GREEN-1')

  const noMatch = filterTasks(SEVERITY_TASKS, {
    search: 'Green',
    priority: 'all',
    assignee: 'all',
    severity: ['red'],
  })
  assert.equal(noMatch.length, 0)
})
