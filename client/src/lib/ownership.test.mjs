// Solo-run severity derivation for per-stage task ownership.
// The helper is pure and operates on the task's stage_owners map only.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))

const result = await build({
  entryPoints: [join(__dirname, 'ownership.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})

const tmpDir = await mkdtemp(join(tmpdir(), 'ownership-test-'))
const tmpFile = join(tmpDir, 'ownership.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const { deriveOwnership, deriveTaskOwnership, ownershipTooltip, SEVERITY_COLORS } = await import(
  pathToFileURL(tmpFile).href
)
await rm(tmpDir, { recursive: true, force: true })

function task(stageOwners) {
  return { stage_owners: stageOwners }
}

test('green when two different agents cover active stages', () => {
  const summary = deriveOwnership({ IN_PROGRESS: 'builder', IN_REVIEW: 'reviewer' })
  assert.equal(summary.severity, 'green')
  assert.equal(summary.agents, 2)
  assert.equal(summary.stages, 2)
  assert.equal(summary.soleAgent, null)
  assert.deepEqual(summary.heldStages, [])
})

test('amber when one agent holds exactly two active stages', () => {
  const summary = deriveOwnership({ IN_PROGRESS: 'builder', IN_REVIEW: 'builder' })
  assert.equal(summary.severity, 'amber')
  assert.equal(summary.agents, 1)
  assert.equal(summary.stages, 2)
  assert.equal(summary.soleAgent, 'builder')
  assert.deepEqual(summary.heldStages, ['IN_PROGRESS', 'IN_REVIEW'])
})

test('amber when one agent holds exactly three active stages', () => {
  const summary = deriveOwnership({
    IN_PROGRESS: 'builder',
    IN_REVIEW: 'builder',
    VALIDATION: 'builder',
  })
  assert.equal(summary.severity, 'amber')
  assert.equal(summary.agents, 1)
  assert.equal(summary.stages, 3)
  assert.equal(summary.soleAgent, 'builder')
})

test('red when one agent holds four active stages', () => {
  const summary = deriveOwnership({
    IN_PROGRESS: 'builder',
    IN_REVIEW: 'builder',
    VALIDATION: 'builder',
    READY_TO_SHIP: 'builder',
  })
  assert.equal(summary.severity, 'red')
  assert.equal(summary.agents, 1)
  assert.equal(summary.stages, 4)
  assert.equal(summary.soleAgent, 'builder')
  assert.deepEqual(summary.heldStages, [
    'IN_PROGRESS',
    'IN_REVIEW',
    'VALIDATION',
    'READY_TO_SHIP',
  ])
})

test('red when one agent holds five active stages including DONE', () => {
  const summary = deriveOwnership({
    IN_PROGRESS: 'builder',
    IN_REVIEW: 'builder',
    VALIDATION: 'builder',
    READY_TO_SHIP: 'builder',
    DONE: 'builder',
  })
  assert.equal(summary.severity, 'red')
  assert.equal(summary.agents, 1)
  assert.equal(summary.stages, 5)
  assert.equal(summary.soleAgent, 'builder')
  assert.deepEqual(summary.heldStages, [
    'IN_PROGRESS',
    'IN_REVIEW',
    'VALIDATION',
    'READY_TO_SHIP',
    'DONE',
  ])
})

test('none when there are zero or one active stages with owners', () => {
  assert.equal(deriveOwnership({}).severity, 'none')
  assert.equal(deriveOwnership({ IN_PROGRESS: 'builder' }).severity, 'none')
  assert.equal(deriveOwnership({ BACKLOG: 'builder' }).severity, 'none')
})

test('null owner values are skipped', () => {
  const summary = deriveOwnership({
    IN_PROGRESS: 'builder',
    IN_REVIEW: null,
    VALIDATION: undefined,
    READY_TO_SHIP: 'reviewer',
  })
  assert.equal(summary.severity, 'green')
  assert.equal(summary.agents, 2)
  assert.equal(summary.stages, 2)
})

test('unknown stages are ignored', () => {
  // Keys that are neither canonical lifecycle stages nor legacy aliases must
  // not contribute to ownership severity.
  const summary = deriveOwnership({
    IN_PROGRESS: 'builder',
    SHIPPING: 'builder',
    DEPLOYING: 'builder',
  })
  assert.equal(summary.severity, 'none')
  assert.equal(summary.agents, 1)
  assert.equal(summary.stages, 1)
})

test('DONE-inclusive walk reports held stages in lifecycle order', () => {
  const summary = deriveOwnership({
    DONE: 'builder',
    IN_REVIEW: 'builder',
    IN_PROGRESS: 'builder',
  })
  assert.equal(summary.severity, 'amber')
  assert.deepEqual(summary.heldStages, ['IN_PROGRESS', 'IN_REVIEW', 'DONE'])
})

test('deriveTaskOwnership delegates to deriveOwnership from a task object', () => {
  const summary = deriveTaskOwnership(task({ IN_PROGRESS: 'a', IN_REVIEW: 'b' }))
  assert.equal(summary.severity, 'green')
})

test('ownershipTooltip produces the expected labels', () => {
  const green = deriveOwnership({ IN_PROGRESS: 'a', IN_REVIEW: 'b' })
  assert.match(ownershipTooltip(green), /GREEN/)
  assert.match(ownershipTooltip(green), /2 different agents/)

  const amber = deriveOwnership({ IN_PROGRESS: 'a', IN_REVIEW: 'a' })
  assert.match(ownershipTooltip(amber), /AMBER/)
  assert.match(ownershipTooltip(amber), /Independent-review pair-break missing/)

  const red = deriveOwnership({
    IN_PROGRESS: 'a',
    IN_REVIEW: 'a',
    VALIDATION: 'a',
    READY_TO_SHIP: 'a',
  })
  assert.match(ownershipTooltip(red), /RED/)
  assert.match(ownershipTooltip(red), /Self-approval pattern/)

  assert.equal(ownershipTooltip(deriveOwnership({})), '')
})

test('SEVERITY_COLORS exposes the approved hex tokens', () => {
  assert.equal(SEVERITY_COLORS.green, '#3fa46a')
  assert.equal(SEVERITY_COLORS.amber, '#e8a13a')
  assert.equal(SEVERITY_COLORS.red, '#d4554f')
})

test('agent ids are case/whitespace-normalized for severity counting (F2)', () => {
  // Same agent, sloppy casing across stages — must NOT look like separation.
  const summary = deriveTaskOwnership(task({ IN_PROGRESS: 'Agent-A', IN_REVIEW: '  agent-a ' }))
  assert.equal(summary.severity, 'amber')
  assert.equal(summary.agents, 1)
  // soleAgent keeps the first-seen display casing.
  assert.equal(summary.soleAgent, 'Agent-A')
  // Genuinely distinct agents still separate (control).
  const split = deriveTaskOwnership(task({ IN_PROGRESS: 'Agent-A', IN_REVIEW: 'AGENT-B' }))
  assert.equal(split.severity, 'green')
  assert.equal(split.agents, 2)
})

test('legacy stage keys BUILDING/IN_TEST are tolerated (F3)', () => {
  // stageOwners.ts tolerates legacy keys; ownership must not under-report them.
  const green = deriveTaskOwnership(task({ BUILDING: 'a', IN_TEST: 'b' }))
  assert.equal(green.severity, 'green')
  // Thresholds are locked: solo 2–3 stages = amber, solo ≥4 = red.
  const amber = deriveTaskOwnership(task({ BUILDING: 'a', IN_TEST: 'a', READY_TO_SHIP: 'a' }))
  assert.equal(amber.severity, 'amber')
  assert.equal(amber.soleAgent, 'a')
  const red = deriveTaskOwnership(
    task({ BUILDING: 'a', IN_TEST: 'a', READY_TO_SHIP: 'a', DONE: 'a' }),
  )
  assert.equal(red.severity, 'red')
})
