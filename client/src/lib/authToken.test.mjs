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
