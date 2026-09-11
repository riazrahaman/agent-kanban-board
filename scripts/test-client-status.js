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
  assert.equal(statusStyle('BUILDING').stripe, statusStyle('IN_TEST').stripe)
  assert.equal(statusStyle('IN_REVIEW').badge, 'bg-warn-bg text-warn')

  const grouped = groupTasks([
    { id: 'garbage-status', status: 'not-a-loop-state', issues: [] },
  ])
  assert.deepEqual(grouped.UNKNOWN.map((task) => task.id), ['garbage-status'])
})
