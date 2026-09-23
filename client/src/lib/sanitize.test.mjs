// decodeStored restores the entity set the server escapes on write. esbuild
// bundles the TS source into ESM at test time (mirrors stageOwners.test.mjs).
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))

const result = await build({
  entryPoints: [join(__dirname, '..', 'sanitize.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})

const tmpDir = await mkdtemp(join(tmpdir(), 'sanitize-test-'))
const tmpFile = join(tmpDir, 'sanitize.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const { decodeStored, escapeHtml } = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

test('a plain string passes through untouched', () => {
  assert.equal(decodeStored('fix the login bug'), 'fix the login bug')
  assert.equal(decodeStored(''), '')
})

test('every entity the server escapes is decoded', () => {
  assert.equal(decodeStored('it&#039;s ready'), "it's ready")
  assert.equal(decodeStored('&lt;img src=x&gt;'), '<img src=x>')
  assert.equal(decodeStored('say &quot;hi&quot;'), 'say "hi"')
  assert.equal(decodeStored('a &amp; b'), 'a & b')
})

test('a stored &amp;lt; decodes exactly once — never into a real tag', () => {
  // The server escapes '<' to '&lt;' and '&' to '&amp;', so a stored source of
  // "&amp;lt;" is the literal text "&lt;". Decoding must stop at the literal.
  assert.equal(decodeStored('&amp;lt;'), '&lt;')
  assert.equal(decodeStored('&amp;amp;'), '&amp;')
})

test('round-trips with escapeHtml', () => {
  for (const raw of [
    "it's <b>done</b> &amp; good",
    'a "quoted" title',
    '<script>alert(1)</script>',
    'plain text with no entities',
  ]) {
    assert.equal(decodeStored(escapeHtml(raw)), raw)
  }
})

test('non-string input degrades to an empty string (server contract)', () => {
  // @ts-expect-error — the client types say string, but a legacy payload may not.
  assert.equal(decodeStored(null), '')
  // @ts-expect-error
  assert.equal(decodeStored(undefined), '')
  // @ts-expect-error
  assert.equal(decodeStored(123), '')
})