/**
 * C1 (v3.12.5) — v2.5.6 (ENH-03) soft-delete trash sink: restore, hard delete,
 * and the retention sweep. Extracted verbatim from store.js; the sink itself
 * (`trash`) lives in ./core.js because loadStore() seeds it.
 */
import {
  trash,
  index,
  getStorage,
  projectBucket,
  updateInMemoryTask,
  compositeKey,
  withMutationLock,
  persistApplied,
  versionConflict,
  nextVersionFor,
  spillFile,
  parkedSpillFile,
  moveSpillFile,
  removeSpillFile,
} from './core.js';
import { notify } from './listeners.js';
import { GitYamlStorage } from '../storage.js';
import { STATUSES } from '../state-machine.js';
import { defaultProjectName, isValidProjectId } from '../task-identity.js';
import { escapeHtml } from '../utils/sanitize.js';
import { adminCredentialPrivilege, destructiveForbidden } from '../task-fields.js';

// ---------------------------------------------------------------------------
// v2.5.6 (ENH-03): soft-delete trash sink. deleteTask/purgeTasks route into
// `trash` (a per-project sink beside the archive) instead of destroying data;
// restore returns a card to READY; a sweep hard-deletes rows older than
// KANBAN_TRASH_DAYS (default 30). `purgeTasks({hard:true})` bypasses the sink
// for true permanent deletion.
// ---------------------------------------------------------------------------

// KANBAN_TRASH_DAYS: how long a soft-deleted task survives before the sweep
// hard-deletes it. Default 30; 0 disables retention (trash keeps everything
// until hard-purged); a negative value also disables the sweep.
function getTrashDays() {
  const raw = process.env.KANBAN_TRASH_DAYS;
  if (raw === undefined || raw === null || raw === '') return 30;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30;
}

function trashList(project) {
  if (project === undefined || project === null || project === '') {
    let out = [];
    for (const list of Object.values(trash)) out = out.concat(list);
    return out.sort((a, b) => String(b.deleted_at || '').localeCompare(String(a.deleted_at || '')));
  }
  if (!isValidProjectId(project)) return [];
  return [...(trash[project] || [])];
}

function trashFind(project, id) {
  const list = trash[project] || [];
  return list.find((t) => t.id === id) || null;
}

// COR-05: remove exactly ONE row, by object identity. An id can be deleted,
// re-created and deleted again, leaving two trash rows with the same id;
// filtering by bare id destroyed the sibling row too (memory and disk).
async function trashPersistRemove(project, removedTask) {
  const storage = getStorage(project);
  const remaining = (trash[project] || []).filter((t) => t !== removedTask);
  if (storage instanceof GitYamlStorage) {
    await storage.trashRemove(removedTask);
  } else {
    await storage.saveTrash(remaining);
  }
  if (remaining.length === 0) delete trash[project];
  else trash[project] = remaining;
}

/**
 * Admin-only restore of a soft-deleted task back to the live board (READY).
 * Persists FIRST (KB-05): the live partition gains the restored card and the
 * trash sink loses it, both before memory mutates.
 */
export async function restoreFromTrash(id, { caller = {}, project, expected_version: expectedVersion } = {}) {
  return withMutationLock(async () => {
    const authorizedProject =
      project === undefined || project === null || project === ''
        ? defaultProjectName()
        : project;
    const trashed = trashFind(authorizedProject, id);
    if (!trashed) return { error: 'Task not found in trash', status: 404 };

    // v3.12.1 (Board Health Check): restore is a destructive-op sibling of
    // hardDeleteFromTrash — it requires the same privileged credential. 404 is
    // reported first, mirroring deleteTask's ordering.
    if (!adminCredentialPrivilege(caller)) return destructiveForbidden('restore tasks');

    if (index.has(compositeKey(authorizedProject, id))) {
      return { error: 'A live task with this id already exists', status: 409 };
    }

    // v3.12.1 (Board Health Check): honor the CAS guard the route already
    // forwards. The trash row carries its pre-delete version; nextVersionFor
    // below bumps it, so the expectation is checked against trashed.version.
    const conflict = versionConflict(trashed, expectedVersion);
    if (conflict) return conflict;

    const restored = structuredClone(trashed);
    restored.status = STATUSES.READY;
    // COR-07: a restored card is NOT finished, archived or recently progressed.
    // A stale completed_at made a re-finished card keep its old completion
    // time (archive eligibility and cycle-time metrics key on it).
    delete restored.completed_at;
    delete restored.archived_at;
    restored.last_progress_at = null;
    restored.assigned_agent = null;
    restored.claim_expires_at = null;
    restored.claim_lease_ms = null;
    restored.stage_owners = {};
    restored.deleted_at = undefined;
    restored.deleted_by = undefined;
    restored.restored_at = new Date().toISOString();
    restored.updated = restored.restored_at;
    restored.version = nextVersionFor(trashed);
    restored.agent_logs = [
      ...(Array.isArray(restored.agent_logs) ? restored.agent_logs : []),
      {
        timestamp: restored.restored_at,
        message: escapeHtml('Task restored from trash by board admin.'),
        agent_id: escapeHtml(caller.agent_id || 'admin'),
      },
    ];

    // Persist FIRST: live partition + trash sink, then memory.
    const storage = getStorage(authorizedProject);
    if (storage instanceof GitYamlStorage) {
      await persistApplied(storage.saveTask(restored), restored);
      // COR-101: shared identity-based removal updates memory as well as disk.
      await trashPersistRemove(authorizedProject, trashed);
    } else {
      // BUGFIX (deep-review P0): persist the partition WITH the restored card.
      // The previous call persisted `getProjectBucket(authorizedProject)` — the
      // live bucket WITHOUT `restored` — so the card existed only in memory and
      // any restart silently lost it while the trash copy was already gone.
      await persistApplied(storage.saveTask(restored, projectBucket(authorizedProject, restored)), restored);
      await trashPersistRemove(authorizedProject, trashed);
    }

    updateInMemoryTask(restored);
    // COR-12: bring the row's parked spill sidecar back to the live name (no
    // live card with this id exists — checked above).
    await moveSpillFile(
      parkedSpillFile(authorizedProject, id, 'trash', trashed.deleted_at),
      spillFile(authorizedProject, id),
    );
    notify({
      actor: caller.agent_id || 'admin',
      reason: 'restored',
      semantic: new Map([[
        compositeKey(authorizedProject, id),
        { kind: 'created', actor: caller.agent_id || 'admin', reason: 'restored', prevTask: null, task: restored },
      ]]),
    });
    return { task: restored, status: 200 };
  });
}

