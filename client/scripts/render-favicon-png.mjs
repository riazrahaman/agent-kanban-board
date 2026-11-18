// One-off rasterizer: turns client/public/favicon.svg into PNG favicons.
// Run: node scripts/render-favicon-png.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const svgPath = join(here, '..', 'public', 'favicon.svg')
const svg = await readFile(svgPath, 'utf8')
const pub = join(here, '..', 'public')

// A PNG cannot follow prefers-color-scheme like the SVG can, so the favicons
// we ship bake the LIGHT palette (the SVG's default). If the source SVG's
// design changes, re-render here rather than hand-editing the PNGs.
const browser = await chromium.launch()

async function render(size, out) {
  const html = `<!doctype html><style>html,body{margin:0}</style>${svg.replace(
    '<svg ',
    `<svg width="${size}" height="${size}" `,
  )}`
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(html, { waitUntil: 'networkidle' })
  await writeFile(out, await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size } }))
  await page.close()
}

await render(32, join(pub, 'favicon.png'))
await render(180, join(pub, 'apple-touch-icon.png'))
await browser.close()
console.log('rendered favicon.png + apple-touch-icon.png')
