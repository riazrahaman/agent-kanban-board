import assert from 'node:assert/strict'
import { test } from 'node:test'

import { computeSignalStats } from './signalStats.ts'
import type { Task } from '../types.ts'

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

test('regression: the reported bug (all tiles stuck at 0) is fixed against realistic multi-task data', () => {
  // Fixed fixture rather than reading the live server/tasks.json: that file
  // is mutable local/dev state (it's whatever the board's own runtime last
  // wrote), so a test asserting exact counts against it is coupled to
  // whoever last ran the server rather than to this function's behavior.
  const now = new Date('2026-09-11T16:20:00+04:00')
  const tasks: Task[] = [
    task({
      id: 'done-today-1',
      status: 'DONE',
      agent_logs: [{ timestamp: '2026-09-11T02:57:00Z', agent_id: 'x', message: 'm' }],
    }),
    task({
      id: 'done-today-2',
      status: 'DONE',
      agent_logs: [{ timestamp: '2026-09-11T09:00:00Z', agent_id: 'y', message: 'm' }],
    }),
    task({ id: 'done-old', status: 'DONE', agent_logs: [] }),
    task({ id: 'backlog', status: 'BACKLOG' }),
  ]
  const stats = computeSignalStats(tasks, now)

  // None of these fixture tasks are BUILDING/IN_REVIEW/IN_TEST/BLOCKED.
  assert.equal(stats.active, 0)
  assert.equal(stats.blocked, 0)
  // Before the fix this was always 0 regardless of data; it must now be > 0
  // since two tasks were completed on the same day this test is pinned to.
  assert.ok(stats.doneToday > 0, `expected doneToday > 0, got ${stats.doneToday}`)
})
