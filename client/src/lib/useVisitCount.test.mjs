// v2.9.1 regression guard for the About-page visit counter.
//
// The counter is a tokenless public service (abacus.jasoncameron.dev). The
// contract worth locking down is: it targets the board's OWN namespace (not
// riazrahaman.com's), the label formats correctly and degrades to empty when
// the count is unavailable, and the About page renders it while keeping the
// telemetry copy honest.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = join(__dirname, '..')

const reactStub = `
export const useState = (init) => [init, () => {}]
export const useEffect = () => {}
export default { useState, useEffect }
`
const stubPath = join(__dirname, 'reactStubForVisitCountTest.mjs')
await writeFile(stubPath, reactStub)

const result = await build({
  entryPoints: [join(__dirname, 'useVisitCount.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  alias: { react: stubPath },
})
const tmpDir = await mkdtemp(join(tmpdir(), 'visitcount-test-'))
const tmpFile = join(tmpDir, 'useVisitCount.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const mod = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })
await rm(stubPath, { force: true })

const { COUNTER_BASE, VISIT_NAMESPACE, VISIT_KEY, VISIT_SESSION_FLAG, formatVisitCount } = mod

test('the counter targets the board’s own namespace, not riazrahaman.com', () => {
  assert.equal(COUNTER_BASE, 'https://abacus.jasoncameron.dev')
  assert.equal(VISIT_NAMESPACE, 'agent-kanban.riazrahaman.com')
  assert.notEqual(VISIT_NAMESPACE, 'riazrahaman.com', 'must not share the personal-site namespace')
  assert.equal(VISIT_KEY, 'pageviews')
  assert.equal(VISIT_SESSION_FLAG, 'kanban-visit-counted')
})

test('formatVisitCount renders a readable label and degrades to empty', () => {
  assert.equal(formatVisitCount(1), '1 visit')
  assert.equal(formatVisitCount(2), '2 visits')
  assert.equal(formatVisitCount(1234), `${(1234).toLocaleString()} visits`)
  assert.equal(formatVisitCount(null), '')
  assert.equal(formatVisitCount(undefined), '')
  assert.equal(formatVisitCount(Number.NaN), '')
})

test('the About page renders the counter and keeps the telemetry copy honest', () => {
  const about = readFileSync(join(CLIENT_SRC, 'components', 'About.tsx'), 'utf8')
  assert.match(about, /useVisitCount\(\)/, 'About.tsx must call the visit-count hook')
  assert.match(about, /formatVisitCount\(visitCount\)/, 'About.tsx must render the formatted count')
  assert.doesNotMatch(
    about,
    /zero telemetry/,
    'the About footer must not claim “zero telemetry” now that it contacts a visit counter',
  )

  const content = readFileSync(join(CLIENT_SRC, 'lib', 'aboutContent.ts'), 'utf8')
  assert.doesNotMatch(
    content,
    /zero-telemetry/,
    'the FAQ must not claim “zero-telemetry” while the hosted demo counts visits',
  )
})
