import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Source-contract guard (v3.17.0): the header carries the favicon logo with a
// pulsing live card, replacing the old pulsing blue square.
const here = dirname(fileURLToPath(import.meta.url))
const mark = readFileSync(join(here, 'BrandMark.tsx'), 'utf8')
const app = readFileSync(join(here, '..', 'App.tsx'), 'utf8')
const favicon = readFileSync(join(here, '..', '..', 'public', 'favicon.svg'), 'utf8')

test('header renders BrandMark and no longer the bare pulsing square', () => {
  assert.match(app, /<BrandMark\s*\/>/)
  assert.doesNotMatch(app, /h-2 w-2 bg-live animate-pulse/)
})

test('the live-connection label and pulse survive on the mark', () => {
  assert.match(mark, /aria-label="Live connection"/)
  assert.match(mark, /animate-pulse motion-reduce:animate-none/)
  // only the live card pulses
  assert.equal((mark.match(/className="animate-pulse/g) || []).length, 1)
})

test('mark uses theme tokens and no banned classes', () => {
  assert.match(mark, /var\(--live\)/)
  assert.doesNotMatch(mark, /rounded-full|shadow-/)
})

test('geometry matches the favicon (live card coordinates)', () => {
  assert.match(favicon, /card-live" x="13.7" y="7" width="4.6" height="9"/)
  assert.match(mark, /x="13.7"\s+y="7"\s+width="4.6"\s+height="9"/)
})
