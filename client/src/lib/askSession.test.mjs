// Stale stored Ask password handling. esbuild bundles the TS source at test time.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test, beforeEach } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const result = await build({
  entryPoints: [join(__dirname, 'ask.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})
const tmpDir = await mkdtemp(join(tmpdir(), 'ask-test-'))
const tmpFile = join(tmpDir, 'ask.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const ask = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

let calls
function stubFetch(handler) {
  calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), headers: opts?.headers ?? {} })
    return handler(String(url))
  }
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body })

beforeEach(() => {
  store.clear()
  ask.resetAskSessionState()
})

test('a 401 invalid_pass from POST /api/ask clears the stored password', async () => {
  ask.writeStoredAskPass('old-pass')
  stubFetch(() => json(401, { error: 'invalid_pass' }))
  await assert.rejects(() => ask.askQuestion('what is the reaper', 'old-pass'))
  assert.equal(ask.readStoredAskPass(), '')
})

test('other failures keep the stored password', async () => {
  ask.writeStoredAskPass('good-pass')
  stubFetch(() => json(503, { error: 'timeout' }))
  await assert.rejects(() => ask.askQuestion('what is the reaper', 'good-pass'))
  assert.equal(ask.readStoredAskPass(), 'good-pass')
})

test('a password answered with the limited view is not sent to config again this session', async () => {
  stubFetch(() => json(200, { enabled: true, gated: true }))
  await ask.getAskConfig('stale')
  assert.equal(calls[0].headers['x-ask-pass'], 'stale')
  await ask.getAskConfig('stale')
  assert.equal(calls[1].headers['x-ask-pass'], undefined)
  // A different (newly typed) password is still tried.
  await ask.getAskConfig('fresh')
  assert.equal(calls[2].headers['x-ask-pass'], 'fresh')
})

test('a password that got the full view keeps being sent', async () => {
  stubFetch(() => json(200, { enabled: true, gated: true, provider: 'openrouter', model: 'm' }))
  await ask.getAskConfig('good')
  await ask.getAskConfig('good')
  assert.equal(calls[1].headers['x-ask-pass'], 'good')
})
