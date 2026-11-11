/**
 * C4 (v3.12.5) — single source of truth for the running release.
 *
 * Before this module, four places re-read `server/package.json` themselves
 * (`routes/health.js`, `deployDrift.js`, `askKnowledge.js`, and a
 * cwd-relative lookup in `routes/bugReports.js`). Each was correct, but a new
 * consumer had to know which file to read, and the bug-report copy resolved
 * from `process.cwd()` so it could disagree with the health endpoint when the
 * process was started from a different directory. Import `APP_VERSION` here
 * instead:
 *
 *   - the manifest read is module-relative, so it does not depend on cwd;
 *   - the value is read once at import (a release is a process lifetime);
 *   - a missing/unparsable manifest degrades to `'unknown'` rather than
 *     throwing during boot, matching the old bug-report fallback.
 *
 * The release-versioning discipline is unchanged: `server/package.json` is
 * still the one number every release bumps, and `kanban.version.test.js` still
 * pins the docs + deck + skill to it.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function readVersion() {
  try {
    const pkg = require('./package.json');
    return typeof pkg?.version === 'string' && pkg.version ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The version this process runs, e.g. `'3.12.5'` (or `'unknown'`). */
export const APP_VERSION = readVersion();

export default APP_VERSION;
