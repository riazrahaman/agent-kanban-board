import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeStatus, statusStyle } from '../client/src/status.js'

test('client status helper renders malformed statuses safely and consistently', () => {
  assert.equal(normalizeStatus(null), 'UNKNOWN')
  assert.equal(normalizeStatus(undefined), 'UNKNOWN')
  assert.equal(normalizeStatus('not-a-loop-state'), 'NOT-A-LOOP-STATE')
  assert.deepEqual(statusStyle(null), {
    normalized: 'UNKNOWN',
    stripe: 'border-l-line',
    badge: 'bg-muted-bg text-muted',
  })
  assert.equal(statusStyle('BUILDING').stripe, statusStyle('IN_TEST').stripe)
  assert.equal(statusStyle('IN_REVIEW').badge, 'bg-warn-bg text-warn')
})
