// COR-03: the claim coordinator must count its own fresh claim as held until the
// live task stream reflects it, so a stalled stream cannot cause a new claim on
// every tick. Pure decision logic, bundled from TS at test time.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const result = await build({
  entryPoints: [join(__dirname, 'claimCoordinator.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node20',
})
const tmpDir = await mkdtemp(join(tmpdir(), 'claimPending-test-'))
const tmpFile = join(tmpDir, 'claimCoordinator.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const c = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

const NOW = Date.parse('2026-01-01T00:00:00Z')
const ME = 'ui-agent'

function task(o = {}) {
  return {
    id: 't1', project: 'p', title: 't', status: 'READY', version: 1,
    assigned_agent: null, claim_expires_at: null, ...o,
  }
}
function claimed(o = {}) {
  return task({
    status: 'IN_PROGRESS', version: 2, assigned_agent: ME,
    claim_expires_at: new Date(NOW + 600000).toISOString(), ...o,
  })
}

test('pendingClaimFromTask records project, id, version and lease expiry', () => {
  const p = c.pendingClaimFromTask(claimed(), ME, NOW)
  assert.deepEqual(
    { project: p.project, id: p.id, version: p.version, expiresAtMs: p.expiresAtMs },
    { project: 'p', id: 't1', version: 2, expiresAtMs: NOW + 600000 },
  )
  assert.equal(c.pendingClaimFromTask(claimed({ assigned_agent: 'other' }), ME, NOW), null)
  assert.equal(c.pendingClaimFromTask(null, ME, NOW), null)
})

test('a stalled stream (task absent or stale) keeps the claim held: no second auto-claim', () => {
  const pending = c.pendingClaimFromTask(claimed(), ME, NOW)
  // Stream never delivered anything.
  assert.equal(c.shouldAutoClaimNow([], ME, NOW + 5000, { pending }), false)
  // Stream still shows the pre-claim READY revision of the card.
  assert.equal(c.shouldAutoClaimNow([task()], ME, NOW + 5000, { pending }), false)
  assert.ok(c.reconcilePendingClaim(pending, [task()], NOW + 5000))
  // Without the pending claim the old logic would claim again.
  assert.equal(c.shouldAutoClaimNow([task()], ME, NOW + 5000), true)
})

test('the stream catching up hands over to the normal held logic', () => {
  const pending = c.pendingClaimFromTask(claimed(), ME, NOW)
  assert.equal(c.reconcilePendingClaim(pending, [claimed()], NOW + 1000), null)
  assert.equal(c.shouldAutoClaimNow([claimed()], ME, NOW + 1000, { pending }), false)
})

test('a claim the stream shows as lost (newer revision, not ours) is released', () => {
  const pending = c.pendingClaimFromTask(claimed(), ME, NOW)
  const stolen = claimed({ version: 3, assigned_agent: 'someone-else' })
  assert.equal(c.reconcilePendingClaim(pending, [stolen], NOW + 1000), null)
  assert.equal(c.shouldAutoClaimNow([stolen], ME, NOW + 1000, { pending }), true)
})

test('a lapsed pending lease is released', () => {
  const pending = c.pendingClaimFromTask(claimed(), ME, NOW)
  assert.equal(c.reconcilePendingClaim(pending, [], NOW + 600000), null)
  assert.equal(c.shouldAutoClaimNow([], ME, NOW + 600001, { pending }), true)
})

test('pending match is by project AND id', () => {
  const pending = c.pendingClaimFromTask(claimed(), ME, NOW)
  const sameIdOtherProject = claimed({ project: 'q', version: 9 })
  assert.ok(c.reconcilePendingClaim(pending, [sameIdOtherProject], NOW + 1000))
})

test('effectiveTasks substitutes the server copy so the pending lease is heartbeated', () => {
  const pending = c.pendingClaimFromTask(claimed(), ME, NOW)
  const known = c.effectiveTasks([task(), task({ id: 't2' })], pending)
  assert.equal(known.length, 2)
  assert.equal(known.find((t) => t.id === 't1').assigned_agent, ME)
  // Near the end of the lease the pending task is a heartbeat target.
  const targets = c.heartbeatTargets(known, ME, NOW + 400000, { leaseMs: 600000 })
  assert.deepEqual(targets, [{ id: 't1', project: 'p' }])
  assert.equal(c.effectiveTasks([task()], null).length, 1)
})

test('a stream known to be down pauses auto-claim; unknown does not', () => {
  assert.equal(c.shouldAutoClaimNow([], ME, NOW, { streamUp: false }), false)
  assert.equal(c.shouldAutoClaimNow([], ME, NOW, { streamUp: true }), true)
  assert.equal(c.shouldAutoClaimNow([], ME, NOW, {}), true)
})

test('the hook records its claim and gates auto-claim on it', async () => {
  const src = await readFile(join(__dirname, 'useClaimCoordinator.ts'), 'utf8')
  assert.match(src, /pendingRef\.current = pendingClaimFromTask\(claimed, who/)
  assert.match(src, /shouldAutoClaimNow\(tasksRef\.current, who, Date\.now\(\), \{\s*pending: pendingRef\.current/)
  assert.match(src, /heartbeatTargets\(known, who/)
  assert.doesNotMatch(src, /\bshouldAutoClaim\(/, 'the stream-only decision is no longer used by the hook')
})
