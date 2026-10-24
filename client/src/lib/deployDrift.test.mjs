// §2.10 (v3.9.5) — deploy-drift chip. esbuild bundles the TS source into ESM at
// test time so this runs on every Node version CI covers (mirrors
// stageOwners.test.mjs).
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))

const result = await build({
  entryPoints: [join(__dirname, 'deployDrift.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})
const tmpDir = await mkdtemp(join(tmpdir(), 'deployDrift-test-'))
const tmpFile = join(tmpDir, 'deployDrift.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const { driftChip } = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

const HEALTHY = {
  status: 'in_sync',
  running: '3.9.5',
  latest_tag: '3.9.5',
  checked_at: '2026-10-24T10:00:00.000Z',
  drift_since: null,
}

test('driftChip is null when healthy, and when no check has ever run', () => {
  assert.equal(driftChip(HEALTHY), null)
  assert.equal(driftChip(null), null)
  assert.equal(driftChip(undefined), null)
  // Never checked = the monitor is disabled or this build predates it: a muted
  // "unavailable" forever would be noise, not information.
  assert.equal(driftChip({ ...HEALTHY, status: 'unknown', checked_at: null }), null)
})

test('driftChip labels drift and unknown, and stays quiet otherwise', () => {
  const drift = driftChip({
    ...HEALTHY,
    status: 'drift',
    running: '3.9.4',
    latest_tag: '3.9.5',
    drift_since: '2026-10-24T09:10:00.000Z',
  })
  assert.ok(drift)
  assert.equal(drift.label, 'deploy drift · 3.9.4 ≠ 3.9.5')
  assert.equal(drift.tone, 'warn')
  assert.match(drift.title, /v3\.9\.4/)
  assert.match(drift.title, /v3\.9\.5/)
  assert.match(drift.title, /2026-10-24T09:10:00\.000Z/, 'the tooltip dates the drift')
  assert.match(drift.title, /SKIPPED/, 'drift means the deploy was skipped, not failed')

  const unknown = driftChip({ ...HEALTHY, status: 'unknown' })
  assert.ok(unknown)
  assert.equal(unknown.label, 'deploy check unavailable')
  assert.equal(unknown.tone, 'muted')
  assert.match(unknown.title, /not a board outage/)

  // Any unrecognised status stays hidden rather than inventing a warning.
  assert.equal(driftChip({ ...HEALTHY, status: 'weird' }), null)
})
