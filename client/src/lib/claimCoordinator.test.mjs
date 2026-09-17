// Phase 2.2: pure decision logic for the client claim coordinator. esbuild
// bundles the TS source into ESM at test time so this runs on every Node version
// CI covers (mirrors signalStats.test.mjs).
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))

const result = await build({
  entryPoints: [join(__dirname, 'claimCoordinator.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})
const tmpDir = await mkdtemp(join(tmpdir(), 'claimCoordinator-test-'))
const tmpFile = join(tmpDir, 'claimCoordinator.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const coord = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

// A held task with a lease window of `windowMs` as of `base`.
function heldTask(overrides = {}) {
  return {
    id: 't',
    project: 'p',
    title: 'held',
    status: 'BUILDING',
    assigned_agent: 'agentA',
    agent_logs: [],
    metadata: {},
    version: 2,
    claim_expires_at: new Date(Date.now() + 60000).toISOString(),
     ...overrides,
    }
}

test('isMineHeld is true only for the holder of an unexpired lease', () => {
  const now = Date.now()
  const task = heldTask({ claim_expires_at: new Date(now + 60000).toISOString() })
  assert.equal(coord.isMineHeld(task, 'agentA', now + 1000), true)
  assert.equal(coord.isMineHeld(task, 'agentB', now + 1000), false)
})

test('isMineHeld is false once the lease has lapsed', () => {
  const now = Date.now()
  const task = heldTask({ claim_expires_at: new Date(now + 5000).toISOString() })
  assert.equal(coord.isMineHeld(task, 'agentA', now + 70000), false)
})

test('isMineHeld is true when a lease window is absent but the task is assigned', () => {
  const now = Date.now()
  const task = heldTask({ claim_expires_at: null })
  assert.equal(coord.isMineHeld(task, 'agentA', now), true)
})

test('needsHeartbeat only fires in the final fraction of the window', () => {
  const now = Date.now()
  const cfg = { leaseMs: 60000, renewAtFraction: 0.5 }
      // 60s lease, 30s in → 30s remaining = exactly 50% → renew.
  const near = heldTask({ claim_expires_at: new Date(now + 60000).toISOString() })
  assert.equal(coord.needsHeartbeat(near, 'agentA', now + 30000, cfg), true)
      // 10s in → 50s remaining = ~83% → no heartbeat yet.
  const early = heldTask({ claim_expires_at: new Date(now + 60000).toISOString() })
  assert.equal(coord.needsHeartbeat(early, 'agentB', now + 10000, cfg), false)
      // A foreign agent never heartbeats someone else's lease even at the edge.
  const intruder = heldTask({ claim_expires_at: new Date(now + 30000).toISOString() })
  assert.equal(coord.needsHeartbeat(intruder, 'agentB', now + 30000, cfg), false)
})

test('selectTasksToHeartbeat picks only the agent tasks whose window is nearly gone', () => {
  const now = Date.now()
  const tasks = [
      // agentA, 60s lease, 55s in → ~8% left → beat.
       heldTask({ id: 'a', claim_expires_at: new Date(now + 60000).toISOString() }),
       // foreign holder, near expiry → never beat by us.
       heldTask({ id: 'b', assigned_agent: 'other', claim_expires_at: new Date(now + 60000).toISOString() }),
       // agentA, but a fresh long lease → 145s of ~200s remains ≈ 73% → skip.
       heldTask({ id: 'c', claim_expires_at: new Date(now + 200000).toISOString() }),
       // unheld → never beat.
       {
        id: 'd',
        project: 'p',
        status: 'BACKLOG',
        assigned_agent: null,
        agent_logs: [],
        metadata: {},
        version: 1,
          },
        ]
      // Evaluate 55s into the 60s window of 'a' so ~6% remains (< 50%).
  const picked = coord.selectTasksToHeartbeat(tasks, 'agentA', now + 55000, { leaseMs: 60000, renewAtFraction: 0.5 })
   // Only 'a': 'b' is foreign ('c' also agentA but 49s remains ≈ 83% → not yet), 'd' unheld.
  assert.deepEqual(picked.map((t) => t.id), ['a'])
})

test('shouldAutoClaim is true when the agent holds nothing active', () => {
  const now = Date.now()
       // Idle: the only held task belongs to someone else.
  assert.equal(coord.shouldAutoClaim([heldTask({ assigned_agent: 'other' })], 'agentA', now + 50000), true)
       // Busy: agentA still holds an unexpired lease.
  assert.equal(coord.shouldAutoClaim([heldTask({ claim_expires_at: new Date(now + 60000).toISOString() })], 'agentA', now + 1000), false)
       // Lapsed lease counts as idle → should claim again.
  assert.equal(coord.shouldAutoClaim([heldTask({ claim_expires_at: new Date(now + 5000).toISOString() })], 'agentA', now + 70000), true)
})

test('leaseRemainingMs returns null for unclaimed tasks and a negative number after expiry', () => {
  const now = Date.now()
  assert.equal(coord.leaseRemainingMs({ assigned_agent: null, claim_expires_at: null }, now), null)
  const task = heldTask({ claim_expires_at: new Date(now + 60000).toISOString() })
  const after = coord.leaseRemainingMs(task, now + 65000)
  assert.ok(after !== null && after < 0, `expected negative remaining, got ${after}`)
})

// --- review regressions -------------------------------------------------

test('isLostLeaseError matches the reasons the server actually sends', () => {
  // These are the exact strings api.ts throws: `heartbeat failed (409) (<reason>)`
  // with reason ∈ { not_lease_holder, not_claimed }. The original pattern used
  // spaces ("not a lease holder"), matched neither, and left the documented
  // drop-the-lease recovery path as dead code.
  assert.equal(coord.isLostLeaseError('heartbeat failed (409) (not_lease_holder)'), true)
  assert.equal(coord.isLostLeaseError('heartbeat failed (409) (not_claimed)'), true)
  // Prose forms must keep working if the server is ever reworded.
  assert.equal(coord.isLostLeaseError('not a lease holder'), true)
  assert.equal(coord.isLostLeaseError('no active lease'), true)
  // A genuine failure must NOT be swallowed as a lost lease.
  assert.equal(coord.isLostLeaseError('heartbeat failed (500) (Internal Server Error)'), false)
  assert.equal(coord.isLostLeaseError('NetworkError'), false)
})

test('observedLeaseWindowMs calibrates to the real server TTL', () => {
  const now = Date.now()
  // A 60s server TTL: a freshly renewed lease shows ~60s remaining.
  const fresh = heldTask({ claim_expires_at: new Date(now + 60000).toISOString() })
  const estimate = coord.observedLeaseWindowMs([fresh], 'agentA', now)
  assert.ok(estimate >= 59000 && estimate <= 60000, `expected ~60000, got ${estimate}`)

  // With the real window known, a lease at 50s remaining is NOT yet due; under
  // the old hard-coded 300000 assumption it was (50000 <= 0.5 * 300000), which
  // heartbeated every held task on every 5s tick.
  assert.equal(coord.needsHeartbeat(fresh, 'agentA', now + 10000, { leaseMs: estimate }), false)
  assert.equal(coord.needsHeartbeat(fresh, 'agentA', now + 10000, {}), true)

  // Past the halfway point of the true window it IS due.
  assert.equal(coord.needsHeartbeat(fresh, 'agentA', now + 35000, { leaseMs: estimate }), true)
})

test('observedLeaseWindowMs keeps the high-water mark and ignores other agents', () => {
  const now = Date.now()
  const mine = heldTask({ claim_expires_at: new Date(now + 60000).toISOString() })
  const theirs = heldTask({
    id: 'other', assigned_agent: 'agentB',
    claim_expires_at: new Date(now + 999000).toISOString(),
    })
  const estimate = coord.observedLeaseWindowMs([mine, theirs], 'agentA', now)
  assert.ok(estimate <= 60000, `another agent's lease must not skew the estimate, got ${estimate}`)

  // A lease decaying toward expiry must not drag the estimate down with it.
  const decayed = coord.observedLeaseWindowMs([mine], 'agentA', now + 55000, estimate)
  assert.equal(decayed, estimate, 'the window estimate is a high-water mark')

  // Nothing held -> keep whatever we already learned.
  assert.equal(coord.observedLeaseWindowMs([], 'agentA', now, estimate), estimate)
  assert.equal(coord.observedLeaseWindowMs([], 'agentA', now, undefined), undefined)
})
