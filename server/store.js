// C1 (v3.12.5): the engine was split into ./store/{core,listeners,aggregates,
// leases,archive,trash,backups}.js and this file is the facade over them. The
// remaining node:fs/(promises) and node:path imports stay here: the inline-log
// spill helpers (spillDir/spillFile/appendSpill/readSpill) still live in this
// module, not in store/core.js or store/backups.js.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { escapeHtml } from './utils/sanitize.js';
import {
  STATUSES,
  VALID_STATUS_LIST,
  ACTIVE_STATUSES,
  ACTIVE_STATUS_SET,
  normalizeStatus,
  isValidStatus,
  VALID_TRANSITIONS,
  canTransition,
  canRoleTransition,
} from './state-machine.js';
import {
  writeAtomic,
  isValidProjectId,
  isValidTaskId,
  toBranch,
  toMilestone,
  defaultProjectName,
  normalizeProject,
  resolveProjectScope,
  gitRoot,
  jsonDataDir,
  backfillLeaseFields,
} from './task-identity.js';
import { JsonStorage, GitYamlStorage } from './storage.js';

// ENH-11 (v2.10.0): the loop state machine (statuses + transition graph + role
// matrix) lives in ./state-machine.js. Re-exported here so every existing
// `../store.js` importer keeps working unchanged.
export {
  STATUSES,
  VALID_STATUS_LIST,
  ACTIVE_STATUSES,
  ACTIVE_STATUS_SET,
  normalizeStatus,
  isValidStatus,
  VALID_TRANSITIONS,
  canTransition,
  canRoleTransition,
};

// ENH-11 (v2.10.0): task identity + project namespacing + writeAtomic live in
// ./task-identity.js. Re-exported here so existing importers are unaffected.
export {
  writeAtomic,
  isValidProjectId,
  isValidTaskId,
  toBranch,
  toMilestone,
  defaultProjectName,
  normalizeProject,
  resolveProjectScope,
  gitRoot,
  jsonDataDir,
};

// ENH-11 (v2.10.0): the pluggable storage backends live in ./storage.js.
export { JsonStorage, GitYamlStorage };


// ---------------------------------------------------------------------------
// C1 (v3.12.5): store.js is the FACADE over ./store/*.
//
// State (live tasks, composite index, archive, trash, settings, mutation queue,
// aggregate-invalidation flag, mutation serial) has exactly one home in
// ./store/core.js. The extracted subsystems — listeners, aggregates, leases,
// archive, trash, backups — import that module directly instead of importing
// store.js, so there is no cycle. Everything they expose is re-exported below
// with its original identity, so the routes and the 54 test files that import
// from '../store.js' are unaffected (kanban.modulesplit.test.js pins the
// identities, including store.writeAtomic === task-identity.writeAtomic).
//
// What deliberately STAYS here: the create/patch/claim state-machine walk and
// the dependency gate. They share the legal-transition + role rules with each
// other, and moving them would have meant re-exporting half the mutation path
// back into the module that owns it — more coupling, not less.
// ---------------------------------------------------------------------------
import {
  tasks,
  archive,
  trash,
  storeLoaded,
  index,
  projectSettings,
  withMutationLock,
  getStorage,
  setStorage,
  listJsonProjects,
  listGitProjects,
  rebuildIndex,
  updateInMemoryTask,
  setTaskInMemory,
  removeFromMemory,
  getProjectBucket,
  projectBucket,
  projectBucketFor,
  compositeKey,
  resetArchive,
  resetTrash,
  spillDir,
  spillFile,
  parkedSpillFile,
  moveSpillFile,
  removeSpillFile,
  resetProjectSettings,
  markStoreLoaded,
  getTasks,
  getTask,
  getTaskCount,
  getArchivedTasks,
  nextVersionFor,
  versionConflict,
} from './store/core.js';
import {
  onDiff,
  onAudit,
  emitAudit,
  notify,
  listenerCounts,
  onChange,
  onSettings,
  settingsListenerCount,
  emitSettings,
} from './store/listeners.js';
import {
  getProjectSummaries,
  getMetrics,
  resetClaimContention,
  recordClaimContention,
} from './store/aggregates.js';
import {
  nowFn,
  setNowFn,
  isoFromMs,
  getMinLeaseMs,
  getMaxLeaseMs,
  getProgressStallMs,
  leaseWindowFor,
  resolveLeaseMs,
  getMaxClaimsPerAgent,
  countActiveClaims,
  holderWriteRenewsAll,
  isReaperEnabled,
  isAutoPromoteEnabled,
  reclaimTask,
  reapExpiredClaims,
  startReaper,
  stopReaper,
  isReaperRunning,
} from './store/leases.js';
import { runArchiveSweep } from './store/archive.js';
import {
  getTrashedTasks,
  restoreFromTrash,
  hardDeleteFromTrash,
  runTrashSweep,
} from './store/trash.js';
import {
  startBackup,
  stopBackup,
  isBackupRunning,
  runBackupNow,
  backupStatus,
} from './store/backups.js';
import { createLogger } from './logger.js';

// One structured logger for the facade's own diagnostics (load warnings, hook
// failures, spill errors). Extracted modules own their own scoped logger.
const log = createLogger(null);

// Every symbol below was exported by the pre-split store.js; keep the surface
// byte-for-byte. Re-export (not re-wrap) preserves function identity.
export {
  withMutationLock,
  getStorage,
  setStorage,
  listGitProjects,
  setTaskInMemory,
  getProjectBucket,
  getTasks,
  getTask,
  getTaskCount,
  getArchivedTasks,
  nextVersionFor,
} from './store/core.js';
export {
  onDiff,
  onAudit,
  emitAudit,
  notify,
  listenerCounts,
  onChange,
  onSettings,
  settingsListenerCount,
  emitSettings,
} from './store/listeners.js';
export {
  getProjectSummaries,
  getMetrics,
  resetClaimContention,
} from './store/aggregates.js';
export {
  setNowFn,
  getMinLeaseMs,
  getMaxLeaseMs,
  getProgressStallMs,
  leaseWindowFor,
  isReaperEnabled,
  reclaimTask,
  reapExpiredClaims,
  startReaper,
  stopReaper,
  isReaperRunning,
} from './store/leases.js';
export { runArchiveSweep } from './store/archive.js';
export {
  getTrashedTasks,
  restoreFromTrash,
  hardDeleteFromTrash,
  runTrashSweep,
} from './store/trash.js';
export {
  startBackup,
  stopBackup,
  isBackupRunning,
  runBackupNow,
  backupStatus,
} from './store/backups.js';

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export async function loadStore() {
  const backend = process.env.KANBAN_STORAGE_BACKEND || 'json';
  const dp = defaultProjectName();
  const loaded = [];
  const projectSet = new Set([dp]);

  if (backend === 'git') {
    const root = gitRoot();
    const defaultLive = await getStorage(dp).load();
    loaded.push(...defaultLive);
    for (const p of await listGitProjects(root)) {
      if (p === dp) continue;
      projectSet.add(p);
      const live = await getStorage(p).load();
      loaded.push(...live);
    }
  } else {
    const defaultLive = await getStorage(dp).load();
    loaded.push(...defaultLive);
    for (const p of await listJsonProjects()) {
      if (p === dp) continue;
      projectSet.add(p);
      const live = await getStorage(p).load();
      loaded.push(...live);
    }
  }

  // Legacy backfill: every record gains a canonical project + age anchors so the
  // index and archive ageing are total on legacy data.
  const nowIso = new Date().toISOString();
  function migrateRecord(t) {
    if (!t || typeof t !== 'object') return;
    t.project = t.project && isValidProjectId(t.project) ? t.project : dp;
    if (!t.created_at) t.created_at = t.updated || nowIso;
    // Migrate legacy status names (BUILDING -> IN_PROGRESS, IN_TEST -> VALIDATION)
    if (t.status) {
      const norm = normalizeStatus(t.status);
      if (norm) t.status = norm;
    }
    // Migrate stage_owners keys
    if (t.stage_owners && typeof t.stage_owners === 'object') {
      const migratedOwners = {};
      for (const [k, v] of Object.entries(t.stage_owners)) {
        const normKey = normalizeStatus(k) || k;
        migratedOwners[normKey] = v;
      }
      t.stage_owners = migratedOwners;
    }
    if (t.status === STATUSES.DONE && !t.completed_at) {
      t.completed_at = t.updated || t.created_at || nowIso;
    }
    // §2.6: legacy records that predate versioning start at version 1 so the
    // CAS guard is total and a first patch bumps to 2.
    if (!Number.isInteger(t.version)) t.version = 1;
    // §2.4: backfill lease fields so the reaper math is total on legacy data.
    if (t.claim_expires_at === undefined) t.claim_expires_at = null;
    if (t.reclaim_count === undefined) t.reclaim_count = 0;
  }

  for (const t of loaded) {
    migrateRecord(t);
  }

  rebuildIndex(loaded);

  // Load per-project archives.
  resetArchive();
  for (const p of projectSet) {
    try {
      const a = await getStorage(p).loadArchive();
      if (a && a.length) {
        for (const item of a) migrateRecord(item);
        archive[p] = a;
      }
    } catch (err) {
      log.warn('archive load error', { project: p, error: err.message });
    }
  }

  // v2.5.0: load per-project display settings (column colors) alongside the
  // archives. A project with no saved settings simply has no override entry.
  resetProjectSettings();
  for (const p of projectSet) {
    try {
      const s = await getStorage(p).loadSettings();
      if (s && typeof s === 'object' && Object.keys(s).length) projectSettings.set(p, s);
    } catch (err) {
      log.warn('settings load error', { project: p, error: err.message });
    }
  }

  // v2.5.6: load the trash sink alongside archives so a restart never loses
  // soft-deleted rows (the whole point of the sink).
  resetTrash();
  for (const p of projectSet) {
    try {
      const tl = await getStorage(p).loadTrash();
      if (tl && tl.length) {
        for (const item of tl) migrateRecord(item);
        trash[p] = tl;
      }
    } catch (err) {
      log.warn('trash load error', { project: p, error: err.message });
    }
  }

  // Boot sweep is always forced — the process-level mutation serial must never
  // skip the one sweep that reconciles on-disk age with the live index.
  await runArchiveSweep();
  markStoreLoaded();
  notify();
}

/**
 * Read-only liveness signal: true once `loadStore()` has completed. The health
 * endpoint derives `store_loaded` from this without mutating anything.
 */
export function isStoreLoaded() {
  return storeLoaded;
}
// ---------------------------------------------------------------------------
// v2.5.0 — Per-project display settings (column colors)
// ---------------------------------------------------------------------------
//
// A board-wide default (the `default` project's saved settings) plus optional
// per-project overrides. The palette is the client's existing accent token set
// (muted/live/warn/test/fail/pass/block/line) — raw hex never crosses the wire,
// so every choice keeps the validated WCAG contrast of the design system.

export const COLUMN_COLOR_KEYS = [...VALID_STATUS_LIST, 'UNKNOWN', 'ISSUES', 'BUILDING', 'IN_TEST'];

export const COLUMN_COLOR_TOKENS = [
  'muted',
  'live',
  'warn',
  'test',
  'fail',
  'pass',
  'block',
  'line',
];

// The stock palette as shipped (mirrors Column.tsx COLUMN_ACCENTS).
export const STOCK_COLUMN_COLORS = Object.freeze({
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
  // Backward compatibility aliases
  BUILDING: 'live',
  IN_TEST: 'test',
});

