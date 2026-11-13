// COR-03 hook wiring: useClaimCoordinator must record its own claim, so with
// the live stream delivering nothing it claims once, not on every tick. Runs
// the REAL hook source with `react` and `../api` replaced by small fakes (no
// DOM): a minimal hook runner provides useState/useRef/useEffect.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))

const fakes = {
  name: 'fakes',
  setup(b) {
    b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fake' }))
    b.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'fake' }))
    b.onLoad({ filter: /.*/, namespace: 'fake' }, (args) => ({
      loader: 'js',
      contents: args.path === 'react'
        ? `export const useState = (...a) => globalThis.__hooks.useState(...a)
           export const useRef = (...a) => globalThis.__hooks.useRef(...a)
           export const useEffect = (...a) => globalThis.__hooks.useEffect(...a)`
        : `export const nextClaim = (...a) => globalThis.__api.nextClaim(...a)
           export const heartbeatTask = (...a) => globalThis.__api.heartbeatTask(...a)`,
    }))
  },
}

const result = await build({
  entryPoints: [join(__dirname, 'useClaimCoordinator.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node20',
  plugins: [fakes],
})
const tmpDir = await mkdtemp(join(tmpdir(), 'claimCoordinatorHook-test-'))
const tmpFile = join(tmpDir, 'hook.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const { useClaimCoordinator } = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

/** Minimal single-component hook runner. */
function mount(props) {
  const slots = []
  const cleanups = []
  let i = 0
  globalThis.__hooks = {
    useState(init) {
      const k = i++
      if (!(k in slots)) slots[k] = { v: init }
      const s = slots[k]
      return [s.v, (u) => { s.v = typeof u === 'function' ? u(s.v) : u }]
    },
    useRef(init) {
      const k = i++
      if (!(k in slots)) slots[k] = { current: init }
      return slots[k]
    },
    useEffect(fn) {
      const k = i++
      if (!(k in slots)) { slots[k] = true; const c = fn(); if (c) cleanups.push(c) }
    },
  }
  const render = (p) => { i = 0; return useClaimCoordinator(p) }
  render(props)
  return { render, unmount: () => cleanups.forEach((c) => c()) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const AGENT = 'ui-agent'
function claimedTask(id) {
  return {
    id, project: 'default', title: id, status: 'IN_PROGRESS', version: 2,
    assigned_agent: AGENT, claim_expires_at: new Date(Date.now() + 600000).toISOString(),
  }
}

test('with the stream delivering nothing, the hook claims once and then holds', async () => {
  let claims = 0
  globalThis.__api = {
    nextClaim: async () => claimedTask(`t${(claims += 1)}`),
    heartbeatTask: async (id) => claimedTask(id),
  }
  const h = mount({ agentId: AGENT, tasks: [], intervalMs: 5 })
  await sleep(80) // many ticks
  h.unmount()
  assert.equal(claims, 1, 'one claim, not one per tick')
})

test('a lost lease releases the pending claim so the next tick claims again', async () => {
  let claims = 0
  globalThis.__api = {
    nextClaim: async () => {
      claims += 1
      // Lease nearly over so the coordinator heartbeats it on the next tick.
      return { ...claimedTask(`t${claims}`), claim_lease_ms: 600000, claim_expires_at: new Date(Date.now() + 1000).toISOString() }
    },
    heartbeatTask: async () => { throw new Error('heartbeat failed (409) (not_lease_holder)') },
  }
  const h = mount({ agentId: AGENT, tasks: [], intervalMs: 5 })
  await sleep(60)
  h.unmount()
  assert.ok(claims >= 2, `expected a re-claim after the lost lease, got ${claims}`)
})

test('streamUp=false pauses auto-claim', async () => {
  let claims = 0
  globalThis.__api = {
    nextClaim: async () => claimedTask(`t${(claims += 1)}`),
    heartbeatTask: async (id) => claimedTask(id),
  }
  const h = mount({ agentId: AGENT, tasks: [], intervalMs: 5, streamUp: false })
  await sleep(40)
  h.unmount()
  assert.equal(claims, 0)
})
