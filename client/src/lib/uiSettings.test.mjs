import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function importModule(file) {
  const result = await build({
    entryPoints: [path.join(__dirname, file)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node20',
  })
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'uisettings-test-'))
  const tmpFile = path.join(tmpDir, 'mod.mjs')
  await writeFile(tmpFile, result.outputFiles[0].text)
  try {
    return await import(pathToFileURL(tmpFile).href)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

// In-memory localStorage mock for node test runner
class LocalStorageMock {
  constructor() {
    this.store = {}
  }
  getItem(key) {
    return this.store[key] ?? null
  }
  setItem(key, value) {
    this.store[key] = String(value)
  }
  removeItem(key) {
    delete this.store[key]
  }
  clear() {
    this.store = {}
  }
}

describe('v2.14.4 UI Settings persistence', () => {
  beforeEach(() => {
    globalThis.localStorage = new LocalStorageMock()
    delete globalThis.window
  })

  it('filters default to clean state when localStorage is empty', async () => {
    const m = await importModule('uiSettings.ts')
    assert.deepEqual(m.readStoredFilters(), {
      search: '',
      priority: 'all',
      assignee: 'all',
    })
  })

  it('filters round-trip through writeStoredFilters and readStoredFilters', async () => {
    const m = await importModule('uiSettings.ts')
    m.writeStoredFilters({ search: 'auth', priority: 'high', assignee: 'builder' })
    assert.deepEqual(m.readStoredFilters(), {
      search: 'auth',
      priority: 'high',
      assignee: 'builder',
    })
  })

  it('partial filter updates preserve other filter fields', async () => {
    const m = await importModule('uiSettings.ts')
    m.writeStoredFilters({ search: 'dashboard' })
    assert.deepEqual(m.readStoredFilters(), {
      search: 'dashboard',
      priority: 'all',
      assignee: 'all',
    })
    m.writeStoredFilters({ priority: 'low' })
    assert.deepEqual(m.readStoredFilters(), {
      search: 'dashboard',
      priority: 'low',
      assignee: 'all',
    })
  })

  it('resetStoredFilters clears stored filters', async () => {
    const m = await importModule('uiSettings.ts')
    m.writeStoredFilters({ search: 'query', priority: 'medium' })
    m.resetStoredFilters()
    assert.deepEqual(m.readStoredFilters(), {
      search: '',
      priority: 'all',
      assignee: 'all',
    })
    assert.equal(globalThis.localStorage.getItem(m.FILTERS_STORAGE_KEY), null)
  })

  it('showMetrics persistence round-trips correctly', async () => {
    const m = await importModule('uiSettings.ts')
    assert.equal(m.readStoredShowMetrics(), false)
    m.writeStoredShowMetrics(true)
    assert.equal(m.readStoredShowMetrics(), true)
    m.writeStoredShowMetrics(false)
    assert.equal(m.readStoredShowMetrics(), false)
  })

  it('view mode persistence round-trips correctly', async () => {
    const m = await importModule('uiSettings.ts')
    assert.equal(m.readStoredView(), 'board')
    m.writeStoredView('portfolio')
    assert.equal(m.readStoredView(), 'portfolio')
    m.writeStoredView('about')
    assert.equal(m.readStoredView(), 'about')
    m.writeStoredView('board')
    assert.equal(m.readStoredView(), 'board')
  })

  it('railOpen persistence round-trips correctly', async () => {
    const m = await importModule('uiSettings.ts')
    assert.equal(m.readStoredRailOpen(), false)
    m.writeStoredRailOpen(true)
    assert.equal(m.readStoredRailOpen(), true)
    m.writeStoredRailOpen(false)
    assert.equal(m.readStoredRailOpen(), false)
  })

  it('mobileFiltersOpen persistence round-trips correctly', async () => {
    const m = await importModule('uiSettings.ts')
    assert.equal(m.readStoredMobileFiltersOpen(), false)
    m.writeStoredMobileFiltersOpen(true)
    assert.equal(m.readStoredMobileFiltersOpen(), true)
    m.writeStoredMobileFiltersOpen(false)
    assert.equal(m.readStoredMobileFiltersOpen(), false)
  })

  it('headerOpen persistence round-trips correctly', async () => {
    const m = await importModule('uiSettings.ts')
    assert.equal(m.readStoredHeaderOpen(), false)
    m.writeStoredHeaderOpen(true)
    assert.equal(m.readStoredHeaderOpen(), true)
    m.writeStoredHeaderOpen(false)
    assert.equal(m.readStoredHeaderOpen(), false)
  })

  it('gracefully degrades when localStorage throws (e.g. private browsing)', async () => {
    globalThis.localStorage = {
      getItem: () => {
        throw new Error('Access denied')
      },
      setItem: () => {
        throw new Error('Quota exceeded')
      },
      removeItem: () => {
        throw new Error('Access denied')
      },
    }
    const m = await importModule('uiSettings.ts')
    assert.deepEqual(m.readStoredFilters(), { search: '', priority: 'all', assignee: 'all' })
    assert.equal(m.readStoredShowMetrics(), false)
    assert.equal(m.readStoredView(), 'board')
    assert.equal(m.readStoredRailOpen(), false)
    assert.equal(m.readStoredMobileFiltersOpen(), false)
    assert.equal(m.readStoredHeaderOpen(), false)
    assert.doesNotThrow(() => {
      m.writeStoredFilters({ search: 'test' })
      m.writeStoredShowMetrics(true)
      m.writeStoredView('about')
      m.writeStoredRailOpen(true)
      m.writeStoredMobileFiltersOpen(true)
      m.writeStoredHeaderOpen(true)
      m.resetStoredFilters()
    })
  })
})
