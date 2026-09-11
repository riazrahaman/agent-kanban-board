import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { computeSignalStats } from './signalStats.ts'
import type { Task } from '../types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

function task(overrides: Partial<Task>): Task {
  return {
    id: 'x',
    title: 't',
    description: '',
    status: 'BACKLOG',
    priority: 'medium',
    assigned_agent: null,
    agent_logs: [],
    metadata: {},
    ...overrides,
  }
}

test('BUILDING/IN_REVIEW/IN_TEST count as active regardless of assigned_agent', () => {
  const now = new Date('2026-09-11T12:00:00Z')
  const tasks: Task[] = [
    task({ id: 'a', status: 'BUILDING', assigned_agent: 'codex-builder' }),
    task({ id: 'b', status: 'BUILDING', assigned_agent: null }),
    task({ id: 'c', status: 'IN_REVIEW' }),
    task({ id: 'd', status: 'IN_TEST' }),
    task({ id: 'e', status: 'BACKLOG' }),
    task({ id: 'f', status: 'DONE' }),
  ]
  assert.equal(computeSignalStats(tasks, now).active, 4)
})

test('BLOCKED is counted exactly, case-sensitively', () => {
  const now = new Date('2026-09-11T12:00:00Z')
  const tasks: Task[] = [
    task({ id: 'a', status: 'BLOCKED' }),
    task({ id: 'b', status: 'BLOCKED' }),
    task({ id: 'c', status: 'BUILDING' }),
    // legacy lowercase alias must NOT be double-counted by this pure function
    task({ id: 'd', status: 'blocked' }),
  ]
  assert.equal(computeSignalStats(tasks, now).blocked, 2)
})

test('doneToday requires DONE status AND a log entry timestamped today', () => {
  const now = new Date('2026-09-11T12:00:00Z')
  const tasks: Task[] = [
    task({
      id: 'today',
      status: 'DONE',
      agent_logs: [{ timestamp: '2026-09-11T02:57:00Z', agent_id: 'x', message: 'm' }],
    }),
    task({
      id: 'old',
      status: 'DONE',
      agent_logs: [{ timestamp: '2026-09-01T02:57:00Z', agent_id: 'x', message: 'm' }],
    }),
    task({
      id: 'no-logs-done',
      status: 'DONE',
      agent_logs: [],
    }),
    task({
      id: 'today-but-not-done',
      status: 'BUILDING',
      agent_logs: [{ timestamp: '2026-09-11T02:57:00Z', agent_id: 'x', message: 'm' }],
    }),
  ]
  assert.equal(computeSignalStats(tasks, now).doneToday, 1)
})

test('regression: the reported bug (all tiles stuck at 0) is fixed against live server/tasks.json', () => {
  const raw = readFileSync(join(__dirname, '../../../server/tasks.json'), 'utf-8')
  const data = JSON.parse(raw) as { tasks: Task[] }
  // "Now" pinned to when this bug was reported, well after every v3-0N log.
  const now = new Date('2026-09-11T16:20:00+04:00')
  const stats = computeSignalStats(data.tasks, now)

  // All 9 tasks are DONE; none are BUILDING/IN_REVIEW/IN_TEST/BLOCKED right now.
  assert.equal(stats.active, 0)
  assert.equal(stats.blocked, 0)
  // Before the fix this was always 0 regardless of data; it must now be > 0
  // since several tasks were completed on the same day this test is pinned to.
  assert.ok(stats.doneToday > 0, `expected doneToday > 0, got ${stats.doneToday}`)
})
