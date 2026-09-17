// §2.10 portfolio presentation logic. esbuild bundles the TS source into ESM at
// test time so this runs on every Node version CI covers (mirrors
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
  entryPoints: [join(__dirname, 'portfolioMetrics.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})
const tmpDir = await mkdtemp(join(tmpdir(), 'portfolioMetrics-test-'))
const tmpFile = join(tmpDir, 'portfolioMetrics.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const pm = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

const metrics = (by_status) => ({ by_status })

test('wipOf counts only work in flight, not backlog or done', () => {
  const m = metrics({
    BACKLOG: 5, BUILDING: 2, IN_REVIEW: 3, IN_TEST: 1, BLOCKED: 4, DONE: 9,
  })
  assert.equal(pm.wipOf(m), 6, 'building + in review + in test')
  assert.equal(pm.backlogOf(m), 5)
  assert.equal(pm.blockedOf(m), 4)
})

test('a missing status bucket reads as zero, not NaN', () => {
  // The server only emits buckets it knows about, so an older or newer server
  // can legitimately omit one. NaN would render as "NaN" in the table.
  const m = metrics({})
  assert.equal(pm.wipOf(m), 0)
  assert.equal(pm.backlogOf(m), 0)
  assert.equal(pm.blockedOf(m), 0)
})

test('formatDuration renders a dash when there is no completed work', () => {
  // Not "0m": zero would wrongly suggest instant delivery rather than no data.
  assert.equal(pm.formatDuration(null), '—')
  assert.equal(pm.formatDuration(undefined), '—')
  assert.equal(pm.formatDuration(Number.NaN), '—')
  assert.equal(pm.formatDuration(-1), '—')
})

test('formatDuration scales minutes -> hours -> days', () => {
  assert.equal(pm.formatDuration(90000), '2m', 'sub-hour rounds to minutes')
  assert.equal(pm.formatDuration(1000), '1m', 'a sub-minute span still reads as 1m, never 0m')
  assert.equal(pm.formatDuration(3600000), '1.0h')
  assert.equal(pm.formatDuration(3600000 * 12), '12.0h')
  assert.equal(pm.formatDuration(3600000 * 48), '2.0d', 'at 48h it switches to days')
  assert.equal(pm.formatDuration(3600000 * 24 * 9), '9.0d')
})