/**
 * Admin-only hard delete of a soft-deleted task (permanent). Requires a
 * privileged credential, mirroring the other destructive ops.
 */
export async function hardDeleteFromTrash(id, { caller = {}, project } = {}) {
  return withMutationLock(async () => {
    if (!adminCredentialPrivilege(caller)) return destructiveForbidden('delete tasks');
    const authorizedProject =
      project === undefined || project === null || project === ''
        ? defaultProjectName()
        : project;
    const trashed = trashFind(authorizedProject, id);
    if (!trashed) return { error: 'Task not found in trash', status: 404 };
    await trashPersistRemove(authorizedProject, trashed);
    await removeSpillFile(parkedSpillFile(authorizedProject, id, 'trash', trashed.deleted_at));
    // COR-06: the semantic override is keyed by project/id, and the diff
    // dispatcher applies it to a LIVE row with that key. When the id has been
    // re-created, a 'deleted' event would drop the live card from every
    // client, webhook and audit log — so only attach it when no live row
    // shares the key.
    const key = compositeKey(authorizedProject, id);
    if (index.has(key)) {
      notify({ actor: caller.agent_id || 'admin', reason: 'purged_from_trash' });
    } else {
      notify({
        actor: caller.agent_id || 'admin',
        reason: 'purged_from_trash',
        semantic: new Map([[
          key,
          { kind: 'deleted', actor: caller.agent_id || 'admin', reason: 'purged_from_trash', task: trashed },
        ]]),
      });
    }
    return { task: trashed, status: 200 };
  });
}

/**
 * Trash retention sweep: hard-deletes sink rows older than
 * KANBAN_TRASH_DAYS (default 30). Runs inside the existing archive sweep
 * cadence (GET /archive, GET /tasks, GET /metrics all sweep first).
 *
 * A4 (v3.12.2): an optional `projects` iterable (array/Set, or null) narrows
 * the sink loop to those projects — a scoped archive sweep must not hard-delete
 * rows from projects its credential cannot see. Null keeps the historical
 * all-projects behaviour.
 *
 * Lock discipline (mirrors reclaimTaskInner/public reclaimTask): the inner
 * function does the work WITHOUT acquiring the mutation lock, so
 * runArchiveSweep — which already holds the lock — can call it directly.
 * The exported wrapper acquires the lock for standalone callers.
 */
export async function runTrashSweepInner(projects = null) {
  const days = getTrashDays();
  if (days <= 0) return { purged: [], now: Date.now() };
  const nowMs = Date.now();
  const purged = [];
  const projectFilter = projects === undefined || projects === null ? null : new Set(projects);
  for (const [project, list] of Object.entries(trash)) {
    if (projectFilter && !projectFilter.has(project)) continue;
    const expired = list.filter((t) => {
      const anchor = t.deleted_at || t.updated || t.created_at;
      if (!anchor) return false;
      const age = nowMs - Date.parse(anchor);
      return !Number.isNaN(age) && age >= days * 86400000;
    });
    for (const t of expired) {
      await trashPersistRemove(project, t);
      await removeSpillFile(parkedSpillFile(project, t.id, 'trash', t.deleted_at));
      purged.push(compositeKey(project, t.id));
    }
  }
  return { purged, now: nowMs };
}

export async function runTrashSweep() {
  return withMutationLock(() => runTrashSweepInner());
}

export function getTrashedTasks(project) {
  return trashList(project);
}