/**
 * Resolved column colors for a project: stock -> board default (the `default`
 * project's saved map) -> the project's own override. Unscoped resolution
 * (project === undefined/null/'') applies the board default only.
 */
export function getSettings(project) {
  const boardDefault = projectSettings.get(defaultProjectName())?.column_colors || {};
  const own = project && project !== defaultProjectName()
    ? projectSettings.get(project)?.column_colors || {}
    : {};
  return {
    project: project || null,
    column_colors: { ...STOCK_COLUMN_COLORS, ...boardDefault, ...own },
  };
}

/**
 * Validates a column_colors payload: every key must be a known column, every
 * value a palette token. Returns { error, status } or { colors }.
 */
function validateColumnColors(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'column_colors must be an object mapping column -> color token', status: 400 };
  }
  const keys = Object.keys(raw);
  if (keys.length > COLUMN_COLOR_KEYS.length) {
    return { error: 'column_colors has too many keys', status: 400 };
  }
  const colors = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!COLUMN_COLOR_KEYS.includes(k)) {
      return { error: `Unknown column: ${k}`, status: 400 };
    }
    if (!COLUMN_COLOR_TOKENS.includes(v)) {
      return { error: `Invalid color token for ${k}: ${v}`, status: 400 };
    }
    colors[k] = v;
  }
  return { colors };
}

/**
 * Persists a project's column_colors override (v2.5.0). Any authenticated
 * token may update display settings. KB-05: persist first, then memory, then
 * notify settings listeners. Under `withMutationLock` so concurrent saves
 * serialize.
 */
export async function updateSettings(project, patch, { caller = {} } = {}) {
  return withMutationLock(async () => {
    let p;
    if (project === undefined || project === null || project === '') {
      p = defaultProjectName();
    } else {
      p = project;
      if (!isValidProjectId(p)) {
        return { error: `Invalid project id: ${p}`, status: 400 };
      }
    }

    if (!caller || typeof caller !== 'object' || !caller.role) {
      return { error: 'Caller role is required to update settings', status: 403 };
    }

    const raw = patch?.column_colors;
    const check = validateColumnColors(raw);
    if (check.error) return check;

    await getStorage(p).saveSettings({ column_colors: check.colors });

    const prev = projectSettings.get(p) || {};
    const next = { ...prev, column_colors: check.colors };
    projectSettings.set(p, next);
    emitSettings(p, getSettings(p));
    return { project: p, column_colors: check.colors, status: 200 };
  });
}


// ---------------------------------------------------------------------------
// Creations & mutations (project-scoped)
// ---------------------------------------------------------------------------

/**
 * Creates a task (spec Sec 9.4.3 + §2.1 namespacing).
 * Uniqueness is composite (project/id); storage write is partition-scoped.
 */
export async function createTask(data = {}, projectArg, { caller = {} } = {}) {
  return withMutationLock(async () => {
    if (!data.id || !data.title) {
      return { error: 'id and title are required', status: 400 };
    }
    // BUG-02 (v2.5.4): field-type validation. A non-string title used to
    // escapeHtml into an empty string, and a non-string priority passed
    // through verbatim — which later crashed the client's filterTasks
    // (toLowerCase on a non-string) and blanked the whole board above the
    // ErrorBoundary. Reject wrong shapes at the door instead.
    if (typeof data.title !== 'string' || data.title.trim() === '') {
      return { error: 'title must be a non-empty string', status: 400 };
    }
    if (data.description !== undefined && data.description !== null && typeof data.description !== 'string') {
      return { error: 'description must be a string', status: 400 };
    }
    const priorityError = validatePriority(data.priority);
    if (priorityError) {
      return { error: priorityError, status: 400 };
    }
    // BUG-05 (v2.5.8): bound the prose fields. Live data tops out near a
    // 100-char title and a 2.5k description; these caps leave generous
    // headroom while refusing a 90k-char title that would bloat every
    // partition rewrite and every SSE snapshot.
    if (data.title.length > MAX_TITLE_LEN) {
      return { error: `title must be at most ${MAX_TITLE_LEN} characters`, status: 400 };
    }
    if (typeof data.description === 'string' && data.description.length > MAX_DESCRIPTION_LEN) {
      return { error: `description must be at most ${MAX_DESCRIPTION_LEN} characters`, status: 400 };
    }
    const dependsOnError = validateDependsOn(data.depends_on);
    if (dependsOnError) {
      return { error: dependsOnError, status: 400 };
    }
    const metadataError = validateMetadata(data.metadata);
    if (metadataError) {
      return { error: metadataError, status: 400 };
    }

    // Project resolution: body.project > body.workspace_id (alias) > query/header arg.
    const rawProject = data.project ?? data.workspace_id ?? projectArg;
    let project;
    if (rawProject === undefined || rawProject === null || rawProject === '') {
      project = defaultProjectName();
    } else {
      project = rawProject;
      if (!isValidProjectId(project)) {
        return {
          error: `Invalid project id: ${project}`,
          status: 400,
        };
      }
    }

    if (!isValidTaskId(data.id)) {
      return {
        error: 'Invalid task id: must contain only alphanumeric characters, underscores, and hyphens',
        status: 400,
      };
    }

    // Composite uniqueness: two projects may share a short id.
    if (index.has(compositeKey(project, data.id))) {
      return { error: `Task ${compositeKey(project, data.id)} already exists`, status: 409 };
    }

    // BUG-08 (v2.7.0): reject self-references and dependency cycles. Placed
    // after the validateDependsOn shape check and after project/id resolution.
    // SEC-08: dependencies are resolved within the card's own project only.
    const scopeError = validateDependsOnScope(project, data.depends_on);
    if (scopeError) {
      return { error: scopeError, status: 400 };
    }
    const cycleError = validateDependencyGraph(project, data.id, data.depends_on);
    if (cycleError) {
      return { error: cycleError, status: 400 };
    }

    const status = normalizeStatus(data.status);
    if (!status) {
      return { error: `Invalid status: ${data.status}`, status: 400 };
    }
    // BUG-03 (v2.5.8): creating a task DIRECTLY in a work state (BUILDING /
    // IN_REVIEW / IN_TEST / DONE) skips the claim contract entirely — no owner,
    // no lease, no role gate, no dependency gate. Any token holder could mint a
    // DONE card (fabricated completed work) or a floating IN_TEST card. Require
    // a privileged credential for those; BACKLOG and BLOCKED stay open because
    // they are parking states (BLOCKED is an ordinary backlog fixture in tests
    // and a legitimate bulk-import state).
    if (IMPORT_GATED_STATUSES.has(status) && !destructivePrivilege(caller)) {
      return {
        error: `Forbidden: creating a task in ${status} requires a privileged role`,
        status: 403,
      };
    }
    const roundError = validateRound(data.round);
    if (roundError) {
      return { error: roundError, status: 400 };
    }
    // COR-09: issues/branch/milestone share the PATCH bounds. A non-array
    // `issues` keeps its historical coercion to [] on create; an array must be
    // short strings (escaped like addIssue).
    if (Array.isArray(data.issues)) {
      const issuesError = validateIssues(data.issues);
      if (issuesError) return { error: issuesError, status: 400 };
    }
    const branchError = validateLabelLength('branch', data.branch, MAX_BRANCH_LEN);
    if (branchError) return { error: branchError, status: 400 };
    const milestoneError = validateLabelLength('milestone', data.milestone, MAX_MILESTONE_LEN);
    if (milestoneError) return { error: milestoneError, status: 400 };

    const now = new Date().toISOString();
    const newTask = {
      id: data.id,
      project,
      title: escapeHtml(data.title),
      description: escapeHtml(data.description || ''),
      status,
      priority: typeof data.priority === 'string' && data.priority !== ''
        ? data.priority.toLowerCase()
        : 'medium',
      // Same rule as serializeCard — the shared `toBranch` normaliser. This
      // site is the one that leaked a *stale sibling's* value on the
      // orchestrator path, so it must read data.branch only — never a
      // neighbouring task's branch.
      branch: toBranch(data.branch),
      // v2.11.0 (opt-milestones): nullable grouping label; same shared shape
      // rule as `branch`. Absent on legacy cards (backfilled to null on read).
      milestone: toMilestone(data.milestone),
      depends_on: Array.isArray(data.depends_on) ? data.depends_on : [],
      round: data.round,
      issues: Array.isArray(data.issues) ? data.issues.map((i) => escapeHtml(i)) : [],
      // BUG-04 (v2.5.8): an owner is only ever written by a claim. A
      // caller-supplied `assigned_agent` at create time used to stick to a
      // BACKLOG card with NO lease, which made it unclaimable forever (the
      // contention check rejects every other agent with 409) while looking
      // assigned. Ignore it; ownership comes from POST /claim.
      assigned_agent: null,
      // SEC-04 (v2.5.8): `stage_owners`, `agent_logs` and `comments` are audit
      // provenance. Accepting them from the request body let a caller forge a
      // review history for work nobody did. Start them empty; real transitions
      // and real endpoints are the only writers.
      stage_owners: {},
      agent_logs: [],
      comments: [],
      metadata: data.metadata || {},
      created_at: now,
      completed_at: status === STATUSES.DONE ? now : undefined,
      updated: now,
      // §2.6: every task starts at version 1; committed mutations bump it.
      version: 1,
     };
    // workspace_id is an input alias only and must never be persisted.
    delete newTask.workspace_id;
     // Omit undefined fields from the persisted/returned record.
    if (newTask.completed_at === undefined) delete newTask.completed_at;

    // KB-05: mutate in memory only after the partition write lands.
    await getStorage(project).saveTask(newTask, projectBucket(project, newTask));
    updateInMemoryTask(newTask);
    // COR-12: a brand-new card owns no spilled history. Retire a sidecar a
    // pre-v3.12.11 delete may have left behind under this id.
    await removeSpillFile(spillFile(project, newTask.id));
    notify();
    return { task: newTask, status: 201 };
  });
}

/**
 * Patches a task with state machine (KB-01) and role ownership (KB-02) checks.
 * `project` scopes the lookup; the task's own project is used when unspecified.
 * `project` itself is not mutable (400).
 */
