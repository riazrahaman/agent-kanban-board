import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Guards docs/CONFIGURATION.md + .env.example against drift (v2.9.0, ENH-10).
// Every `process.env.KANBAN_*` (plus PORT/HOST) read anywhere in server source
// must be documented in the generated reference AND listed in .env.example.
// If you add a new env var, run `node scripts/gen-config-reference.mjs` and add
// it to .env.example (and its DESCRIPTIONS entry in the script).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

function collectServerEnvVars(dir, acc = new Set()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectServerEnvVars(full, acc);
    } else if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) {
      if (/\.test\./.test(entry.name)) continue;
      const src = readFileSync(full, 'utf8');
      for (const m of src.matchAll(/process\.env\.(KANBAN_[A-Z0-9_]+)/g)) acc.add(m[1]);
      for (const m of src.matchAll(/process\.env\.(PORT|HOST)\b/g)) acc.add(m[1]);
    }
  }
  return acc;
}

describe('configuration reference (v2.9.0)', () => {
  const vars = collectServerEnvVars(join(repoRoot, 'server'));
  const docPath = join(repoRoot, 'docs', 'CONFIGURATION.md');
  const envExamplePath = join(repoRoot, '.env.example');

  test('the generator script exists', () => {
    assert.ok(
      existsSync(join(repoRoot, 'scripts', 'gen-config-reference.mjs')),
      'scripts/gen-config-reference.mjs must exist',
    );
  });

  test('every server env var appears in docs/CONFIGURATION.md', () => {
    assert.ok(existsSync(docPath), 'docs/CONFIGURATION.md must exist (run the generator)');
    const doc = readFileSync(docPath, 'utf8');
    const missing = [...vars].filter((v) => !doc.includes(`\`${v}\``));
    assert.deepEqual(missing, [], `undocumented server env vars: ${missing.join(', ')}`);
  });

  test('.env.example exists and lists every KANBAN_* var', () => {
    assert.ok(existsSync(envExamplePath), '.env.example must be tracked');
    const env = readFileSync(envExamplePath, 'utf8');
    const kanbanVars = [...vars].filter((v) => v.startsWith('KANBAN_'));
    const missing = kanbanVars.filter((v) => !new RegExp(`^${v}=`, 'm').test(env));
    assert.deepEqual(missing, [], `.env.example is missing: ${missing.join(', ')}`);
  });

  test('.env.example is not gitignored', () => {
    const gi = readFileSync(join(repoRoot, '.gitignore'), 'utf8');
    assert.match(gi, /^!\.env\.example$/m, '.gitignore must re-include .env.example');
  });
});
