import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
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
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'columncolors-test-'))
  const tmpFile = path.join(tmpDir, 'mod.mjs')
  await writeFile(tmpFile, result.outputFiles[0].text)
  try {
    return await import(pathToFileURL(tmpFile).href)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

describe('v2.5.0 column colors', () => {
  it('the stock palette matches the shipped accent map', async () => {
    const m = await importModule('columnColors.ts')
    assert.deepEqual(m.DEFAULT_COLUMN_COLORS, {
      BACKLOG: 'muted',
      READY: 'line',
      PLANNING: 'block',
      IN_PROGRESS: 'live',
      IN_REVIEW: 'warn',
      VALIDATION: 'test',
      READY_TO_SHIP: 'pass',
      DONE: 'pass',
      BLOCKED: 'fail',
      UNKNOWN: 'line',
      ISSUES: 'warn',
      BUILDING: 'live',
      IN_TEST: 'test',
    })
  })

  it('resolveColumnAccent returns the literal accent class for each token', async () => {
    const m = await importModule('columnColors.ts')
    assert.equal(m.resolveColumnAccent('BUILDING'), 'border-t-2 border-t-live')
    assert.equal(m.resolveColumnAccent('IN_TEST'), 'border-t-2 border-t-test')
    assert.equal(m.resolveColumnAccent('BLOCKED'), 'border-t-2 border-t-fail')
    assert.equal(m.resolveColumnAccent('unknown-status'), 'border-t-2 border-t-line')
  })

  it('a project override takes precedence over the stock palette', async () => {
    const m = await importModule('columnColors.ts')
    assert.equal(
      m.resolveColumnAccent('BUILDING', { BUILDING: 'fail' }),
      'border-t-2 border-t-fail'
    )
    // Untouched columns fall back to stock.
    assert.equal(m.resolveColumnAccent('DONE', { BUILDING: 'fail' }), 'border-t-2 border-t-pass')
    // null/undefined colors -> stock.
    assert.equal(m.resolveColumnAccent('BUILDING', null), 'border-t-2 border-t-live')
  })

  it('every palette token has a literal accent + swatch class (Tailwind JIT)', async () => {
    const m = await importModule('columnColors.ts')
    for (const token of m.COLUMN_COLOR_TOKENS) {
      assert.match(m.ACCENT_CLASS[token], /^border-t-2 border-t-/)
      assert.match(m.SWATCH_CLASS[token], /^bg-/)
      // Literal class strings — no interpolation anywhere in the module.
    }
    const source = readFileSync(path.join(__dirname, 'columnColors.ts'), 'utf8')
    assert.doesNotMatch(source, /`[^`]*\$\{[^}]*\}[^`]*border-t/)
  })

  it('isStockPalette detects customization', async () => {
    const m = await importModule('columnColors.ts')
    assert.equal(m.isStockPalette(null), true)
    assert.equal(m.isStockPalette({}), true)
    assert.equal(m.isStockPalette({ BUILDING: 'live' }), true)
    assert.equal(m.isStockPalette({ BUILDING: 'fail' }), false)
  })

  it('App wires settings load, SSE, and the Board/BoardFilters props', () => {
    const app = readFileSync(path.join(__dirname, '..', 'App.tsx'), 'utf8')
    assert.match(app, /subscribeToBoard/)
    assert.match(app, /getSettings\(project \|\| undefined\)/)
    assert.match(app, /saveSettings\(project \|\| undefined, payload\)/)
    // The server is the source of truth: no local palette is pushed back to it
    // on load, and a refused save is reverted and reported, never swallowed.
    assert.doesNotMatch(app, /saveSettings\([^)]*\)\.catch\(\(\) => \{\}\)/)
    assert.doesNotMatch(app, /isStockPalette/)
    assert.match(app, /setColumnColors\(serverColors\.current\)/)
    assert.match(app, /columnColorsSaveError=\{columnColorsSaveError\}/)
    assert.match(app, /columnColors=\{columnColors\}/)
    assert.match(app, /onColumnColorsChange=\{handleColumnColorsChange\}/)
  })

  it('Board resolves the accent per column; Column honors the override', () => {
    const board = readFileSync(path.join(__dirname, '..', 'components', 'Board.tsx'), 'utf8')
    assert.match(board, /resolveColumnAccent\(col\.status, columnColors\)/)
    const column = readFileSync(path.join(__dirname, '..', 'components', 'Column.tsx'), 'utf8')
    assert.match(column, /accentClass \?\? COLUMN_ACCENTS\[normalizedStatus\]/)
    assert.match(column, /prev\.accentClass === next\.accentClass/)
  })

  it('TaskSheet renders a comments thread; its composer is kept but hidden, sharing the single agent id', () => {
    const sheet = readFileSync(path.join(__dirname, '..', 'components', 'TaskSheet.tsx'), 'utf8')
    // Commented-out JSX never renders: strip it to get the live sheet.
    const live = sheet.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    assert.match(live, /\bComments\b/)
    assert.match(live, /addComment\(task\.id/)
    // The composer is hidden at the owner's request: commented out, not deleted.
    assert.doesNotMatch(live, /Post comment/)
    const hidden = [...sheet.matchAll(/\{\/\*[\s\S]*?\*\/\}/g)].map((m) => m[0]).find((c) => c.includes('Post comment'))
    assert.ok(hidden, 'the comment composer must be kept inside a hidden (commented) block')
    assert.match(hidden, /owner's request/)
    // One shared Agent ID input (placeholder appears exactly once, in the hidden block).
    const matches = sheet.match(/placeholder="Agent ID"/g) ?? []
    assert.equal(matches.length, 1)
    assert.match(hidden, /placeholder="Agent ID"/)
    // Comments decode stored entities and sort oldest-first.
    assert.match(sheet, /decodeStored\(comment\.message\)/)
  })

  it('columnColors storage helpers round-trip correctly and validate tokens', async () => {
    const m = await importModule('columnColors.ts')
    const store = {}
    globalThis.localStorage = {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => {
        store[k] = String(v)
      },
      removeItem: (k) => {
        delete store[k]
      },
    }

    assert.equal(m.columnColorsStorageKey('aov'), 'kanban.columnColors.aov')
    assert.equal(m.columnColorsStorageKey(''), 'kanban.columnColors.default')
    assert.equal(m.readStoredColumnColors('aov'), null)

    m.writeStoredColumnColors('aov', { BUILDING: 'fail', DONE: 'warn' })
    assert.deepEqual(m.readStoredColumnColors('aov'), { BUILDING: 'fail', DONE: 'warn' })

    // Invalid tokens in raw storage are ignored
    store['kanban.columnColors.aov'] = JSON.stringify({ BUILDING: 'invalid-token', DONE: 'fail' })
    assert.deepEqual(m.readStoredColumnColors('aov'), { DONE: 'fail' })

    // Clearing colors removes the item
    m.writeStoredColumnColors('aov', null)
    assert.equal(m.readStoredColumnColors('aov'), null)
    assert.equal(store['kanban.columnColors.aov'], undefined)
  })
})