export async function patchTask(id, patch, { caller = {}, project: projectArg } = {}) {
  return withMutationLock(async () => {
    const task = getTask(id, projectArg);
    if (!task) return { error: 'Task not found', status: 404 };

    if (patch && typeof patch === 'object' && 'project' in patch) {
      return { error: 'project is not mutable', status: 400 };
      }

      // v3.8.0 Phase 2: `role` is conferred by the credential (or a server-issued
      // session), never by request bodies. Accepting a body role here was the
      // side door that let one agent self-approve through every state.
      if (patch && typeof patch === 'object' && 'role' in patch) {
        return { error: 'role is not mutable — it is bound to the agent credential', status: 400 };
      }

      // §2.6: enforce the expected-version guard BEFORE building the candidate
      // so a stale read rejects without touching storage. The route injects the
      // If-Match header as `patch.expected_version`; a body-supplied field is
      // equivalent. A "Version mismatch" 409 is distinct from a claim-contention
      // 409 ("… already claimed by …").
    const conflict = versionConflict(task, patch.expected_version);
    if (conflict) return conflict;

    const candidate = structuredClone(task);
    // v3.8.0 Phase 2: caller.role only — the `|| patch.role` fallback is gone.
    // A body can no longer confer the role that gates KB-02 transitions.
    // SEC-04 (v3.12.11): a privileged role string only counts when the
    // credential itself is privileged (callerIsPrivileged: admin token,
    // privileged session, legacy single-token / direct callers with no
    // middleware flag). An unbound project credential that merely DECLARES
    // `X-Agent-Role: admin` is treated as roleless for the KB-02 matrix.
    const role = effectiveTransitionRole(caller);
       // §2.5: detect a *transition into DONE* so we can fire the completion hook
       // after this write commits. The pre-write status is the live task's status
       // (updateInMemoryTask has not run yet, so `task` still carries the old one).
    const wasStatus = task.status;
    if ('status' in patch) {
      const nextStatus = normalizeStatus(patch.status);
      if (!nextStatus) {
        return { error: `Invalid status: ${patch.status}`, status: 400 };
       }

      // KB-01: State machine transition check
      if (!canTransition(candidate.status, nextStatus)) {
        return {
          error: `Invalid state transition from ${candidate.status} to ${nextStatus}`,
          status: 409,
        };
      }

      // KB-02: Role ownership check
      if (!canRoleTransition(role, candidate.status, nextStatus)) {
        return {
          error: `Role '${role}' is not authorized to transition task from ${candidate.status} to ${nextStatus}`,
          status: 403,
        };
      }

      // §2.5: dependency gate on transitions INTO an active stage. The claim
      // path already refuses a dependent task whose blockers are not DONE
      // (`applyClaim`); a status-only PATCH must not become a side door around
      // that contract. Any entry into ACTIVE_STATUSES is gated
      // here, so PATCH and claim agree on what may go active. Transitions
      // within/through DONE, READY_TO_SHIP, BLOCKED, READY, and BACKLOG stay ungated: unblocking
      // (maybeUnlockDependentsInner) and backtracking are lock-internal or
      // non-claiming moves.
      if (ACTIVE_STATUS_SET.has(nextStatus)) {
        const gate = dependencyGate(candidate);
        if (!gate.ok) {
          return {
            error: 'Task has unsatisfied dependencies',
            status: 409,
            reason: 'dependency_unsatisfied',
            unresolved_dependencies: gate.unresolved,
          };
        }
      }
      candidate.status = nextStatus;

      // §2.x: record the acting agent for the newly-entered stage. Only on a
      // real change (nextStatus !== wasStatus) and only for the active
      // stages plus terminal DONE. `assigned_agent` stays the lease holder — this is a per-stage
      // provenance map, not a reassignment.
      const actor = caller?.agent_id || caller?.agentId || null;
      if (
        nextStatus !== wasStatus &&
        actor &&
        (ACTIVE_STATUS_SET.has(nextStatus) ||
          nextStatus === STATUSES.DONE)
      ) {
        const owners = candidate.stage_owners && typeof candidate.stage_owners === 'object'
          ? candidate.stage_owners
          : {};
        candidate.stage_owners = { ...owners, [nextStatus]: actor };
      }
     }

     // §2.8: anchor completion time on the transition into DONE. COR-07: a
     // REAL transition into DONE always restamps (a stale completed_at from an
     // earlier life of the card must not survive); a DONE -> DONE edit keeps it.
    if (candidate.status === STATUSES.DONE && (wasStatus !== STATUSES.DONE || !candidate.completed_at)) {
     candidate.completed_at = new Date().toISOString();
    }

    const allowed = [
      'title',
      'description',
      'priority',
      'branch',
      'milestone',
      'depends_on',
      'round',
      'issues',
      'metadata',
    ];

    for (const key of allowed) {
      if (key in patch) {
        // BUG-02 (v2.5.4): type-validate the prose fields on PATCH too. The old
        // behaviour silently skipped a non-string title/description (keeping a
        // stale value) and stored a non-string priority verbatim — the same
        // client-crash shape as createTask.
        if (key === 'title') {
          if (typeof patch[key] !== 'string' || patch[key].trim() === '') {
            return { error: 'title must be a non-empty string', status: 400 };
          }
          if (patch[key].length > MAX_TITLE_LEN) {
            return { error: `title must be at most ${MAX_TITLE_LEN} characters`, status: 400 };
          }
          candidate[key] = escapeHtml(patch[key]);
        } else if (key === 'description') {
          if (patch[key] !== null && typeof patch[key] !== 'string') {
            return { error: 'description must be a string', status: 400 };
          }
          if (typeof patch[key] === 'string' && patch[key].length > MAX_DESCRIPTION_LEN) {
            return { error: `description must be at most ${MAX_DESCRIPTION_LEN} characters`, status: 400 };
          }
          candidate[key] = typeof patch[key] === 'string' ? escapeHtml(patch[key]) : '';
        } else if (key === 'priority') {
          const priorityError = validatePriority(patch[key]);
          if (priorityError) return { error: priorityError, status: 400 };
          candidate[key] =
            typeof patch[key] === 'string' && patch[key] !== ''
              ? patch[key].toLowerCase()
              : 'medium';
        } else if (key === 'branch') {
          // The third write path: same shared rule as createTask/serializeCard,
          // so a blank, whitespace-only or non-string branch cannot be served
          // back by REST or persisted to either sink. `branch: null` stays null
          // (an explicit clear) and a real ref is set verbatim. escapeHtml is
          // deliberately NOT applied here — a branch is a ref, not prose, and
          // has never been HTML-escaped on any path.
          const branchError = validateLabelLength('branch', patch[key], MAX_BRANCH_LEN);
          if (branchError) return { error: branchError, status: 400 };
          candidate[key] = toBranch(patch[key]);
        } else if (key === 'milestone') {
          // v2.11.0 (opt-milestones): same shared rule as branch — a non-empty
          // string is kept verbatim, `milestone: null` clears it, and anything
          // else (number/object/blank) becomes null rather than a bogus label.
          const milestoneError = validateLabelLength('milestone', patch[key], MAX_MILESTONE_LEN);
          if (milestoneError) return { error: milestoneError, status: 400 };
          candidate[key] = toMilestone(patch[key]);
        } else if (key === 'depends_on') {
          // BUG-05 (v2.5.8): same shape rule as createTask — a bare string is
          // rejected rather than silently dropped.
          const dependsOnError = validateDependsOn(patch[key]);
          if (dependsOnError) return { error: dependsOnError, status: 400 };
          // SEC-08: a dependency must live in the card's own project.
          const scopeError = validateDependsOnScope(candidate.project, patch[key]);
          if (scopeError) return { error: scopeError, status: 400 };
          // BUG-08 (v2.7.0): reject self-references and dependency cycles.
          const cycleError = validateDependencyGraph(candidate.project, candidate.id, patch[key]);
          if (cycleError) return { error: cycleError, status: 400 };
          candidate[key] = Array.isArray(patch[key]) ? patch[key] : [];
        } else if (key === 'metadata') {
          // BUG-05 (v2.5.8): metadata must be a bounded plain object, not a
          // string/array silently swallowed into `{}`.
          const metadataError = validateMetadata(patch[key]);
          if (metadataError) return { error: metadataError, status: 400 };
          candidate[key] = patch[key] === undefined || patch[key] === null ? {} : patch[key];
        } else if (key === 'round') {
          // COR-09: the createTask rule. A non-integer round used to be stored
          // verbatim (and broke every later git-backend save of the card).
          const roundError = validateRound(patch[key]);
          if (roundError) return { error: roundError, status: 400 };
          candidate[key] = patch[key];
        } else if (key === 'issues') {
          // COR-09: a bounded array of short strings, escaped like addIssue.
          // `issues: null` clears the list.
          const issuesError = validateIssues(patch[key]);
          if (issuesError) return { error: issuesError, status: 400 };
          candidate[key] = Array.isArray(patch[key]) ? patch[key].map((i) => escapeHtml(i)) : [];
        }
      }
    }

    candidate.updated = new Date().toISOString();
      // §2.6: a committed patch advances version by exactly one.
    candidate.version = nextVersionFor(task);
      // expected_version is a request-time guard only; never persist it.
    delete candidate.expected_version;
    // E-1: a PATCH always changes this specific card's content — record it as
    // progress, distinct from the lease-window renewal below (which only
    // proves the agent is alive, not that THIS card moved forward).
    candidate.last_progress_at = candidate.updated;

    // §2.4: ANY committed write by the lease HOLDER is proof of life, so extend
    // the lease — not only POST /logs. A holder that PATCHes a status transition
    // (e.g. builder -> IN_REVIEW) previously kept the original claim clock, so a
    // long review could start with a nearly-expired lease. Same holder-only rule
    // as appendLog: any agent may patch fields on a task, so a non-holder must
    // never inherit or extend someone else's claim.
    if (
      candidate.assigned_agent &&
      candidate.assigned_agent === caller.agent_id &&
      candidate.claim_expires_at
    ) {
      candidate.claim_expires_at = isoFromMs(nowFn() + leaseWindowFor(candidate));
    }

    // COR-13: BLOCKED keeps owner + lease and is never swept, so the old lease
    // has usually lapsed by the time it is unblocked. Leaving BLOCKED for an
    // active stage re-arms the lease for the existing owner; an absent owner
    // simply lets the fresh lease lapse one window later.
    if (
      wasStatus === STATUSES.BLOCKED &&
      ACTIVE_STATUS_SET.has(candidate.status) &&
      candidate.assigned_agent
    ) {
      candidate.claim_expires_at = isoFromMs(nowFn() + leaseWindowFor(candidate));
    }

    const storage = getStorage(candidate.project);
    await storage.saveTask(candidate, projectBucket(candidate.project, candidate));
    updateInMemoryTask(candidate);
    // §2.4b Fix 3: a HOLDER that PATCHes any one card renews all its OTHER
    // active leases. Gate on the *caller* being the card's holder (a
    // non-holder's write must never extend the real holder's leases), and
    // exclude the card just written above (already renewed).
    //
    // v2.12.1 fixups (I-2/I-5/I-7): scoped to the SAME project as this write
    // (a per-project credential must never renew a lease in a project it
    // cannot write), tagged as a distinct 'renewed' event, and folded into the
    // SAME notify() call below rather than a separate no-op broadcast — so
    // siblings' new expiries reach clients in this tick instead of only on
    // some later, unrelated mutation.
    const semantic = new Map();
    if (
      holderWriteRenewsAll() &&
      caller.agent_id &&
      caller.agent_id === candidate.assigned_agent
    ) {
      const siblingKeys = await renewAllLeasesInner(caller.agent_id, nowFn(), {
        excludeKey: compositeKey(candidate.project, candidate.id),
        project: candidate.project,
      });
      for (const key of siblingKeys) {
        semantic.set(key, { kind: 'renewed', actor: caller.agent_id, reason: 'lease_renewed_holder_write' });
      }
    }
    notify(semantic.size > 0 ? { semantic } : undefined);

    // §2.5 optional event-driven auto-promote: on a *transition into DONE*,
    // unlock any BLOCKED dependents whose last remaining dependency just
    // completed. Runs inside the same lock (so it is serialized with the other
    // writers), AFTER the main write has fully committed, and is best-effort —
    // an unlock/persistence failure is swallowed here so it can never reject or
    // roll back the completed write (the main write above is authoritative).
    // Toggleable via KANBAN_AUTO_PROMOTE. This is a documented system override
    // (like the reaper): BLOCKED -> BACKLOG is legal in canTransition but the
    // external patchTask allowlist cannot clear ownership/lease, hence the
    // dedicated unlockTask inner.
    const enteredDone = candidate.status === STATUSES.DONE && wasStatus !== STATUSES.DONE;
    if (enteredDone && isAutoPromoteEnabled()) {
      try {
        await maybeUnlockDependentsInner(candidate.id, Date.now(), candidate.project);
       } catch (err) {
        log.error('auto-promote unlock failed', { error: err && err.message });
      }
    }
    if (enteredDone) runCompletionHooks(candidate.id);

    return { task: candidate, status: 200 };
     });
}

