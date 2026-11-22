// Task sheet double-click guard. A double-click on a card opens the sheet with
// its first click; without the guard the second click lands on the backdrop and
// closes the sheet again at once (or presses a sheet button). Source-level:
// bundling TaskSheet would pull in React and the whole component tree.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sheet = readFileSync(join(__dirname, 'TaskSheet.tsx'), 'utf8')

test('BACKDROP_GUARD_MS is exported and long enough to cover a double-click', () => {
  const m = sheet.match(/export const BACKDROP_GUARD_MS = (\d+)/)
  assert.ok(m, 'BACKDROP_GUARD_MS must stay exported')
  const ms = Number(m[1])
  assert.ok(ms >= 250 && ms <= 1000, `guard ${ms}ms should cover a double-click without feeling stuck`)
})

test('the backdrop ignores the tail of a multi-click and the moment after opening', () => {
  const start = sheet.indexOf('const handleBackdropClick')
  assert.ok(start >= 0, 'handleBackdropClick must exist')
  const body = sheet.slice(start, sheet.indexOf('\n  }\n', start))
  assert.match(body, /if \(e\.detail > 1\) return/)
  assert.match(body, /if \(Date\.now\(\) - openedAt\.current < BACKDROP_GUARD_MS\) return/)
  assert.match(body, /onClose\(\)/)
  assert.match(sheet, /onClick=\{handleBackdropClick\}/, 'the backdrop must route clicks through the guard')
})

test('the sheet takes no pointer input while the guard is active', () => {
  assert.match(sheet, /openedAt\.current = Date\.now\(\)/)
  assert.match(sheet, /setTimeout\(\(\) => setGuarding\(false\), BACKDROP_GUARD_MS\)/)
  assert.match(sheet, /guarding \? \(\{ pointerEvents: 'none' \} as const\)/)
  assert.match(sheet, /style=\{guardStyle\}/)
})
