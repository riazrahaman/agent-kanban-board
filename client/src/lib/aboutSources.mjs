// Test helper — the About page's source, as one string.
//
// v3.12.5 split the page into a shell (components/About.tsx), per-chapter
// sections (client/src/about/*.tsx) and small shared primitives. The source
// contracts in about.test.mjs, aboutFieldGuide.test.mjs, responsive.test.mjs,
// bugReportContract.test.mjs and useVisitCount.test.mjs describe the PAGE —
// its masthead, chapter grammar, SVG and Ask console — not one filename. They
// therefore scan the whole page source, exactly as they scanned the monolith
// before the split.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Concatenated source of client/src/components/About.tsx + client/src/about/*.tsx. */
export function readAboutSources() {
  const parts = [readFileSync(join(CLIENT_SRC, 'components', 'About.tsx'), 'utf8')]
  const dir = join(CLIENT_SRC, 'about')
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.tsx')).sort()) {
    parts.push(readFileSync(join(dir, file), 'utf8'))
  }
  return parts.join('\n')
}

/** The page-shell source alone (components/About.tsx). */
export function readAboutShell() {
  return readFileSync(join(CLIENT_SRC, 'components', 'About.tsx'), 'utf8')
}