// ---------------------------------------------------------------------------
// §2.4/§2.5/§2.7 — claim lease, dependency gate, fair queue
// ---------------------------------------------------------------------------

// Roles that may renew *any* task's lease (they administer the board), beyond
// the holder. builder/reviewer/tester are holders when they own the task.
// ENH-11 (v2.10.0): pure field validation + priority ranking live in
// ./task-fields.js. Re-exported so existing importers are unaffected.
import {
  PRIVILEGED_ROLE_SET,
  isPrivilegedRole,
  callerIsPrivileged,
  destructivePrivilege,
  adminCredentialPrivilege,
  destructiveForbidden,
  validatePriority,
  MAX_TITLE_LEN,
  MAX_DESCRIPTION_LEN,
  MAX_METADATA_BYTES,
  validateDependsOn,
  validateMetadata,
  priorityRank,
  MAX_MESSAGE_LEN,
  MAX_BRANCH_LEN,
  MAX_MILESTONE_LEN,
  MAX_ISSUES,
  MAX_ISSUE_LEN,
  validateRound,
  validateIssues,
  validateLabelLength,
} from './task-fields.js';
export {
  PRIVILEGED_ROLE_SET,
  isPrivilegedRole,
  callerIsPrivileged,
  validatePriority,
  MAX_TITLE_LEN,
  MAX_DESCRIPTION_LEN,
  MAX_METADATA_BYTES,
  validateDependsOn,
  validateMetadata,
  priorityRank,
};

/**
 * BUG-03 (v2.5.8): statuses a client may NOT create directly without privilege.
 * These are work states whose only legitimate entry is a claim or a role-gated
 * transition. BACKLOG and READY are open backlog/planning-ready states, and BLOCKED
 * is a parking state, so they stay open to unprivileged creation.
 */
const IMPORT_GATED_STATUSES = new Set([
  STATUSES.PLANNING,
  STATUSES.IN_PROGRESS,
  STATUSES.IN_REVIEW,
  STATUSES.VALIDATION,
  STATUSES.READY_TO_SHIP,
  STATUSES.DONE,
]);

/**
 * §2.5 dependency gate. A dep is *satisfied* iff it resolves to a live task that
 * is DONE. A dangling dep id fails closed (treated as unresolved). Empty
 * `depends_on` ⇒ { ok: true }.
 */
export function dependencyGate(task) {
  const deps = Array.isArray(task.depends_on) ? task.depends_on : [];
  if (deps.length === 0) return { ok: true, unresolved: [] };
  const unresolved = [];
  for (const dep of deps) {
    // SEC-08: same-project lookup only. A `project:id` entry naming another
    // project (legacy data predating the write-time check) fails closed
    // instead of resolving across the project boundary.
    const key = dependencyKey(dep, task.project);
    const depTask = key ? index.get(key) : null;
    if (!depTask || depTask.status !== STATUSES.DONE) unresolved.push(dep);
  }
  return { ok: unresolved.length === 0, unresolved };
}

/**
 * SEC-08 / COR-08: the composite key a depends_on entry names within the
 * owning card's project, or null when the entry names a DIFFERENT project.
 * A bare id and `<own-project>:id` both resolve to `<own-project>/id`.
 */
function dependencyKey(dep, ownerProject) {
  const { project, shortId } = resolveProjectScope(dep, ownerProject);
  const owner = normalizeProject(ownerProject);
  if (project !== owner) return null;
  return compositeKey(owner, shortId);
}

/**
 * SEC-08: write-time check — every depends_on entry must address the card's
 * own project. Returns an error string or null.
 */
function validateDependsOnScope(project, dependsOn) {
  if (!Array.isArray(dependsOn)) return null;
  for (const dep of dependsOn) {
    if (typeof dep === 'string' && dependencyKey(dep, project) === null) {
      return `depends_on entry '${escapeHtml(dep)}' must reference a task in project '${project}'`;
    }
  }
  return null;
}

/**
 * SEC-04 (v3.12.11): the role used for privilege decisions. A privileged role
 * string (runner/system/human/admin) is honoured only when the credential is
 * privileged per callerIsPrivileged — the same rule delete/purge/assign use.
 * When the middleware stamped `privileged: false` (an unbound project
 * credential declaring a privileged header role) the role is dropped to null.
 * Functional roles (builder/reviewer/...) pass through unchanged.
 */
function effectiveTransitionRole(caller) {
  const role = caller?.role || null;
  if (isPrivilegedRole(role) && !callerIsPrivileged(caller || {})) return null;
  return role;
}

/**
 * BUG-08 (v2.7.0): bounded dependency-graph validator. Rejects a self-reference
 * and any depends_on set that would introduce a cycle, by transitively walking
 * each dep via `getTask(dep, project)`. A visited Set + depth cap (1000) keep a
 * pathological graph from hanging. Only EXISTING tasks are walked — a dangling
 * dep is not a cycle. Returns an error string or null.
 */
function validateDependencyGraph(project, id, dependsOn) {
  if (!Array.isArray(dependsOn) || dependsOn.length === 0) return null;
  if (dependsOn.includes(id)) {
    return 'depends_on cannot reference the task itself';
  }
  const DEPTH_CAP = 1000;
  for (const dep of dependsOn) {
    const visited = new Set();
    const stack = [dep];
    let depth = 0;
    while (stack.length && depth < DEPTH_CAP) {
      const current = stack.pop();
      if (current === id) {
        return 'depends_on would create a dependency cycle';
      }
      if (visited.has(current)) continue;
      visited.add(current);
      const t = getTask(current, project);
      if (!t) continue;
      const nextDeps = Array.isArray(t.depends_on) ? t.depends_on : [];
      for (const d of nextDeps) {
        if (d === id) {
          return 'depends_on would create a dependency cycle';
        }
        if (!visited.has(d)) stack.push(d);
      }
      depth += 1;
    }
  }
  return null;
}

/**
 * §2.4/§2.5/§2.7 shared claim core. Assumes the caller already holds the
 * mutation lock. Performs (in order):
 *   1. contention — a held task (assigned_agent !== agentId) is rejected with a
 *      plain 409 ("… already claimed by …"). This runs FIRST, so a held task
 *      returns the contention 409 even when its deps are also unsatisfied.
 *   2. dependency gate — a reason-tagged 409 (`reason: 'dependency_unsatisfied'`
 *      + `unresolved_dependencies[]`) distinct from contention.
 *   3. the write: set assigned_agent + claim_expires_at (now + TTL), lift
 *      READY → IN_PROGRESS (PLANNING for a planner), seed reclaim_count, push
 *      the claim log, persist.
 *
 * Pass `{ renew: true }` for a lease renewal: skip contention when the caller is
 * privileged (they may renew any lease), skip the dependency gate (the lease was
 * earned at a satisfied gate), do not move status, and push no log (no spam).
 */
async function applyClaim(task, agentId, caller, nowMs, { renew = false, leaseMs = null, leaseExplicit = false } = {}) {
  const role = caller?.role || null;
  // SEC-04 (v3.12.11): the claim-cap exemption and the privileged renewal
  // branch follow the CREDENTIAL (callerIsPrivileged), not the declared role.
  const isPriv = isPrivilegedRole(role) && callerIsPrivileged(caller || {});

  // E-2: a fresh claim is capped per agent (KANBAN_MAX_CLAIMS_PER_AGENT, 0 =
  // unlimited). This runs before contention so a caller at their cap gets a
  // clear `claim_limit` 409 rather than racing straight into the write.
  // Privileged callers are exempt (board administration, /assign, etc).
  if (!renew && !isPriv) {
    const cap = getMaxClaimsPerAgent();
    if (cap > 0 && countActiveClaims(agentId) >= cap) {
      return {
        error: `Agent ${agentId} already holds ${cap} active claim(s) (KANBAN_MAX_CLAIMS_PER_AGENT)`,
        status: 409,
        reason: 'claim_limit',
      };
    }
  }

  // (1) contention — first, so held tasks win the ordering over the dep gate.
  if (!(renew && isPriv)) {
    if (task.assigned_agent && task.assigned_agent !== agentId) {
      // Only a live lease means two agents genuinely raced. A lapsed-but-
      // unreaped assignment (or one that never had a lease) is a crashed agent,
      // not contention — and with the reaper disabled a polling agent retrying
      // against it would inflate the metric without bound.
      const holderExpiry = task.claim_expires_at ? Date.parse(task.claim_expires_at) : NaN;
      if (!Number.isNaN(holderExpiry) && holderExpiry > nowMs) {
        recordClaimContention(task.project);
      }
      return {
        error: `Task ${task.id} is already claimed by ${task.assigned_agent}`,
        status: 409,
      };
    }
  }

  // (2) dependency gate — only on a fresh claim.
  if (!renew) {
    const gate = dependencyGate(task);
    if (!gate.ok) {
      return {
        error: 'Task has unsatisfied dependencies',
        status: 409,
        reason: 'dependency_unsatisfied',
        unresolved_dependencies: gate.unresolved,
      };
    }
  }

  // (2.5) status gate — only READY (or already-held active task for renewal) may be claimed.
  if (!renew) {
    if (task.status === STATUSES.BACKLOG) {
      return {
        error: `Cannot claim task ${task.id}: task is in BACKLOG. Promote to READY first.`,
        status: 409,
        reason: 'not_ready',
      };
    }
    if (task.status !== STATUSES.READY && !ACTIVE_STATUS_SET.has(task.status)) {
      return {
        error: `Cannot claim task ${task.id}: status ${task.status} is not claimable`,
        status: 409,
        reason: 'status_not_claimable',
      };
    }
  }

  // (3) write the claim / renewal.
  const candidate = structuredClone(task);
  // A fresh claim assigns ownership; a renewal (renew=true) only extends the
  // lease and MUST NEVER reassign — a privileged heartbeat must not take the
  // task's owner from the real holder. So `assigned_agent` is set only on claim.
  if (!renew) candidate.assigned_agent = agentId;
  // Persist the window chosen at claim time. A fresh claim PINS the resolved
  // window ONLY when the caller made an explicit request (v2.12.1, C-1) — an
  // unpinned `null` keeps tracking the global TTL live, so a later
  // KANBAN_CLAIM_TTL_MS change still applies to a claim that never asked for a
  // specific window. A renewal keeps the stored window unless the caller
  // passes an explicit `leaseMs`. Legacy cards that predate the field load
  // `null` (see backfillLeaseFields) and fall back to the global TTL the same
  // way via leaseWindowFor.
  if (!renew) candidate.claim_lease_ms = leaseExplicit ? leaseMs : null;
  else if (leaseMs !== null) candidate.claim_lease_ms = leaseMs;
  candidate.claim_expires_at = isoFromMs(nowMs + leaseWindowFor(candidate));
  if (!Number.isInteger(candidate.reclaim_count)) candidate.reclaim_count = 0;
  if (!renew && candidate.status === STATUSES.READY) {
    const targetStatus = role === 'planner' ? STATUSES.PLANNING : STATUSES.IN_PROGRESS;
    candidate.status = targetStatus;
    // Record stage owner for the target status
    const owners = candidate.stage_owners && typeof candidate.stage_owners === 'object'
      ? candidate.stage_owners
      : {};
    candidate.stage_owners = { ...owners, [targetStatus]: agentId };
  }
  candidate.updated = isoFromMs(nowMs);
  if (!renew) {
    // E-1: a fresh claim is progress on THIS card specifically — distinct from
    // the lease-window renewal above, which only proves the AGENT is alive.
    // Never set by a sibling renewal (renewAllLeasesInner does not touch it).
    candidate.last_progress_at = candidate.updated;
  }
  // Deep-review (I-1): a lease-only renewal is not a content change and must not
  // bump the CAS `version`. renewAllLeasesInner already honors that; the targeted
  // heartbeat path did not, so every browser heartbeat invalidated anyone else's
  // expected_version PATCH on the held card.
  if (!renew) candidate.version = nextVersionFor(task);
  if (!Array.isArray(candidate.agent_logs)) candidate.agent_logs = [];
  if (!renew) {
    candidate.agent_logs.push({
      timestamp: candidate.updated,
      message: `${escapeHtml(agentId)} claimed this task.`,
      agent_id: agentId,
    });
  }

  // KB-05: persist first, then mutate memory, then notify.
  await getStorage(candidate.project).saveTask(candidate, projectBucket(candidate.project, candidate));
  updateInMemoryTask(candidate);
   // §2.2/§2.9: surface a semantic event (claimed / renewed) + audit who/why.
   // The auth middleware populates req.caller as { agent_id, role } — reading
   // `caller.agentId` was always undefined, which attributed every renewal by a
   // real agent to 'system' in the very audit substrate §2.9 reads from.
  const actor = (renew ? caller?.agent_id : null) || agentId || 'system';
  const semantic = new Map([[
    compositeKey(candidate.project, candidate.id),
    { kind: renew ? 'renewed' : 'claimed', actor, reason: renew ? 'lease_renewed' : 'claimed' },
    ]]);
  // §2.4b Fix 3: claiming/renewing one card also re-arms the holder's OTHER
  // leases. Exclude the card just written above (already renewed). v2.12.1
  // fixups: scoped to the SAME project as the write (I-2 — a per-project
  // credential must never renew a lease in a project it cannot write), tagged
  // as a distinct 'renewed' event in the SAME notify call (I-5/I-7 — the
  // sibling's new expiry reaches clients in this tick, not some later,
  // unrelated mutation, and does not masquerade as a plain 'updated').
  if (holderWriteRenewsAll()) {
    const siblingKeys = await renewAllLeasesInner(agentId, nowMs, {
      excludeKey: compositeKey(candidate.project, candidate.id),
      project: candidate.project,
    });
    for (const key of siblingKeys) {
      semantic.set(key, { kind: 'renewed', actor: agentId, reason: 'lease_renewed_holder_write' });
    }
  }
  notify({
    actor,
    reason: renew ? 'lease_renewed' : 'claimed',
    semantic,
   });
  return { task: candidate, status: 200 };
}

