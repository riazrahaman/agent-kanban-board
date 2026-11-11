// Auth headers for browser-originated mutations. esbuild bundles the TS source
// into ESM at test time (mirrors claimCoordinator.test.mjs).
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))

const result = await build({
  entryPoints: [join(__dirname, 'authToken.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})
const tmpDir = await mkdtemp(join(tmpdir(), 'authToken-test-'))
const tmpFile = join(tmpDir, 'authToken.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const auth = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

test('a token produces a Bearer header and a role', () => {
  const h = auth.authHeaders('tok-abc')
  assert.equal(h.Authorization, 'Bearer tok-abc')
  assert.equal(h['X-Agent-Role'], 'builder')
})

test('no token means NO Authorization header, not an empty Bearer', () => {
  // `Bearer ` would be sent, fail the server's comparison, and look in the logs
  // like a wrong token rather than a missing one.
  for (const empty of ['', '   ', null, undefined]) {
    const h = auth.authHeaders(empty)
    assert.ok(
      !('Authorization' in h),
      `expected no Authorization header for ${JSON.stringify(empty)}`,
    )
    assert.equal(h['X-Agent-Role'], 'builder', 'the role is still sent')
  }
})

test('surrounding whitespace is stripped from a pasted token', () => {
  // Copy-paste from a terminal or a secrets manager routinely carries a newline.
  assert.equal(auth.authHeaders('  tok-abc\n').Authorization, 'Bearer tok-abc')
})

test('the role is required by the server, so it is always present', () => {
  // Every mutating route 403s without a valid role, independently of the token.
  assert.equal(auth.authHeaders('t', 'reviewer')['X-Agent-Role'], 'reviewer')
  assert.equal(auth.CLIENT_ROLE, 'builder')
})

test('the token is never embedded in a URL or query string', () => {
  // The whole point of the header-only rule: a token in a URL lands in access
  // logs, Referer headers and browser history.
  const h = auth.authHeaders('tok-secret')
  const serialized = JSON.stringify(h)
  assert.ok(serialized.includes('Bearer tok-secret'), 'sent as a header')
  assert.ok(!serialized.includes('?'), 'no query fragment is constructed here')
})

test('A7: an agent identity is sent as X-Agent-Id, trimmed, and never empty', () => {
  assert.equal(auth.authHeaders('tok', 'builder', '  agent-7  ')['X-Agent-Id'], 'agent-7')
  assert.equal(auth.authHeaders('tok', 'builder', '   ')['X-Agent-Id'], undefined)
  assert.equal(auth.authHeaders('tok', 'builder', null)['X-Agent-Id'], undefined)
  assert.equal(auth.authHeaders('tok')['X-Agent-Id'], undefined, 'omitted when no identity is supplied')
})

// `fetch` converts every header value to a ByteString, so any character above
// U+00FF throws before the request is sent. Printable ASCII is the safe subset
// this module promises.
const isByteStringSafe = (value) => /^[\u0020-\u007e]+$/.test(value)

test('A7: control characters are stripped from the identity header value', () => {
  // A newline in a header value makes fetch throw, and on the wire it is the
  // shape used to forge a log line. Replace rather than send or crash.
  const h = auth.authHeaders('tok', 'builder', 'agent\nX-Evil: 1\r')
  assert.equal(h['X-Agent-Id'], 'agent-X-Evil: 1')
  assert.ok(!/[\r\n]/.test(h['X-Agent-Id']))
  assert.ok(isByteStringSafe(h['X-Agent-Id']))
})

test('A7: printable ASCII identities are sent unchanged', () => {
  assert.equal(auth.authHeaders('tok', 'builder', 'agent-7')['X-Agent-Id'], 'agent-7')
  assert.equal(auth.authHeaders('tok', 'builder', '  agent_7.v2  ')['X-Agent-Id'], 'agent_7.v2')
})

test('A7: non-Latin-1 identities still produce a sendable header', () => {
  // Cyrillic / emoji are legitimate agent names but are not ByteString-safe.
  // They must not throw at fetch time, and the header must not be empty.
  for (const raw of ['Агент-7', '🤖 builder', '日本語エージェント', 'агент🤖7']) {
    const h = auth.authHeaders('tok', 'builder', raw)
    const header = h['X-Agent-Id']
    assert.ok(header, `expected a non-empty header for ${raw}`)
    assert.ok(isByteStringSafe(header), `expected printable ASCII for ${raw}, got ${header}`)
    assert.doesNotThrow(() => new Headers(h), `headers must be constructible for ${raw}`)
    assert.equal(auth.authHeaders('tok', 'builder', raw)['X-Agent-Id'], header, 'deterministic')
  }
})

test('A7: an identity with nothing printable left falls back to a stable placeholder', () => {
  for (const raw of ['🤖', '日本語', 'Агент']) {
    assert.equal(auth.authHeaders('tok', 'builder', raw)['X-Agent-Id'], 'agent')
  }
  // Whitespace-only is still treated as "no identity supplied".
  assert.equal(auth.authHeaders('tok', 'builder', '   ')['X-Agent-Id'], undefined)
})
