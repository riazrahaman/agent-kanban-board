// One-off rasterizer: turns client/public/favicon.svg into PNG favicons plus
// a legacy .ico (PNG-encoded, valid since Vista and accepted by WebKit).
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

// favicon.ico: single 32x32 entry, PNG-compressed (ICO permits PNG payloads
// for <=256px images). Safari probes /favicon.ico at the site root when its
// <link rel="icon"> selection comes up empty, so the file must exist even
// though every modern path is covered by the PNG/SVG links.
function wrapPngInIco(png) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(1, 4) // count
  const entry = Buffer.alloc(16)
  entry.writeUInt8(32, 0) // width
  entry.writeUInt8(32, 1) // height
  entry.writeUInt8(0, 2) // palette
  entry.writeUInt8(0, 3) // reserved
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(png.length, 8) // payload size
  entry.writeUInt32LE(22, 12) // payload offset
  return Buffer.concat([header, entry, png])
}

await render(32, join(pub, 'favicon.png'))
await render(180, join(pub, 'apple-touch-icon.png'))
await writeFile(
  join(pub, 'favicon.ico'),
  wrapPngInIco(await readFile(join(pub, 'favicon.png'))),
)
await browser.close()
console.log('rendered favicon.png + apple-touch-icon.png + favicon.ico')