// ---------------------------------------------------------------------------
// §2.5 optional event-driven auto-promote (BLOCKED -> BACKLOG)
// ---------------------------------------------------------------------------

let completionHooks = [];

/** Register a listener fired when a task reaches DONE. Returns an unsubscribe. */
export function onTaskCompleted(fn) {
  if (typeof fn !== 'function') throw new Error('onTaskCompleted listener must be a function');
  completionHooks.push(fn);
  return () => {
    completionHooks = completionHooks.filter((f) => f !== fn);
  };
}

// Best-effort: a listener error must NEVER poison the completing write.
function runCompletionHooks(id) {
  for (const h of [...completionHooks]) {
    try {
      const r = h(id);
      if (r && typeof r.catch === 'function') {
        r.catch((err) => log.error('completion hook rejected', { error: err && err.message }));
      }
    } catch (err) {
      log.error('completion hook error', { error: err && err.message });
    }
  }
}

/**
 * §2.5 unlockTask inner — a documented system override (like the reaper):
 * BLOCKED → BACKLOG is a *legal* canTransition, but we use a dedicated function
 * so we can also clear ownership + lease, which patchTask's allowlist forbids.
 */
async function unlockTaskInner(task, nowMs, completedRef) {
  const candidate = structuredClone(task);
  candidate.status = STATUSES.READY;
  candidate.assigned_agent = null;
  candidate.claim_expires_at = null;
  candidate.claim_lease_ms = null;
  candidate.updated = isoFromMs(nowMs);
  candidate.version = nextVersionFor(task);
  if (!Array.isArray(candidate.agent_logs)) candidate.agent_logs = [];
  candidate.agent_logs.push({
    timestamp: candidate.updated,
    message: `unblocked — all dependencies complete (${completedRef} DONE).`,
    agent_id: 'system',
    reason: 'unblocked',
  });
  await getStorage(candidate.project).saveTask(candidate, projectBucket(candidate.project, candidate));
  updateInMemoryTask(candidate);
    // §2.2/§2.9: unblocked event + audit for the auto-promote override.
  notify({
    actor: 'system',
    reason: 'unblocked',
    semantic: new Map([[
      compositeKey(candidate.project, candidate.id),
      { kind: 'unblocked', actor: 'system', reason: 'unblocked' },
       ]]),
     });
  return { task: candidate, status: 200 };
}

// Inner (no lock — caller already holds it via patchTask, or via the wrapper).
// COR-08: `completedProject` scopes the match. Short ids are unique only per
// project, so a BLOCKED card is unblocked only when one of its deps resolves
// (in its own project) to the completed card's composite key. A
// `project:id` completedRef carries its own project.
async function maybeUnlockDependentsInner(completedRef, nowMs, completedProject) {
  const unblocked = [];
  const { project: doneProject, shortId: doneId } = resolveProjectScope(completedRef, completedProject);
  const doneKey = compositeKey(doneProject, doneId);
  for (const t of tasks.slice()) {
    if (t.status !== STATUSES.BLOCKED) continue;
    if (t.project !== doneProject) continue;
    const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
    if (!deps.some((dep) => dependencyKey(dep, t.project) === doneKey)) continue;
      // Only unlock when *every* dep is now DONE (the last-dep-completes case).
    if (!dependencyGate(t).ok) continue;
    const r = await unlockTaskInner(t, nowMs, doneId);
    if (!r.error) unblocked.push(t.id);
    }
  // Each unlock fired its own semantic event inside unlockTaskInner; this
     // extra snapshot notify is a no-op re-broadcast so downstream listeners
     // see the whole set in one tick. Only worth the broadcast when something
     // actually unblocked (deep-review: don't re-broadcast a snapshot per DONE
     // transition that unblocked nothing).
  if (unblocked.length > 0) notify({ actor: 'system', reason: 'unblocked_batch' });
  return { unblocked };
}

/**
 * §2.5 maybeUnlockDependents — lock-wrapped, idempotent. Finds BLOCKED tasks
 * whose `completedRef` is a dependency and whose deps are now all DONE, and
 * unblocks them (clears owner + lease). Re-running finds no matching BLOCKED
 * task, so it is safe to call repeatedly.
 */
export async function maybeUnlockDependents(completedRef, { now, project } = {}) {
  return withMutationLock(async () => {
    const nowMs = typeof now === 'number' ? now : nowFn();
    return maybeUnlockDependentsInner(completedRef, nowMs, project);
  });
}

/**
 * Claims a task with contention protection (KB-03) + dependency gating (§2.5)
 * + lease (§2.4). `options.expected_version` (or the `If-Match` header the
 * route injects) adds a §2.6 CAS guard: a stale claim is rejected with a
 * "Version mismatch" 409, distinct from the "… already claimed by …" contention
 * 409 and the `dependency_unsatisfied` 409.
 *
 * v2.13.0: `options.caller` (the authenticated `{ agent_id, role, privileged }`)
 * is threaded through to `applyClaim` so a privileged caller is recognized for
 * the E-2 per-agent claim cap the same way `nextClaim` already does — this was
 * previously silently dropped (`applyClaim(task, agentId, {}, ...)`), so a
 * fresh claim via `POST /:id/claim` could never be exempt from the cap even
 * for an admin/runner/system/human role. Optional and additive: every existing
 * caller that omits it keeps today's behavior (an absent caller = ordinary,
 * non-privileged claim).
 */
export async function claimTask(id, agentId, project, { expected_version: expectedVersion, lease_ms: requestedLease, caller = {} } = {}) {
  return withMutationLock(async () => {
    const task = getTask(id, project);
    if (!task) return { error: 'Task not found', status: 404 };

    if (!agentId || typeof agentId !== 'string') {
      return { error: 'agent_id is required', status: 400 };
      }

    const lease = resolveLeaseMs(requestedLease);
    if (!lease.ok) return { error: lease.error, status: lease.status };

       // §2.6: enforce the version guard before building the candidate.
    const conflict = versionConflict(task, expectedVersion);
    if (conflict) return conflict;

       // Contention + dep gate + write via the shared core.
    return applyClaim(task, agentId, caller, nowFn(), { leaseMs: lease.ms, leaseExplicit: lease.explicit });
   });
}

/**
 * §2.4 renewLease — extend the lease on a held task. Runs in the mutation lock.
 * The HOLDER (builder/reviewer/tester that owns the task) or a PRIVILEGED role
 * (runner/system/human/admin) may renew; a non-privileged non-holder gets a
 * `not_lease_holder` 409. An unclaimed task yields a `not_claimed` 409.
 */
export async function renewLease(id, agentId, { caller = {}, project: projectArg, lease_ms: requestedLease } = {}) {
  return withMutationLock(async () => {
    const task = getTask(id, projectArg);
    if (!task) return { error: 'Task not found', status: 404 };

       // A task with no active claim cannot have its lease renewed.
    if (!task.assigned_agent) {
      return { error: 'Task is not claimed', status: 409, reason: 'not_claimed' };
     }

       // A non-privileged caller must be the current holder. Privilege must be
    // DERIVED FROM THE CREDENTIAL (callerIsPrivileged), never the self-asserted
    // header role — otherwise any bearer can assert X-Agent-Role: admin and renew
    // any agent's lease.
    if (!callerIsPrivileged(caller) && task.assigned_agent !== agentId) {
      return { error: 'Caller is not the lease holder', status: 409, reason: 'not_lease_holder' };
     }

       // Shared core in renew mode: extends the lease, no status move, no log.
    const lease = resolveLeaseMs(requestedLease);
    if (!lease.ok) return { error: lease.error, status: lease.status };
    // Pin the window only on an EXPLICIT request: '' arrives as explicit:false and
    // would otherwise write a lease_ms the caller never asked for.
    return applyClaim(task, agentId, caller, nowFn(), { renew: true, leaseMs: lease.explicit ? lease.ms : null });
       });
       }

/**
 * §2.4b bulk lease renewal (v2.12.0, RC-2). An orchestrator that holds N tasks
 * previously had to make N heartbeat calls, one per card; missing even one while
 * a long job ran let the reaper return that card to READY as a false alarm.
 * This renews EVERY lease the given agent holds in ONE locked pass: for each
 * card owned by `agentId` in an active stage whose lease has NOT already lapsed,
 * push `claim_expires_at` out by that card's own window. Lapsed leases are
 * deliberately NOT revived — a late bulk call must not race the reaper back into
 * ownership. Privilege is enforced at the route layer.
 *
 * v2.12.1 fixups (post-release review):
 *   I-1 — a lease-only renewal does NOT bump `version`. Version is the
 *         content CAS guard (§2.6); bumping it on a sibling the caller never
 *         touched invalidated concurrent `expected_version` PATCHes on cards
 *         nobody was editing.
 *   I-2 — an optional `project` scope restricts the sweep to one project, so a
 *         write authorized for project A can never renew a lease in project B.
 *   I-6 — each card is renewed independently (try/catch); one failing save
 *         must never abort the whole sweep or the caller's own write.
 */
