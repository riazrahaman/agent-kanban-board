// A7 (v3.12.8) round-2 B1 — the browser must send its agent identity on the
// channel the server trusts.
//
// The server change made a body `agent_id` non-identity for a non-privileged
// credential: `X-Agent-Id` is the only accepted declaration. This suite drives
// the REAL api.ts request builders against a stubbed fetch and asserts the
// header is on every identity-bearing mutation (claim / heartbeat / logs /
// comments / next-claim), while the body field is still sent for a pre-v3.12.8
// server.
//
// Assignment is the one deliberate exception: its `agentId` argument is the
// assignment TARGET, not the caller, so sending it as X-Agent-Id would
// misattribute the operator.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))

const result = await build({
  entryPoints: [join(__dirname, '..', 'api.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})
const tmpDir = await mkdtemp(join(tmpdir(), 'apiAgentHeaders-test-'))
const tmpFile = join(tmpDir, 'api.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const api = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

const TOKEN = 'tok-browser-secret'
const AGENT = 'human-ui-agent'

globalThis.localStorage = {
  getItem: (key) => (key === 'kanban.token' ? TOKEN : null),
  setItem: () => {},
  removeItem: () => {},
}

/** Every fetch the builders make, in order, with the headers actually sent. */
const calls = []

globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init })
  return new Response(JSON.stringify({ id: 't', project: 'p' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function capture(fn) {
  calls.length = 0
  await fn()
  assert.equal(calls.length, 1, 'one request per builder call')
  return calls[0]
}

test('claim sends X-Agent-Id, the Authorization bearer, and the body field', async () => {
  const call = await capture(() => api.claimTask('t1', AGENT, { project: 'p' }))
  assert.equal(call.init.headers['X-Agent-Id'], AGENT)
  assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`)
  assert.equal(call.init.headers['X-Agent-Role'], 'builder')
  assert.equal(JSON.parse(call.init.body).agent_id, AGENT, 'body kept for pre-v3.12.8 servers')
})

test('heartbeat sends X-Agent-Id', async () => {
  const call = await capture(() => api.heartbeatTask('t1', AGENT, { project: 'p' }))
  assert.equal(call.init.headers['X-Agent-Id'], AGENT)
  assert.equal(JSON.parse(call.init.body).agent_id, AGENT)
})

test('logs send X-Agent-Id', async () => {
  const call = await capture(() => api.appendLog('t1', AGENT, 'progress', { project: 'p' }))
  assert.equal(call.init.headers['X-Agent-Id'], AGENT)
  assert.equal(JSON.parse(call.init.body).agent_id, AGENT)
  assert.equal(JSON.parse(call.init.body).message, 'progress')
})

test('comments send X-Agent-Id', async () => {
  const call = await capture(() => api.addComment('t1', AGENT, 'hi', { project: 'p' }))
  assert.equal(call.init.headers['X-Agent-Id'], AGENT)
  assert.equal(JSON.parse(call.init.body).agent_id, AGENT)
})

test('next-claim sends X-Agent-Id (and never puts identity in the query)', async () => {
  const call = await capture(() => api.nextClaim(AGENT, { project: 'p', role: 'builder' }))
  assert.equal(call.init.headers['X-Agent-Id'], AGENT)
  assert.equal(JSON.parse(call.init.body).agent_id, AGENT)
  assert.ok(!call.url.includes(AGENT), 'the identity is not copied into the URL')
})

test('non-ASCII identities send a ByteString-safe header and keep the raw body id', async () => {
  // Cyrillic / emoji agent names would make fetch throw on the header value.
  // The header is reduced to printable ASCII; identity still travels raw in the
  // body (what a v3.12.8+ server ignores only for a credential-bound caller).
  for (const agent of ['Агент-7', '🤖 builder']) {
    const call = await capture(() => api.claimTask('t1', agent, { project: 'p' }))
    const header = call.init.headers['X-Agent-Id']
    assert.ok(header, `expected a header for ${agent}`)
    assert.match(header, /^[\u0020-\u007e]+$/, `header must be printable ASCII for ${agent}`)
    assert.doesNotThrow(() => new Headers(call.init.headers))
    assert.equal(JSON.parse(call.init.body).agent_id, agent, 'body keeps the raw identity')
  }
})

test('assignment does NOT declare the target as the caller', async () => {
  const call = await capture(() => api.assignTask('t1', 'target-agent', { project: 'p' }))
  assert.equal(call.init.headers['X-Agent-Id'], undefined)
  assert.equal(JSON.parse(call.init.body).agent_id, 'target-agent')
})
