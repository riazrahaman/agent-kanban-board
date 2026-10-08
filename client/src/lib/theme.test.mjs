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

test('parseStoredMode: only the exact literals "light"/"dark" are explicit choices', () => {
  assert.equal(theme.parseStoredMode('light'), 'light')
  assert.equal(theme.parseStoredMode('dark'), 'dark')
})

test('parseStoredMode: null, undefined, "auto" and garbage all parse to auto', () => {
  assert.equal(theme.parseStoredMode(null), 'auto')
  assert.equal(theme.parseStoredMode(undefined), 'auto')
  assert.equal(theme.parseStoredMode('auto'), 'auto')
  assert.equal(theme.parseStoredMode('blue'), 'auto')
  assert.equal(theme.parseStoredMode(''), 'auto')
})

test('resolveMode: explicit "light"/"dark" ignore the OS preference either way', () => {
  assert.equal(theme.resolveMode('light', true), 'light')
  assert.equal(theme.resolveMode('light', false), 'light')
  assert.equal(theme.resolveMode('dark', true), 'dark')
  assert.equal(theme.resolveMode('dark', false), 'dark')
})

test('resolveMode: "auto" follows the live OS preference', () => {
  assert.equal(theme.resolveMode('auto', true), 'dark')
  assert.equal(theme.resolveMode('auto', false), 'light')
})

test('isDark matches the resolved theme', () => {
  assert.equal(theme.isDark(theme.resolveMode('light', true)), false)
  assert.equal(theme.isDark(theme.resolveMode('dark', false)), true)
  assert.equal(theme.isDark(theme.resolveMode('auto', true)), true)
  assert.equal(theme.isDark(theme.resolveMode('auto', false)), false)
})

test('nextMode cycles Auto -> Light -> Dark -> Auto', () => {
  assert.equal(theme.nextMode('auto'), 'light')
  assert.equal(theme.nextMode('light'), 'dark')
  assert.equal(theme.nextMode('dark'), 'auto')
})

test('modeLabel is a short, similar-width uppercase label for each mode', () => {
  assert.equal(theme.modeLabel('auto'), 'AUTO')
  assert.equal(theme.modeLabel('light'), 'LIGHT')
  assert.equal(theme.modeLabel('dark'), 'DARK')
})

test('themeToggleTitle names the current mode and what a click does next', () => {
  assert.equal(theme.themeToggleTitle('auto'), 'Theme: auto (follows system). Click for light')
  assert.equal(theme.themeToggleTitle('light'), 'Theme: light. Click for dark')
  assert.equal(theme.themeToggleTitle('dark'), 'Theme: dark. Click for auto')
})

test('persistence round-trips: resolving a stored mode twice is stable', () => {
  const stored = theme.parseStoredMode('light')
  assert.equal(theme.resolveMode(stored, true), 'light')
  assert.equal(theme.resolveMode(theme.parseStoredMode(stored), true), 'light')

  const dark = theme.parseStoredMode('dark')
  assert.equal(theme.resolveMode(dark, false), 'dark')
})
