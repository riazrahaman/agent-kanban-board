// v3.2.4: ProjectPicker's listbox opened off-screen to the LEFT on a real
// iPhone (it was `absolute right-0 w-48`, right-aligned to a trigger at the
// left of the wrapped header disclosure row). These tests pin the pure
// placement maths (lib/menuPlacement.ts) and the component's source contract.
// The rendered geometry is additionally checked in a real browser at
// 360/390/430 touch + fine pointer (see CHANGELOG 3.2.4); esbuild bundles the
// TS source into ESM at test time, mirroring claimCoordinator.test.mjs.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const result = await build({
  entryPoints: [join(__dirname, 'menuPlacement.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
})
const tmpDir = await mkdtemp(join(tmpdir(), 'menuPlacement-test-'))
const tmpFile = join(tmpDir, 'menuPlacement.bundle.mjs')
await writeFile(tmpFile, result.outputFiles[0].text)
const { placeMenu, MENU_EDGE_MARGIN, MENU_GAP } = await import(pathToFileURL(tmpFile).href)
await rm(tmpDir, { recursive: true, force: true })

const pickerSource = readFileSync(join(__dirname, '..', 'components', 'ProjectPicker.tsx'), 'utf8')
const columnColorsSource = readFileSync(join(__dirname, '..', 'components', 'ColumnColorsControl.tsx'), 'utf8')
const hookSource = readFileSync(join(__dirname, 'useMenuPlacement.ts'), 'utf8')

const inside = (p, vw) => p.left >= MENU_EDGE_MARGIN && p.left + p.width <= vw - MENU_EDGE_MARGIN

test('desktop: a trigger with room on its left keeps the original right-aligned placement', () => {
  const anchor = { top: 10, bottom: 34, left: 900, right: 1000 }
  const p = placeMenu(anchor, 1440, 192)
  assert.equal(p.left + p.width, 1000, 'right edge stays flush with the trigger (old right-0)')
  assert.equal(p.width, 192)
  assert.equal(p.top, 34 + MENU_GAP)
})

test('phone: a trigger at the LEFT edge (the iPhone bug) left-aligns instead of running off-screen', () => {
  for (const vw of [320, 360, 390, 430]) {
    const anchor = { top: 200, bottom: 244, left: 12, right: 100 } // "demo ▾" at the row start
    const p = placeMenu(anchor, vw, 256)
    assert.ok(p.left >= MENU_EDGE_MARGIN, `left edge ${p.left} must not cross the viewport at ${vw}px`)
    assert.ok(inside(p, vw), `menu must lie inside the viewport at ${vw}px: ${JSON.stringify(p)}`)
    assert.equal(p.left, 12, 'left-aligned with the trigger')
  }
})

test('a trigger anywhere in a wrapped row stays inside the viewport (sweep)', () => {
  for (const vw of [320, 360, 390, 430, 768, 1024, 1280]) {
    for (let x = 0; x <= vw - 40; x += 7) {
      const p = placeMenu({ top: 0, bottom: 40, left: x, right: x + 40 }, vw, 256)
      assert.ok(inside(p, vw), `vw=${vw} trigger@${x}: ${JSON.stringify(p)}`)
    }
  }
})

test('a viewport narrower than the preferred width shrinks the menu to fit with both margins', () => {
  const p = placeMenu({ top: 0, bottom: 40, left: 100, right: 160 }, 240, 256)
  assert.equal(p.width, 240 - 2 * MENU_EDGE_MARGIN)
  assert.equal(p.left, MENU_EDGE_MARGIN)
})

test('ProjectPicker source contract: fixed + measured, never the old absolute right-0 anchoring', () => {
  assert.doesNotMatch(pickerSource, /absolute right-0/, 'the right-0 anchoring pushed the menu off-screen left on phones')
  assert.match(pickerSource, /useMenuPlacement\(open, triggerRef/, 'the menu must be placed by lib/useMenuPlacement.ts')
  assert.match(hookSource, /placeMenu\(/, 'the hook must clamp via lib/menuPlacement.ts')
  assert.match(hookSource, /getBoundingClientRect\(\)/, 'placement must come from the measured trigger rect')
  const listbox = pickerSource.match(/role="listbox"[\s\S]*?className="([^"]*)"/)?.[1] ?? ''
  assert.match(listbox, /\bfixed\b/, 'the listbox must be position: fixed')
  assert.match(listbox, /\boverflow-y-auto\b/, 'long project lists must scroll inside the menu')
  assert.match(pickerSource, /maxHeight: menuMaxHeight\(/, 'max-height must be capped')
  assert.match(hookSource, /100dvh[^\n]*safe-area-inset-bottom/, 'max-height must respect the visible viewport and bottom safe area')
})

test('ProjectPicker options: readable on touch, truncate long names, closes on outside tap', () => {
  const option = pickerSource.match(/role="option"[\s\S]*?className=\{`([^`]*)`/)?.[1] ?? ''
  assert.match(option, /\bpointer-coarse:min-h-11\b/, '44px tap height on coarse pointers')
  assert.match(option, /\bpointer-coarse:text-sm\b/, '>=14px text on coarse pointers')
  assert.match(option, /\btruncate\b/, 'long names truncate inside the menu')
  assert.match(pickerSource, /title=\{item\.label\}/, 'the full name stays available as a tooltip')
  assert.match(pickerSource, /addEventListener\('pointerdown'/, 'outside TAP must close it — iOS fires no mousedown on non-clickable areas')
  assert.match(pickerSource, /e\.key === 'Escape'/, 'Escape closes it')
  assert.match(pickerSource, /scrollIntoView/, 'the selected project is scrolled into view')
})

test('ColumnColorsControl: from sm up the popover is fixed + measured, not absolute right-0 (same off-screen-left bug)', () => {
  const dialog = columnColorsSource.match(/aria-label="Column colors"[\s\S]*?className="([^"]*)"/)?.[1] ?? ''
  assert.doesNotMatch(dialog, /sm:absolute|sm:right-0/, 'right-0 anchoring ran off the left edge at 820px (x=-95)')
  assert.match(dialog, /\bsm:fixed\b/)
  assert.match(dialog, /\bsm:overflow-y-auto\b/, 'tall popover must scroll instead of running off the bottom')
  assert.match(columnColorsSource, /useMenuPlacement\(open, triggerRef, POPOVER_WIDTHS, '\(min-width: 640px\)'\)/, 'measured placement only where the sm: classes apply')
  assert.match(columnColorsSource, /maxHeight: menuMaxHeight\(/)
  assert.match(columnColorsSource, /addEventListener\('pointerdown'/, 'outside tap must close it on iOS')
})