// Unlocked worker for §2.4b Fix 3: renews every NON-lapsed active lease owned by
// `agentId` (optionally scoped to one `project`), persisting each. Caller MUST
// already hold withMutationLock. Returns the composite keys renewed. Never
// emits notify (the caller folds these into its own semantic event).
//
// B1 (v3.12.3): the persist step is grouped per project. Previously each
// sibling was persisted with its own `saveTask`, which on the JSON backend
// (journal OFF, the default) degrades to a FULL-partition rewrite per sibling —
// N held cards meant N whole-partition stringify+write passes on every
// heartbeat. Now all candidates are computed first, updated in memory, and
// each affected project is persisted ONCE via `storage.saveTasks(changed,
// bucket)`. Event semantics (the renewed-keys list, the semantic Map entries)
// and the I-6 failure isolation (a failing persist never throws to the caller)
// are unchanged.
async function renewAllLeasesInner(agentId, nowMs, { excludeKey = null, project = null } = {}) {
  if (!agentId || typeof agentId !== 'string') return [];
  // Pass 1 — compute every renewal candidate, grouped by project (first-seen
  // project order preserved so the returned key list stays stable).
  const byProject = new Map();
  for (const t of tasks.slice()) {
    if (excludeKey !== null && compositeKey(t.project, t.id) === excludeKey) continue;
    if (project !== null && t.project !== project) continue;
    if (t.assigned_agent !== agentId) continue;
    if (!ACTIVE_STATUS_SET.has(t.status)) continue;
    const expiresMs = t.claim_expires_at ? Date.parse(t.claim_expires_at) : NaN;
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) continue;
    const candidate = structuredClone(t);
    candidate.claim_expires_at = isoFromMs(nowMs + leaseWindowFor(candidate));
    candidate.updated = isoFromMs(nowMs);
    if (!byProject.has(candidate.project)) byProject.set(candidate.project, []);
    byProject.get(candidate.project).push(candidate);
  }
  // Pass 2 — ONE persist per project, then fold the candidates into memory.
  const renewed = [];
  for (const [p, candidates] of byProject) {
    try {
      const storage = getStorage(p);
      const bucket = projectBucketFor(p, candidates);
      await storage.saveTasks(candidates, bucket);
      for (const candidate of candidates) {
        updateInMemoryTask(candidate);
        renewed.push(compositeKey(p, candidate.id));
      }
    } catch (err) {
      // I-6: never let a sibling's save failure fail the caller's real write.
      log.error('sibling lease renewal failed', {
        project: p,
        error: err && err.message,
      });
    }
  }
  return renewed;
}

export async function renewAllLeases(agentId, { project: projectArg, caller = {} } = {}) {
  return withMutationLock(async () => {
    if (!agentId || typeof agentId !== 'string') {
      return { error: 'agent_id is required', status: 400 };
    }
    const hasScope = projectArg !== undefined && projectArg !== null && projectArg !== '';
    if (hasScope && !isValidProjectId(projectArg)) {
      return { error: `Invalid project scope: ${String(projectArg)}`, status: 400 };
    }
    const nowMs = nowFn();
    // C-2: reuse the single sibling-renewal implementation instead of a
    // hand-duplicated copy of the same loop.
    const renewed = await renewAllLeasesInner(agentId, nowMs, {
      project: hasScope ? projectArg : null,
    });
    if (renewed.length > 0) {
      const semantic = new Map(
        renewed.map((key) => [key, { kind: 'renewed', actor: agentId, reason: 'lease_renewed_bulk' }]),
      );
      notify({ actor: agentId, reason: 'lease_renewed_bulk', semantic });
    }
    return { renewed, count: renewed.length, status: 200 };
  });
}

/**
 * §2.3b operator assignment (opt-operator-assignment, v2.11.0). Lets a
 * PRIVILEGED caller (runner/system/human/admin) hand a task to a named agent
 * without that agent having to self-claim. This is the documented "assign on
 * an agent's behalf" escape hatch that the roadmap called out; it is a
 * deliberate override of the usual "owner is written only by a claim" rule, so
 * it is privilege-gated exactly like the destructive operations:
 *   - `destructivePrivilege(caller)` must hold (admin token / privileged session
 *     / legacy single-token mode), else 403.
 *   - The target agent id must be a non-empty string, else 400.
 * It sets `assigned_agent`, arms a fresh lease, records `stage_owners` for the
 * stage it lands in, and — like a claim — lifts a BACKLOG or READY card to IN_PROGRESS so
 * the assignment is actionable. It does NOT run the dependency gate or the
 * contention check: an operator explicitly overriding ownership is the point.
 * `agent_id: null` releases the assignment (clears owner + lease, returns an
 * active card to BACKLOG) so an operator can unstick work.
 */
export async function assignTask(id, agentId, { caller = {}, project: projectArg, expected_version: expectedVersion } = {}) {
  return withMutationLock(async () => {
    if (!destructivePrivilege(caller)) {
      return { error: 'Forbidden: admin role required to assign tasks', status: 403 };
    }
    const task = getTask(id, projectArg);
    if (!task) return { error: 'Task not found', status: 404 };

    const conflict = versionConflict(task, expectedVersion);
    if (conflict) return conflict;

    const release = agentId === null || agentId === undefined;
    if (!release && (typeof agentId !== 'string' || agentId.trim() === '')) {
      return { error: 'agent_id must be a non-empty string', status: 400 };
    }

    const candidate = structuredClone(task);
    const nowMs = nowFn();
    if (release) {
      candidate.assigned_agent = null;
      candidate.claim_expires_at = null;
      candidate.claim_lease_ms = null;
      // An ownerless card may not stay in an active stage (the reaper would
      // normalise it anyway) — return it to READY so it is claimable again.
      if (ACTIVE_STATUS_SET.has(candidate.status)) {
        candidate.status = STATUSES.READY;
      }
    } else {
      candidate.assigned_agent = agentId;
      // Keep the card's own window if it had one; otherwise pin the global TTL.
      candidate.claim_lease_ms = leaseWindowFor(candidate);
      candidate.claim_expires_at = isoFromMs(nowMs + candidate.claim_lease_ms);
      if (!Number.isInteger(candidate.reclaim_count)) candidate.reclaim_count = 0;
      if (candidate.status === STATUSES.BACKLOG || candidate.status === STATUSES.READY) {
        candidate.status = STATUSES.IN_PROGRESS;
        const owners = candidate.stage_owners && typeof candidate.stage_owners === 'object'
          ? candidate.stage_owners
          : {};
        candidate.stage_owners = { ...owners, [STATUSES.IN_PROGRESS]: agentId };
      }
    }
    candidate.updated = isoFromMs(nowMs);
    if (!release) {
      // Deep-review: a fresh assignment is new work on the card — refresh the
      // progress clock, otherwise the very next stall sweep reclaims the card
      // again on a LIVE lease (the stall branch ignores lease validity).
      candidate.last_progress_at = candidate.updated;
    }
    candidate.version = nextVersionFor(task);
    if (!Array.isArray(candidate.agent_logs)) candidate.agent_logs = [];
    const actor = caller?.agent_id || caller?.agentId || 'operator';
    candidate.agent_logs.push({
      timestamp: candidate.updated,
      message: release
        ? `Assignment cleared by ${actor} (released to READY).`
        : `${agentId} was assigned this task by ${actor}.`,
      agent_id: escapeHtml(actor),
    });

    await getStorage(candidate.project).saveTask(candidate, projectBucket(candidate.project, candidate));
    updateInMemoryTask(candidate);
    notify({
      actor: actor,
      reason: release ? 'unassigned' : 'assigned',
      semantic: new Map([[`${candidate.project}/${candidate.id}`, {
        kind: release ? 'updated' : 'claimed',
        actor: actor,
        reason: release ? 'unassigned' : 'assigned',
        prevTask: task,
      }]]),
    });
    return { task: candidate, status: 200 };
  });
}

/**
 * Milestone rollup (opt-milestones, v2.11.0). Groups the (live) cards of a
 * project — or every project when `project` is undefined — by their `milestone`
 * label and reports progress per group. Cards with no milestone are omitted so
 * the caller renders only real goals. Archived cards are out of scope: a
 * milestone view is about in-flight work, and the archive is already exposed
 * separately. Pure read; no lock needed.
 */
export function getMilestones(project) {
  const scoped = project ? tasks.filter((t) => t.project === project) : tasks.slice();
  const groups = new Map();
  for (const t of scoped) {
    if (typeof t.milestone !== 'string' || t.milestone === '') continue;
    let g = groups.get(t.milestone);
    if (!g) {
      g = { milestone: t.milestone, project: t.project, total: 0, done: 0, by_status: {} };
      groups.set(t.milestone, g);
    }
    g.total += 1;
    g.by_status[t.status] = (g.by_status[t.status] || 0) + 1;
    if (t.status === STATUSES.DONE) g.done += 1;
  }
  return [...groups.values()]
    .map((g) => ({ ...g, progress: g.total ? Math.round((g.done / g.total) * 100) : 0 }))
    .sort((a, b) => a.milestone.localeCompare(b.milestone));
}


  /**
   * §2.7 nextClaim — atomically select the highest-priority, unclaimed,
   * dependency-satisfied READY task and claim it for `agentId`, all inside one
   * mutation-lock critical section. Priority order: high < medium < low, tie-broke
   * by creation order (array index, FIFO), then by id for total determinism.
   *
   * Only READY + unclaimed + gate-passing tasks are candidates, so the winner
   * never hits a dependency 409. Two concurrent calls get distinct winners (the
   * first claims it → the second sees it held and skips it). No 409 storm.
   *
   * Returns `{ task, status: 200 }` on a claim, or `{ unavailable: true,
   * status: 204 }` when nothing is claimable (a cheap poll target for agents).
   */
  export async function nextClaim({ agentId, role, project, now, lease_ms: requestedLease, caller = null } = {}) {
    return withMutationLock(async () => {
      if (!agentId || typeof agentId !== 'string') {
        return { error: 'agent_id is required', status: 400 };
      }
      // `role` is validation-only (the route checks it against VALID_ROLES) and
      // is recorded on the claim, but it does not filter candidates.
      void role;

      // §2.1/§2.7: an agent bound to one project must never be handed another
      // project's card. An invalid project id matches nothing rather than
      // silently widening to the whole portfolio.
      const hasScope = project !== undefined && project !== null && project !== '';
      if (hasScope && !isValidProjectId(project)) {
        return { unavailable: true, status: 204 };
      }
      const scoped = hasScope ? project : null;

      const candidates = tasks.filter((t) => {
        if (scoped !== null && t.project !== scoped) return false;
        if (t.assigned_agent !== null) return false;
        if (t.status !== STATUSES.READY) return false;
        if (!dependencyGate(t).ok) return false;
        return true;
      });
       if (candidates.length === 0) {
         return { unavailable: true, status: 204 };
         }

          // Order by [priorityRank, arrayIndex, id]; arrayIndex is FIFO creation
         // order because the tasks array is append-ordered and reclaim/unlock
         // mutate in place (preserving index).
       const indexed = candidates.map((t, i) => [t, i]);
       indexed.sort((a, b) => {
         const ra = priorityRank(a[0].priority);
         const rb = priorityRank(b[0].priority);
         if (ra !== rb) return ra - rb;
         if (a[1] !== b[1]) return a[1] - b[1];
         return String(a[0].id).localeCompare(String(b[0].id));
         });

          const nowMs = typeof now === 'number' ? now : nowFn();
          const winner = indexed[0][0];

          // Re-gate at the instant of claim as defense-in-depth (the lock already
         // serializes, but this keeps the shared core total).
       const lease = resolveLeaseMs(requestedLease);
       if (!lease.ok) return { error: lease.error, status: lease.status };
       // SEC-04: carry the credential-derived `privileged` flag (when the route
       // supplies the caller) so the claim-cap exemption follows the credential.
       const claimCaller = role ? { role } : {};
       if (caller && typeof caller === 'object' && 'privileged' in caller) {
         claimCaller.privileged = caller.privileged;
       }
       const r = await applyClaim(winner, agentId, claimCaller, nowMs, { leaseMs: lease.ms, leaseExplicit: lease.explicit });
        if (r.error) return r;
        return { task: r.task, status: 200 };
        });
       }


