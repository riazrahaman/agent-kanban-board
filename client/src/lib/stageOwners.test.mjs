// Pure formatting helper for per-stage ownership. esbuild bundles the TS source
// into ESM at test time so this runs on every Node version CI covers (mirrors
// claimCoordinator.test.mjs).
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))

const result = await build({
  entryPoints: [join(__dirname, 'stageOwners.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})
const tmpDir = await mkdtemp(join(tmpdir(), 'stageOwners-test-'))
const tmpFile = join(tmpDir, 'stageOwners.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const { formatStageOwners } = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

test('formatStageOwners returns an empty string for empty/absent maps', () => {
  assert.equal(formatStageOwners({}), '')
  assert.equal(formatStageOwners(undefined), '')
})

test('formatStageOwners emits entries in stable BUILDING/IN_REVIEW/IN_TEST/DONE order', () => {
  const out = formatStageOwners({
    DONE: 'tester',
    IN_REVIEW: 'reviewer',
    BUILDING: 'builder',
    IN_TEST: 'tester',
  })
  assert.equal(out, 'BUILDING: builder · IN_REVIEW: reviewer · IN_TEST: tester · DONE: tester')
})

test('formatStageOwners skips stages that are absent', () => {
  assert.equal(formatStageOwners({ BUILDING: 'builder' }), 'BUILDING: builder')
  assert.equal(
    formatStageOwners({ IN_REVIEW: 'reviewer', DONE: 'tester' }),
    'IN_REVIEW: reviewer · DONE: tester',
  )
})

test('formatStageOwners joins multiple entries with " · "', () => {
  const out = formatStageOwners({ BUILDING: 'a', IN_REVIEW: 'b' })
  assert.equal(out, 'BUILDING: a · IN_REVIEW: b')
})
