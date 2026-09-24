import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))

const result = await build({
  entryPoints: [join(__dirname, 'dashboardMetrics.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})
const tmpDir = await mkdtemp(join(tmpdir(), 'dashboard-metrics-test-'))
const tmpFile = join(tmpDir, 'dashboardMetrics.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const { computeDashboardMetrics, STALE_THRESHOLD_MS } = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

function makeTask(overrides) {
  return {
    id: 'task-1',
    project: 'default',
    title: 'Test task',
    description: '',
    status: 'BACKLOG',
    priority: 'medium',
    assigned_agent: null,
    agent_logs: [],
    metadata: {},
    created_at: new Date().toISOString(),
    updated: new Date().toISOString(),
    version: 1,
    ...overrides,
  }
}

test('computes total, backlog, wip, blocked, and done counts correctly', () => {
  const tasks = [
    makeTask({ id: '1', status: 'BACKLOG' }),
    makeTask({ id: '2', status: 'BUILDING', assigned_agent: 'agent-1' }),
    makeTask({ id: '3', status: 'IN_REVIEW', assigned_agent: 'agent-2' }),
    makeTask({ id: '4', status: 'BLOCKED' }),
    makeTask({ id: '5', status: 'DONE' }),
  ]

  const metrics = computeDashboardMetrics(tasks)
  assert.equal(metrics.total, 5)
  assert.equal(metrics.backlog, 1)
  assert.equal(metrics.wip, 2)
  assert.equal(metrics.blocked, 1)
  assert.equal(metrics.done, 1)
  assert.equal(metrics.activeAgentsCount, 2)
})

test('computes average cycle time accurately from done tasks', () => {
  const now = Date.now()
  const oneHourAgo = new Date(now - 3600000).toISOString()
  const twoHoursAgo = new Date(now - 7200000).toISOString()
  const threeHoursAgo = new Date(now - 10800000).toISOString()

  const tasks = [
    makeTask({
      id: '1',
      status: 'DONE',
      created_at: twoHoursAgo,
      completed_at: oneHourAgo, // 1 hour duration
    }),
    makeTask({
      id: '2',
      status: 'DONE',
      created_at: threeHoursAgo,
      completed_at: oneHourAgo, // 2 hour duration
    }),
  ]

  const metrics = computeDashboardMetrics(tasks, now)
  // Average of 1h (3600000) and 2h (7200000) is 1.5h (5400000)
  assert.equal(metrics.avgCycleTimeMs, 5400000)
  assert.equal(metrics.avgCycleTimeFormatted, '1.5h')
})

test('flags overdue/stalled active tasks exceeding stale threshold', () => {
  const now = Date.now()
  const freshTime = new Date(now - 1000).toISOString()
  const staleTime = new Date(now - (STALE_THRESHOLD_MS + 60000)).toISOString()

  const tasks = [
    makeTask({ id: '1', status: 'BUILDING', updated: freshTime }),
    makeTask({ id: '2', status: 'IN_REVIEW', updated: staleTime }), // stale
    makeTask({ id: '3', status: 'BACKLOG', updated: staleTime }), // backlog is not active, shouldn't count as overdue
  ]

  const metrics = computeDashboardMetrics(tasks, now)
  assert.equal(metrics.overdueCount, 1)
})
