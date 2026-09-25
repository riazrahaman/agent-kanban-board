// v2.11.0 regression guard (opt-* features): milestone grouping, operator
// assignment and integration hooks must stay wired on both sides.
//
// These are SOURCE-CONTRACT assertions, not behavioural ones — the server side
// is covered by server/test/kanban.optfeatures211.test.js. Here we only prove
// the client never silently drops a feature: the types exist, the API helpers
// are exported, and each component still renders/calls its piece.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = join(__dirname, '..')

const read = (rel) => readFileSync(join(CLIENT_SRC, rel), 'utf8')

const typesSource = read('types.ts')
const apiSource = read('api.ts')
const taskCardSource = read(join('components', 'TaskCard.tsx'))
const taskSheetSource = read(join('components', 'TaskSheet.tsx'))
const portfolioSource = read(join('components', 'Portfolio.tsx'))

test('the Task type carries an optional milestone and a MilestoneSummary exists', () => {
  assert.match(
    typesSource,
    /milestone\?:\s*string\s*\|\s*null/,
    'Task must declare `milestone?: string | null` (opt-milestones)',
  )
  assert.match(
    typesSource,
    /export type MilestoneSummary\b/,
    'a MilestoneSummary type must be exported for GET /api/milestones',
  )
})

test('api.ts exports the assignTask and getMilestones helpers', () => {
  assert.match(
    apiSource,
    /export async function assignTask\b/,
    'assignTask must be exported (opt-operator-assignment)',
  )
  assert.match(
    apiSource,
    /export async function getMilestones\b/,
    'getMilestones must be exported (opt-milestones)',
  )
  assert.match(
    apiSource,
    /\/tasks\/\$\{id\}\/assign/,
    'assignTask must POST to /tasks/:id/assign',
  )
})

test('TaskCard renders the milestone chip', () => {
  assert.match(
    taskCardSource,
    /task\.milestone/,
    'TaskCard must read task.milestone so the chip can render',
  )
})

test('TaskSheet calls assignTask from its assignment control', () => {
  assert.match(
    taskSheetSource,
    /assignTask\(/,
    'TaskSheet must call assignTask for the operator assign/release control',
  )
})

test('Portfolio loads and renders milestone rollups', () => {
  assert.match(
    portfolioSource,
    /getMilestones\(/,
    'Portfolio must call getMilestones',
  )
  assert.match(
    portfolioSource,
    /milestones\.map\(/,
    'Portfolio must render the milestone rollup list',
  )
})

test('no banned visual patterns slip into the client source', () => {
  // Fragmented so this guard file itself never matches its own scan.
  const banned = [
    new RegExp('shad' + 'ow-'),
    new RegExp('rounded' + '-full'),
    new RegExp('\\b' + 'In' + 'ter\\b'),
    new RegExp('\\b' + 'Rob' + 'oto\\b'),
    new RegExp('\\u{1F464}', 'u'),
  ]
  for (const rel of [
    'types.ts',
    'api.ts',
    join('components', 'TaskCard.tsx'),
    join('components', 'TaskSheet.tsx'),
    join('components', 'Portfolio.tsx'),
  ]) {
    const src = read(rel)
    for (const re of banned) {
      assert.doesNotMatch(src, re, `${rel} must not match ${re}`)
    }
  }
})
