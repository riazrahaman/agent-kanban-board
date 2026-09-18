// Pure theme-resolution rules. esbuild bundles the TS into ESM at test time
// (mirrors authToken.test.mjs / claimCoordinator.test.mjs).
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))

const result = await build({
  entryPoints: [join(__dirname, 'theme.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})
const tmpDir = await mkdtemp(join(tmpdir(), 'theme-test-'))
const tmpFile = join(tmpDir, 'theme.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const theme = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

test('explicit "light" wins over prefers-color-scheme: dark', () => {
  assert.equal(theme.resolveTheme('light', true), 'light')
  assert.equal(theme.isDark(theme.resolveTheme('light', true)), false)
})

test('explicit "dark" yields dark regardless of OS preference', () => {
  assert.equal(theme.resolveTheme('dark', false), 'dark')
  assert.equal(theme.isDark(theme.resolveTheme('dark', false)), true)
})

test('no stored choice falls back to the OS preference', () => {
  assert.equal(theme.resolveTheme(null, true), 'dark')
  assert.equal(theme.resolveTheme(undefined, false), 'light')
  // A garbage stored value is treated as "not chosen".
  assert.equal(theme.resolveTheme('blue', true), 'dark')
  assert.equal(theme.resolveTheme('blue', false), 'light')
})

test('the toggle flips to the opposite theme', () => {
  assert.equal(theme.nextTheme('dark'), 'light')
  assert.equal(theme.nextTheme('light'), 'dark')
})

test('persistence round-trips: resolved choice is stable across a re-read', () => {
  const chosen = theme.resolveTheme('light', true)
  const reRead = theme.resolveTheme(chosen, true)
  assert.equal(reRead, 'light')
  assert.equal(chosen, 'light')

  const dark = theme.resolveTheme('dark', false)
  assert.equal(theme.resolveTheme(dark, false), 'dark')
})
