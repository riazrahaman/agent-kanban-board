// COR-04: the stream-ticket mint must carry the client's role in the body, so
// a credential without a bound role can still obtain a ticket.
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
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node20',
})
const tmpDir = await mkdtemp(join(tmpdir(), 'streamTicketRole-test-'))
const tmpFile = join(tmpDir, 'api.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const api = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

globalThis.localStorage = {
  getItem: (k) => (k === 'kanban.token' ? 'tok' : null),
  setItem: () => {}, removeItem: () => {},
}
const calls = []
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init })
  return new Response(JSON.stringify({ ticket: 'tkt' }), { status: 200, headers: { 'content-type': 'application/json' } })
}
const sources = []
globalThis.EventSource = class {
  constructor(url) { this.url = url; sources.push(this) }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

async function mintVia(project) {
  calls.length = 0
  sources.length = 0
  const stop = api.subscribeToDiffs(() => {}, project ? { project } : {})
  for (let i = 0; i < 20 && sources.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5))
  stop()
  return calls.find((x) => x.url.endsWith('/auth/stream-ticket'))
}

test('stream-ticket mint sends the client role in the body and header', async () => {
  const call = await mintVia('alpha')
  assert.ok(call, 'a ticket was minted')
  const body = JSON.parse(call.init.body)
  assert.equal(body.role, 'builder')
  assert.equal(body.project, 'alpha')
  assert.equal(call.init.headers['X-Agent-Role'], 'builder')
  assert.match(sources[0].url, /ticket=tkt/)
})

test('stream-ticket mint without a project still sends the role', async () => {
  const body = JSON.parse((await mintVia()).init.body)
  assert.deepEqual(body, { role: 'builder' })
})
