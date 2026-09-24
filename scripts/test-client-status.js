import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeStatus, statusStyle } from '../client/src/status.js'
import { groupTasks } from '../client/src/board-model.js'

test('client status helper renders malformed statuses safely and consistently', () => {
  assert.equal(normalizeStatus(null), 'UNKNOWN')
  assert.equal(normalizeStatus(undefined), 'UNKNOWN')
  assert.equal(normalizeStatus('not-a-loop-state'), 'UNKNOWN')
  assert.deepEqual(statusStyle(null), {
    normalized: 'UNKNOWN',
    stripe: 'border-l-line',
    badge: 'bg-muted-bg text-muted',
  })
  // v2.4.0: BUILDING (blue/live) and IN_TEST (violet/test) are deliberately DISTINCT
  // so the verification stage is identifiable at a glance.
  assert.notEqual(statusStyle('BUILDING').stripe, statusStyle('IN_TEST').stripe)
  assert.equal(statusStyle('BUILDING').stripe, 'border-l-live')
  assert.equal(statusStyle('IN_TEST').stripe, 'border-l-test')
  assert.equal(statusStyle('IN_REVIEW').badge, 'bg-warn-bg text-warn')

  const grouped = groupTasks([
    { id: 'garbage-status', status: 'not-a-loop-state', issues: [] },
  ])
  assert.deepEqual(grouped.UNKNOWN.map((task) => task.id), ['garbage-status'])
})