// ---------------------------------------------------------------------------
// ENH-08 (v2.8.0) — bounded inline log/comment growth with sidecar spill.
// ---------------------------------------------------------------------------
// `agent_logs` and `comments` grew forever on the card, bloating every
// partition rewrite and every SSE snapshot. A cap keeps the inline array
// bounded; overflow entries spill to a JSONL sidecar file under
// <datadir>/spill/<project>/<task-id>.jsonl (one JSON object per line).
// The inline array keeps the NEWEST entries (the tail); the spill file
// holds the OLDER overflow (appended in order). A paging endpoint reads
// both.

function getInlineLogCap() {
  const raw = process.env.KANBAN_INLINE_LOG_CAP;
  if (raw === undefined || raw === '') return 50;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 50;
}

function getInlineCommentCap() {
  const raw = process.env.KANBAN_INLINE_COMMENT_CAP;
  if (raw === undefined || raw === '') return 50;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 50;
}

/**
 * Resolves the spill directory for a project. Lives under the same data root
 * as the task partitions, in a `spill/<project>/` subdirectory.
 */
// spillDir/spillFile live in ./store/core.js (COR-12) so the trash and archive
// modules can retire a sidecar without a cycle back into this facade.

/**
 * Appends one JSON line to the spill file for a task. Creates the directory
 * if needed. One JSON object per line: `{type:'log'|'comment', ...entry}`.
 */
async function appendSpill(project, taskId, type, entry) {
  const dir = spillDir(project);
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify({ type, ...entry }) + '\n';
  await writeFile(spillFile(project, taskId), line, { encoding: 'utf-8', flag: 'a' });
}

/**
 * Reads the spill file for a task, returning an array of entries (oldest-first,
 * matching the order they were appended). Returns [] if no spill file exists.
 */
