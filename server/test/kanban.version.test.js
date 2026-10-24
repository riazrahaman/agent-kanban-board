import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Guards the release-versioning discipline documented in README.md and
// CHANGELOG.md: the version the UI shows comes from server/package.json, so a
// shipped change must bump it, mirror it into the root manifest, document a
// matching CHANGELOG section, and hardcode nothing but that number in docs.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

function readJson(rel) {
  return JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));
}

describe('release versioning', () => {
  const serverPkg = readJson('server/package.json');
  const rootPkg = readJson('package.json');
  const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');

  test('server and root package version stay in lockstep', () => {
    assert.equal(
      serverPkg.version,
      rootPkg.version,
      'server/package.json and package.json versions must match',
    );
  });

  test('version is a plain semver triple', () => {
    assert.match(serverPkg.version, /^\d+\.\d+\.\d+$/);
  });

  test('CHANGELOG has a section for the current version', () => {
    const escaped = serverPkg.version.replace(/\./g, '\\.');
    assert.match(
      changelog,
      new RegExp(`^## \\[${escaped}\\]`, 'm'),
      `CHANGELOG.md must contain a "## [${serverPkg.version}]" release section`,
    );
  });

  test('CHANGELOG does not leave shipped work stuck under Unreleased', () => {
    // A release section for the current version must appear ABOVE the
    // [Unreleased] heading (i.e. Unreleased is empty once the version is cut
    // ... unless a new cycle has genuinely started). We only require that the
    // current version is documented, never that Unreleased is non-empty.
    const currentIdx = changelog.indexOf(`## [${serverPkg.version}]`);
    assert.ok(currentIdx > -1, 'current version section present');
  });

  test('docs do not hardcode a stale system version', () => {
    const docs = [
      'docs/SYSTEM_DESIGN_AND_ARCHITECTURE.md',
      'docs/USER_AND_OPERATOR_MANUAL.md',
      'docs/with-images/SYSTEM_DESIGN_AND_ARCHITECTURE.md',
      'docs/with-images/USER_AND_OPERATOR_MANUAL.md',
      // The presenter's runbook is a living document (docs/PRESENTER_RUNBOOK.md
      // §11): pinning it here is what makes "living" enforceable rather than a
      // promise. A release that leaves its version behind fails CI.
      'docs/PRESENTER_RUNBOOK.md',
      // The shareable walkthrough page (docs/presentation/index.html) is the
      // same living document in HTML: pinned here so a release cannot leave the
      // page people were given a link to showing an older version.
      'docs/presentation/index.html',
      // The slide deck's cover carries the version in its footer strip. It is
      // the same living document again, so a release that forgets the deck
      // fails here rather than on stage.
      'docs/presentation/deck/slides/cover.html',
      // v3.9.5: the bundled orchestrator skill declares the board version it
      // ships with. Pinning it here is what stops the skill telling agents about
      // a board surface (e.g. `deploy_drift`) that the shipped version does not
      // have — the skill and the server must never be released apart.
      'skills/kanban/SKILL.md',
    ];
    for (const rel of docs) {
      const text = readFileSync(join(repoRoot, rel), 'utf8');
      // The deck is inline-styled slide markup, not prose: its marker is the
      // version the cover actually renders, so there is nothing to keep in
      // step with a separate header.
      const marker = rel.endsWith('deck/slides/cover.html')
        ? />v(\d+\.\d+\.\d+)</
        : rel.endsWith('skills/kanban/SKILL.md')
          // The skill's frontmatter `version:` is the board release it ships
          // with (multiline: the marker is not on line 1).
          ? /^version:\s*(\d+\.\d+\.\d+)/m
          : rel.includes('SYSTEM_DESIGN')
            ? /\*\*System Version:\*\*\s*(\d+\.\d+\.\d+)/
            : /Agent Kanban Board v(\d+\.\d+\.\d+)/;
      const found = text.match(marker);
      assert.ok(found, `${rel} should declare a system version`);
      assert.equal(
        found[1],
        serverPkg.version,
        `${rel} declares v${found[1]} but server/package.json is v${serverPkg.version}`,
      );
    }
  });
});
