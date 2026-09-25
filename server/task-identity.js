/**
 * Task identity & project namespacing (ENH-11, v2.10.0) — extracted verbatim
 * from store.js so the storage backends and the task engine share one
 * definition of "what is a valid id / project / branch" and one atomic-write
 * primitive.
 *
 * The only external dependency is node:fs/promises + node:path for writeAtomic.
 * store.js re-exports every symbol here so existing `../store.js` importers are
 * unaffected.
 */
import { writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

// ============================================================================
// Atomic File Operations (KB-05)
// ============================================================================

export async function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, filePath);
}

// ============================================================================
// Project / Workspace namespacing (§2.1)
// ============================================================================

// Project ids are confined to a strict charset so they cannot introduce path
// traversal into `<project>.json` or `<project>/<id>.yml` filenames.
const PROJECT_ID_RE = /^[A-Za-z0-9_-]+$/;
const TASK_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isValidProjectId(id) {
  return typeof id === 'string' && PROJECT_ID_RE.test(id);
}

export function isValidTaskId(id) {
  return typeof id === 'string' && TASK_ID_RE.test(id);
}

/**
 * Canonical normaliser for `task.branch` — the ONE definition of the rule,
 * shared by all three write paths (GitYamlStorage.serializeCard, createTask and
 * the patchTask allow-list). Before this existed the two create/serialize sites
 * coerced blanks to `null` while the PATCH path assigned verbatim, so the same
 * task could report `"   "` / `123` over REST and persist it, yet read back as
 * `null` from the git YAML card.
 *
 * A branch is a *claim about a real git ref* that the reclaim notifier renders
 * to a human, so an unusable value must round-trip as `null` rather than being
 * invented (`task/<id>`) or served back raw. The rule:
 *
 *   - a string with non-whitespace content is kept **verbatim, untrimmed**: a
 *     ref is the caller's exact claim, so `'  fix/padded  '` stays byte-for-byte
 *     as sent. Decided deliberately — trimming here would silently rewrite real
 *     caller data, and all three paths already agreed on preserving padding;
 *     collapsing the *blank* cases to `null` is the essential invariant.
 *   - everything else — absent, `null`, `''`, whitespace-only, and non-strings
 *     (`123` also violates the client's declared `branch?: string`) — is
 *     `null`.
 */
export function toBranch(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * The implicit project that single-project deployments live in. Its storage
 * reuses the legacy location (KANBAN_DATA_FILE / flat git root) so a single
 * project deployment is byte-for-byte unchanged.
 */
export function defaultProjectName() {
  const p = process.env.KANBAN_DEFAULT_PROJECT;
  return isValidProjectId(p) ? p : 'default';
}

/**
 * Coerces an input to a canonical project name. Invalid / empty input falls
 * back to the default project so lookups are total.
 */
export function normalizeProject(project, fallback) {
  const fb = fallback || defaultProjectName();
  if (project === undefined || project === null || project === '') return fb;
  if (isValidProjectId(project)) return project;
  return fb;
}

/**
 * Resolves the {project, shortId} pair for a lookup. Accepts three forms:
 *   getTask('foo')            -> default/foo
 *   getTask('foo', 'atlas')   -> atlas/foo
 *   getTask('atlas:foo')      -> atlas/foo  (composite, project wins on first ':')
 */
export function resolveProjectScope(id, projectArg) {
  let project = projectArg;
  let shortId = id;
  if (typeof id === 'string' && id.includes(':')) {
    const idx = id.indexOf(':');
    const maybeProject = id.slice(0, idx);
    const rest = id.slice(idx + 1);
    if (isValidProjectId(maybeProject) && rest.length > 0) {
      project = maybeProject;
      shortId = rest;
    }
  }
  project = normalizeProject(project);
  return { project, shortId };
}

// ---------------------------------------------------------------------------
// Storage roots (per-project, cached) — IMPL-02 (v2.7.0) in-repo default
// ---------------------------------------------------------------------------
//
// The previous fallback pointed at a stale cross-project path
// (`../../agent-based-investment/ops/kanban`) which does not exist in a
// standalone clone. The new default is `server/data`. A one-time warning is
// logged when the fallback is actually used, nudging operators to set
// KANBAN_DATA_DIR/KANBAN_GIT_DIR explicitly in production.
import { fileURLToPath } from 'node:url';

const identityDir = path.dirname(fileURLToPath(import.meta.url));
let gitRootFallbackWarned = false;
let jsonDataDirFallbackWarned = false;

export function gitRoot() {
  const env = process.env.KANBAN_GIT_DIR || process.env.KANBAN_DATA_DIR;
  if (env) return env;
  const fallback = path.resolve(identityDir, 'data');
  if (!gitRootFallbackWarned) {
    gitRootFallbackWarned = true;
    console.warn(`[kanban storage] KANBAN_DATA_DIR/KANBAN_GIT_DIR are unset; defaulting data storage to ${fallback}. Set one explicitly in production.`);
  }
  return fallback;
}

export function jsonDataDir() {
  const env = process.env.KANBAN_DATA_DIR || process.env.KANBAN_GIT_DIR;
  if (env) return env;
  const fallback = path.resolve(identityDir, 'data');
  if (!jsonDataDirFallbackWarned) {
    jsonDataDirFallbackWarned = true;
    console.warn(`[kanban storage] KANBAN_DATA_DIR/KANBAN_GIT_DIR are unset; defaulting data storage to ${fallback}. Set one explicitly in production.`);
  }
  return fallback;
}

/**
 * Backfills the lease fields (§2.4) + CAS version (§2.6) on records loaded from
 * a JSON sink that predates them: `claim_expires_at` -> null, `reclaim_count` ->
 * 0, `version` -> 1. Additive so legacy data is total without a migration step.
 *
 * `branch` is normalised through the shared `toBranch` normaliser so legacy
 * dirty values (whitespace-only strings, empty strings, non-strings like 123,
 * stale `task/<id>` fabrications) are nulled on READ exactly as the write paths
 * (serializeCard / createTask / patchTask) normalise them on WRITE. Without
 * this a legacy dirty branch persisted by an older build re-emerges verbatim in
 * every API response and on git-backend cards (they re-serialise from memory on
 * each save), so read and write would disagree forever.
 */
export function backfillLeaseFields(list) {
  for (const t of list) {
    if (!Number.isInteger(t.version)) t.version = 1;
    if (t.claim_expires_at === undefined) t.claim_expires_at = null;
    if (t.reclaim_count === undefined) t.reclaim_count = 0;
    if (t.branch !== undefined) t.branch = toBranch(t.branch);
    // v2.5.0: every card carries a comments thread; legacy records default to
    // an empty one so the read surface (and the client renderer) is total.
    if (!Array.isArray(t.comments)) t.comments = [];
  }
  return list;
}