async function readSpill(project, taskId) {
  const fp = spillFile(project, taskId);
  if (!existsSync(fp)) return [];
  try {
    const raw = await readFile(fp, 'utf-8');
    return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (err) {
    log.warn('spill read error', { project, task_id: taskId, error: err.message });
    return [];
  }
}

/**
 * Counts the number of lines in the spill file for a task without loading
 * the full content (fast for paging). Returns 0 if no spill file exists.
 */
async function countSpill(project, taskId) {
  const fp = spillFile(project, taskId);
  if (!existsSync(fp)) return 0;
  try {
    const raw = await readFile(fp, 'utf-8');
    return raw.split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/**
 * ENH-08 — trims an inline array to `cap` entries, spilling the overflow
 * (the OLDEST entries at the head of the array) to the sidecar JSONL file.
 * Returns the trimmed inline array. Spill writes happen BEFORE the inline
 * trim is persisted (the caller persists `candidate` after this runs).
 *
 * If the array is already within the cap, returns it unchanged. If a task
 * already has >cap entries (e.g. the cap was lowered), trims on the next
 * append only — this function is called only when a new entry was just
 * pushed, so the cap is enforced incrementally.
 *
 * @param {string} type   'log' | 'comment'
 * @param {string} project
 * @param {string} taskId
 * @param {Array}  arr    The inline array (newest at the tail)
 * @param {number} cap    Max inline entries (0 = unbounded)
 * @returns {Array}       The trimmed inline array
 */
async function spillOverflow(type, project, taskId, arr, cap) {
  if (cap <= 0 || arr.length <= cap) return arr;
  // Keep the NEWEST `cap` entries inline; spill the OLDER overflow.
  const overflow = arr.slice(0, arr.length - cap);
  const trimmed = arr.slice(arr.length - cap);
  for (const entry of overflow) {
    await appendSpill(project, taskId, type, entry);
  }
  return trimmed;
}

/**
 * ENH-08 — paging read for a task's log/comment history. Returns:
 *   { inline: [...], spilled_count, entries: [...] }
 * `inline` is the current inline array (newest-first for logs, oldest-first
 * for comments — matching how the card renders them). `entries` is the
 * spilled slice requested by offset/limit (oldest-first, matching the order
 * they were appended to the spill file). `spilled_count` is the total number
 * of spilled entries. When `include_spilled` is true, `entries` contains ALL
 * spilled entries (offset/limit are ignored for the spilled slice).
 *
 * For logs, the inline array is returned newest-first (the card shows the
 * most recent log at the top). The spill is oldest-first (append order).
 */
export async function getTaskLogs(id, project, { offset = 0, limit = 50, include_spilled = false } = {}) {
  const task = getTask(id, project);
  if (!task) return { error: 'Task not found', status: 404 };
  const logs = Array.isArray(task.agent_logs) ? task.agent_logs : [];
  // Inline logs: newest-first (reverse of append order).
  const inline = [...logs].reverse();
  // COR-12: the sidecar is keyed by the card's SHORT id. Using the request id
  // missed it for the documented `project:id` form.
  const spilled_count = await countSpill(task.project, task.id);
  // Deep-review: `include_spilled=1` must mean "the spilled page", not "the
  // entire spill file regardless of offset/limit" — a reclamation-storm card
  // would otherwise return its whole history on every open read.
  const allSpilled = await readSpill(task.project, task.id);
  const entries = allSpilled.slice(offset, offset + limit);
  return { inline, spilled_count, entries, status: 200 };
}


/**
 * Appends log to task. `options.expected_version` (or the `If-Match` header
 * the route injects) adds a §2.6 CAS guard and bumps version on the write.
 */
export async function appendLog(id, agentId, message, project, { expected_version: expectedVersion } = {}) {
  return withMutationLock(async () => {
    const task = getTask(id, project);
    if (!task) return { error: 'Task not found', status: 404 };

    if (!agentId || !message) {
      return { error: 'agent_id and message are required', status: 400 };
    }
    if (typeof message !== 'string' || message.trim() === '') {
      return { error: 'message must be a non-empty string', status: 400 };
    }
    if (message.length > MAX_MESSAGE_LEN) {
      return { error: `message must be at most ${MAX_MESSAGE_LEN} characters`, status: 400 };
    }
    if (typeof agentId !== 'string' || agentId.trim() === '') {
      return { error: 'agent_id must be a non-empty string', status: 400 };
    }

        // §2.6: enforce the version guard before building the candidate.
    const conflict = versionConflict(task, expectedVersion);
    if (conflict) return conflict;

    const candidate = structuredClone(task);
    candidate.updated = new Date().toISOString();
        // §2.6: a committed log append advances version by exactly one.
    candidate.version = nextVersionFor(task);
    // E-1: a log is progress on THIS card specifically.
    candidate.last_progress_at = candidate.updated;
    // §2.4: a progress log from the lease HOLDER is proof of life, so extend the
    // lease. Headless workers report progress with POST /logs and never call
    // /heartbeat (the browser client heartbeats every 5s), so without this a
    // long build loses its lease at the TTL and the reaper resets the card.
    // Only the holder counts: any agent may log on any task, so a non-holder
    // must never inherit or extend someone else's claim.
    if (
      candidate.assigned_agent &&
      candidate.assigned_agent === agentId &&
      candidate.claim_expires_at
    ) {
      candidate.claim_expires_at = isoFromMs(nowFn() + leaseWindowFor(candidate));
    }
    if (!Array.isArray(candidate.agent_logs)) {
      candidate.agent_logs = [];
      }
    candidate.agent_logs.push({
      timestamp: candidate.updated,
      message: escapeHtml(message),
      agent_id: escapeHtml(agentId),
    });

    // ENH-08: spill the oldest overflow log entries to the sidecar JSONL file
    // BEFORE persisting, so the inline array stays bounded at the cap.
    candidate.agent_logs = await spillOverflow(
      'log', candidate.project, candidate.id, candidate.agent_logs, getInlineLogCap(),
    );

    // KB-05 (I-6 fixup): persist the PRIMARY write, update memory, THEN
    // attempt sibling renewals. A sibling save failure must never leave this
    // log persisted-but-not-in-memory, nor fail the caller's own request —
    // renewAllLeasesInner already isolates per-card failures internally.
    await getStorage(candidate.project).saveTask(candidate, projectBucket(candidate.project, candidate));
    updateInMemoryTask(candidate);
    const semantic = new Map();
    if (holderWriteRenewsAll() && agentId && agentId === candidate.assigned_agent) {
      // v2.12.1 (I-2): scoped to the SAME project as this write.
      const siblingKeys = await renewAllLeasesInner(agentId, nowFn(), {
        excludeKey: compositeKey(candidate.project, candidate.id),
        project: candidate.project,
      });
      for (const key of siblingKeys) {
        semantic.set(key, { kind: 'renewed', actor: agentId, reason: 'lease_renewed_holder_write' });
      }
    }
    notify(semantic.size > 0 ? { semantic } : undefined);
    return { task: candidate, status: 200 };
  });
}

/**
 * Appends issue to task (KB-08). `options.expected_version` (or the `If-Match`
 * header the route injects) adds a §2.6 CAS guard and bumps version on the write.
 */
export async function addIssue(id, issueId, project, { expected_version: expectedVersion } = {}) {
  return withMutationLock(async () => {
    const task = getTask(id, project);
    if (!task) return { error: 'Task not found', status: 404 };

    if (!issueId || typeof issueId !== 'string') {
      return { error: 'issue_id is required', status: 400 };
       }
    // COR-09: the same bounds PATCH applies to `issues`.
    if (issueId.length > MAX_ISSUE_LEN) {
      return { error: `issue_id must be at most ${MAX_ISSUE_LEN} characters`, status: 400 };
    }

        // §2.6: enforce the version guard before building the candidate.
    const conflict = versionConflict(task, expectedVersion);
    if (conflict) return conflict;

    const safeIssueId = escapeHtml(issueId);

    const candidate = structuredClone(task);
    if (!Array.isArray(candidate.issues)) {
      candidate.issues = [];
      }
    if (!candidate.issues.includes(safeIssueId)) {
      if (candidate.issues.length >= MAX_ISSUES) {
        return { error: `issues must contain at most ${MAX_ISSUES} entries`, status: 400 };
      }
      candidate.issues.push(safeIssueId);
      }
    candidate.updated = new Date().toISOString();
        // §2.6: a committed issue append advances version by exactly one.
    candidate.version = nextVersionFor(task);

    await getStorage(candidate.project).saveTask(candidate, projectBucket(candidate.project, candidate));
    updateInMemoryTask(candidate);
    notify();
    return { issues: candidate.issues, status: 200 };
     });
}

/**
 * v2.5.0 — Appends a human/agent comment to a task's discussion thread.
 * Deliberately separate from `agent_logs` (the machine audit trail): comments
 * are a discussion surface. Mirrors appendLog: §2.6 CAS guard, escapeHtml on
 * both fields, exactly one version bump, KB-05 persist-first ordering. NOT in
 * patchTask's allowlist — the only write path is this function.
 */
export async function addComment(id, agentId, message, project, { expected_version: expectedVersion } = {}) {
  return withMutationLock(async () => {
    const task = getTask(id, project);
    if (!task) return { error: 'Task not found', status: 404 };

    if (!agentId || !message || typeof message !== 'string') {
      return { error: 'agent_id and message are required', status: 400 };
    }
    if (message.trim() === '') {
      return { error: 'message must be a non-empty string', status: 400 };
    }
    if (message.length > MAX_MESSAGE_LEN) {
      return { error: `message must be at most ${MAX_MESSAGE_LEN} characters`, status: 400 };
    }
    if (typeof agentId !== 'string' || agentId.trim() === '') {
      return { error: 'agent_id must be a non-empty string', status: 400 };
    }

    // §2.6: enforce the version guard before building the candidate.
    const conflict = versionConflict(task, expectedVersion);
    if (conflict) return conflict;

    const candidate = structuredClone(task);
    if (!Array.isArray(candidate.comments)) candidate.comments = [];
    candidate.comments.push({
      timestamp: new Date().toISOString(),
      message: escapeHtml(message),
      agent_id: escapeHtml(agentId),
    });
    candidate.updated = new Date().toISOString();
    // §2.6: a committed comment advances version by exactly one (which also
    // re-renders the memoized card / sheet via the id+version signature).
    candidate.version = nextVersionFor(task);

    // ENH-08: spill the oldest overflow comments to the sidecar JSONL file
    // BEFORE persisting, so the inline array stays bounded at the cap.
    candidate.comments = await spillOverflow(
      'comment', candidate.project, candidate.id, candidate.comments, getInlineCommentCap(),
    );

    await getStorage(candidate.project).saveTask(candidate, projectBucket(candidate.project, candidate));
    updateInMemoryTask(candidate);
    notify();
    return { task: candidate, status: 200 };
  });
}


// ---------------------------------------------------------------------------
// Admin delete & bulk purge (§admin-purge)
// ---------------------------------------------------------------------------

/**
 * Admin-only delete of a single task. Persists FIRST (fail-closed, KB-05):
 * the JSON backend rewrites the project partition minus this task; the Git
 * backend git-rms the card file + commits. Only then is the task dropped from
 * memory. Requires the admin credential or a privileged session (A8,
 * adminCredentialPrivilege).
 */
export async function deleteTask(id, { caller = {}, project } = {}) {
  return withMutationLock(async () => {
    const task = getTask(id, project);
    if (!task) return { error: 'Task not found', status: 404 };

    /**
     * SEC-01 (v2.5.2, defense-in-depth per Reviewer): resolveProjectScope lets
     * a composite `project:id` id outrank the ?project= scope, so a caller
     * could address another project's card through the path segment. A
     * destructive delete may only land inside the authorized scope.
     */
    const authorizedProject =
      project === undefined || project === null || project === ''
        ? defaultProjectName()
        : project;
    if (task.project !== authorizedProject) {
      return {
        error: `Forbidden: delete scope is limited to project '${authorizedProject}'`,
        status: 403,
      };
    }

    if (!adminCredentialPrivilege(caller)) return destructiveForbidden('delete tasks');

    /**
     * v2.5.6 (ENH-03): soft-delete. The task is stamped deleted_at/deleted_by,
     * parked in the per-project trash sink, and dropped from the live
     * partition — recoverable via restoreFromTrash until the retention sweep
     * (KANBAN_TRASH_DAYS, default 30) or a hard purge removes it.
     */
    const deletedAt = new Date(nowFn()).toISOString();
    const storage = getStorage(task.project);
    const trashed = Object.assign(structuredClone(task), {
      deleted_at: deletedAt,
      deleted_by: caller.agent_id || 'admin',
      version: nextVersionFor(task),
    });

    if (storage instanceof GitYamlStorage) {
      // COR-15: persist the STAMPED copy (deleted_by, bumped version) so disk
      // and memory agree after a restart, exactly as the JSON branch does.
      await storage.trashTask(trashed);
    } else {
      // Deep-review: write the SAFETY SINK first, then the partition. A crash
      // between the two must leave the card parked in trash, never lost in both
      // (the Git backend already writes the sink first).
      const survivors = getProjectBucket(task.project).filter((t) => t.id !== task.id);
      const sink = [...(trash[task.project] || []), trashed];
      await storage.saveTrash(sink);
      await storage.save(survivors);
    }

    trash[task.project] = [...(trash[task.project] || []), trashed];
    removeFromMemory(task.project, task.id);
    // COR-12: the trash row takes its spill sidecar along (keyed by deleted_at)
    // so a re-created card with this id starts with no inherited history.
    await moveSpillFile(
      spillFile(task.project, task.id),
      parkedSpillFile(task.project, task.id, 'trash', trashed.deleted_at),
    );
    notify({
      actor: caller.agent_id || 'admin',
      reason: 'deleted',
      semantic: new Map([[
        compositeKey(task.project, task.id),
        { kind: 'deleted', actor: caller.agent_id || 'admin', reason: 'deleted', task },
      ]]),
    });
    return { task, status: 200 };
  });
}

/**
 * Admin-only bulk purge of tasks by explicit ids (composite-aware) or a filter.
 * Persists FIRST per affected project, then drops the rows from memory and
 * emits one consolidated deletion event. Requires a privileged role.
 */
export async function purgeTasks({ caller = {}, project, ids, filter, hard = false } = {}) {
  return withMutationLock(async () => {
    if (!adminCredentialPrivilege(caller)) return destructiveForbidden('delete tasks');

    /**
     * SEC-01 (v2.5.2): the purge scope is clamped to the caller's authorized
     * scope. An unscoped call (no ?project=) was previously allowed to sweep
     * EVERY project, and `filter.project` could name any project — so a
     * token scoped to project A (or the default) could bulk-delete another
     * project's tasks that the auth layer never authorized. Now: an unscoped
     * purge may only target the default project, and a `filter.project` must
     * either agree with the ?project= scope or, on an unscoped call, be the
     * default project.
     */
    const authorizedProject =
      project === undefined || project === null || project === ''
        ? defaultProjectName()
        : project;
    const scoped = tasks.filter((t) => t.project === authorizedProject);

    let candidates;
    if (Array.isArray(ids) && ids.length > 0) {
      const idSet = new Set(ids);
      candidates = scoped.filter((t) => {
        if (idSet.has(t.id)) return true;
        return idSet.has(compositeKey(t.project, t.id));
      });
    } else if (filter && typeof filter === 'object') {
      // BUG-07 (v2.6.0): a filter with no recognized key (e.g. {} or {foo:1})
      // previously matched EVERY task in scope — an accidental "delete all".
      // Require at least one recognized key so an empty/typo'd filter is a 400
      // instead of a board-wipe.
      const RECOGNIZED = ['status', 'project', 'assigned_agent', 'older_than_days'];
      if (!RECOGNIZED.some((k) => k in filter)) {
        return { error: 'purge filter must include at least one of: status, project, assigned_agent, older_than_days', status: 400 };
      }
      const status = filter.status !== undefined ? normalizeStatus(filter.status) : undefined;
      const fp = filter.project;
      // A filter.project that disagrees with the authorized scope widens the
      // blast radius past the token's grant — reject rather than silently
      // intersecting (the caller's intent cannot be satisfied safely).
      if (
        fp !== undefined && fp !== null && fp !== '' &&
        fp !== authorizedProject
      ) {
        return {
          error: `Forbidden: purge scope is limited to project '${authorizedProject}'`,
          status: 403,
        };
      }
      const ageDays = filter.older_than_days;
      const ageThresholdMs =
        typeof ageDays === 'number' && Number.isFinite(ageDays)
          ? ageDays * 86400000
          : null;
      const nowMs = Date.now();
      candidates = scoped.filter((t) => {
        if (status !== undefined && status !== null && t.status !== status) return false;
        if (fp !== undefined && fp !== null && fp !== '' && t.project !== fp) return false;
        if ('assigned_agent' in filter) {
          if (filter.assigned_agent === null) {
            if (t.assigned_agent != null) return false;
          } else if (t.assigned_agent !== filter.assigned_agent) {
            return false;
          }
        }
        if (ageThresholdMs !== null) {
          const anchor = t.completed_at || t.created_at || t.updated;
          if (!anchor) return false;
          const ageMs = nowMs - Date.parse(anchor);
          if (Number.isNaN(ageMs) || ageMs < ageThresholdMs) return false;
        }
        return true;
      });
    } else {
      return { error: 'purge requires ids[] or filter', status: 400 };
    }

    if (candidates.length === 0) {
      return { deleted: [], count: 0, status: 200 };
    }

    // Group by project so each partition is rewritten exactly once (persist-first).
    const byProject = new Map();
    for (const t of candidates) {
      if (!byProject.has(t.project)) byProject.set(t.project, []);
      byProject.get(t.project).push(t);
    }

    const semantic = new Map();
    const deleted = [];

    for (const [p, list] of byProject) {
      const storage = getStorage(p);
      if (hard) {
        // v2.5.6: {hard:true} = permanent deletion, bypassing the trash sink.
        if (storage instanceof GitYamlStorage) {
          for (const t of list) {
            await storage.deleteTask(t);
          }
        } else {
          const deleteIds = new Set(list.map((t) => t.id));
          const survivors = getProjectBucket(p).filter((t) => !deleteIds.has(t.id));
          await storage.deleteTask(list[0], survivors);
        }
        // COR-12: a permanent delete retires the card's spill sidecar too, so
        // a future card reusing the id never inherits this card's logs.
        for (const t of list) await removeSpillFile(spillFile(p, t.id));
      } else {
        // Soft-delete: park each row in the trash sink (persist-first), then
        // drop it from the live partition.
        const deletedAt = new Date(nowFn()).toISOString();
        // COR-15: stamp once and persist the SAME stamped copies on both
        // backends (the git branch used to write the un-stamped rows).
        const stamped = list.map((t) => Object.assign(structuredClone(t), {
          deleted_at: deletedAt,
          deleted_by: caller.agent_id || 'admin',
          version: nextVersionFor(t),
        }));
        if (storage instanceof GitYamlStorage) {
          for (const row of stamped) {
            await storage.trashTask(row);
          }
        } else {
          const deleteIds = new Set(list.map((t) => t.id));
          const survivors = getProjectBucket(p).filter((t) => !deleteIds.has(t.id));
          // Deep-review: write the SAFETY SINK first, then the partition.
          const sink = [...(trash[p] || []), ...stamped];
          await storage.saveTrash(sink);
          await storage.save(survivors);
        }
        trash[p] = [...(trash[p] || []), ...stamped];
        // COR-12: each trash row takes its sidecar along, keyed by deleted_at.
        for (const row of stamped) {
          await moveSpillFile(spillFile(p, row.id), parkedSpillFile(p, row.id, 'trash', row.deleted_at));
        }
      }
      for (const t of list) {
        removeFromMemory(p, t.id);
        const key = compositeKey(p, t.id);
        deleted.push(key);
        semantic.set(key, {
          kind: 'deleted', actor: caller.agent_id || 'admin', reason: 'deleted', task: t,
        });
      }
    }

    notify({
      actor: caller.agent_id || 'admin',
      reason: 'deleted',
      semantic,
    });

    return { deleted, count: deleted.length, status: 200 };
  });
}


// Re-export for convenience / tests
export { defaultProjectName as getDefaultProject };
