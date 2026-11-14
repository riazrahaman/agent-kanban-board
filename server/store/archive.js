/**
 * C1 (v3.12.5) — §2.8 archive sweep: moves aged DONE cards into their project's
 * archive sink. Extracted verbatim from store.js; the live/archive arrays come
 * from ./core.js, the trash sweep it rides on from ./trash.js, and its event
 * from ./listeners.js.
 */
import {
  tasks,
  archive,
  getStorage,
  removeFromMemory,
  compositeKey,
  withMutationLock,
  getMutationSerial,
  getLastSweepSerial,
  isMutationLockBusy,
  setLastSweepSerial,
  spillFile,
  parkedSpillFile,
  moveSpillFile,
} from './core.js';
import { notify } from './listeners.js';
import { runTrashSweepInner } from './trash.js';
import { GitYamlStorage } from '../storage.js';
import { STATUSES } from '../state-machine.js';
import { resolveProjectScope } from '../task-identity.js';

// ---------------------------------------------------------------------------
// Archiving & Storage Hygiene (§2.8)
// ---------------------------------------------------------------------------

function getArchiveAfterDays() {
  const raw = process.env.KANBAN_ARCHIVE_AFTER_DAYS;
  if (raw === undefined || raw === '') return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0; // negative disables the sweep
  return n;
}

function isEligibleForArchive(task, days, nowMs) {
  if (task.status !== STATUSES.DONE) return false;
  if (task.archived_at) return false;
  const anchor = task.completed_at || task.created_at || task.updated;
  if (!anchor) return false;
  const ageMs = nowMs - Date.parse(anchor);
  if (Number.isNaN(ageMs)) return false;
  return ageMs >= days * 86400000;
}

/**
 * Moves DONE tasks older than KANBAN_ARCHIVE_AFTER_DAYS (keyed off completed_at,
 * then created_at, then updated) into their project's archive. Idempotent and
 * safe to run on every boot and lazily before reads. 0 disables the sweep.
 */
// B2 (v3.12.2): the lazy no-op check runs BEFORE withMutationLock. It used to
// sit inside the lock, so every list read queued behind in-flight mutations
// even when the sweep was about to skip itself. `mutationSerial` is only ever
// written under the lock, so a serial bumped between this check and lock
// acquisition simply means the sweep runs again on a later read — the same
// eventual invariant, with no torn state and no correctness change.
// B2 (v3.16.0): when the lock is BUSY (writes in flight) a lazy sweep no longer
// joins the queue: the read is served from the in-memory state and one
// coalesced sweep is deferred behind the in-flight writes. An idle lock still
// sweeps inline, so quiet boards keep the previous read-your-sweep behaviour.
let deferredSweep = null;
function deferLazySweep() {
  if (deferredSweep) return;
  deferredSweep = runArchiveSweep({ lazy: true, deferred: true })
    .catch(() => undefined)
    .finally(() => { deferredSweep = null; });
}

export async function runArchiveSweep({ lazy = false, projects = null, deferred = false } = {}) {
  if (lazy && getMutationSerial() === getLastSweepSerial()) return 0;
  if (lazy && !deferred && isMutationLockBusy()) {
    deferLazySweep();
    return 0;
  }
  return withMutationLock(async () => {
    // v2.5.6: the trash-retention sweep rides the same cadence (any read path
    // that sweeps the archive also ages out the trash sink). Called via the
    // UNLOCKED inner — runArchiveSweep already holds the lock; awaiting the
    // locked wrapper here would deadlock the non-reentrant promise chain.
    // Deep-review: retention only changes on committed mutations, so a sequence
    // of reads with no writes between them needs no resweep. Forced calls
    // (POST /tasks/archive/sweep) and the boot sweep always run.
    setLastSweepSerial(getMutationSerial());
    // A4 (v3.12.2): optional { projects } narrows BOTH sweeps to the caller's
    // authorized set (a project-scoped credential must not sweep other
    // projects' sinks). Unscoped callers pass null and sweep everything.
    await runTrashSweepInner(projects);
    const days = getArchiveAfterDays();
    if (days === 0) return 0;

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // A4 (v3.12.2): when the caller supplied a project set (a scoped sweep),
    // only those projects are eligible for the move.
    const projectFilter = projects === undefined || projects === null ? null : new Set(projects);

    // Deep-review P1: a DONE card that still blocks a live dependency must NOT
    // be archived. dependencyGate resolves deps in the LIVE index only, so an
    // archived blocker becomes permanently dangling and its dependents can
    // never again be claimed or even PATCH-ed (their gate 409s forever).
    // COR-08 (v3.12.11): keyed by composite project/id — a short id is unique
    // only within a project, so a dep in project B must not pin (or fail to
    // pin, for a `project:id` entry) a same-named card in project A.
    const blockedByLive = new Set();
    for (const t of tasks) {
      if (t.status === STATUSES.DONE) continue;
      for (const dep of t.depends_on || []) {
        const { project: depProject, shortId } = resolveProjectScope(dep, t.project);
        blockedByLive.add(compositeKey(depProject, shortId));
      }
    }

    // Group live tasks by project; also track projects that already hold
    // archived rows (so their archive sink gets a consistent write even when
    // they have no live partition of their own, e.g. the default boot case).
    const byProject = new Map();
    for (const t of tasks) {
      if (!byProject.has(t.project)) byProject.set(t.project, []);
      byProject.get(t.project).push(t);
     }

    let moved = 0;
    const touchedProjects = new Set();
    const archivedSemantic = new Map();

    const runFor = async (project, liveList) => {
      const eligible = (liveList || []).filter(
        (t) => !blockedByLive.has(compositeKey(project, t.id)) && isEligibleForArchive(t, days, nowMs),
      );
      const storage = getStorage(project);
      const isGit = storage instanceof GitYamlStorage;

      // No eligible tasks -> nothing to move, and (per the KB-05 fail-closed
      // invariant) no reason to touch any archive sink file on this pass.
      if (eligible.length === 0) return;

      // (a) Build the new archive entries + the surviving live partition WITHOUT
      // touching memory, so a persistence failure below leaves memory unchanged
      // (symmetric with the single-task path at store.js:399-400, KB-05).
      const newArchived = eligible.map((t) => {
        const archived = structuredClone(t);
        archived.archived_at = nowIso;
        return archived;
      });
      const eligibleIds = new Set(eligible.map((t) => t.id));

      // (b) Persist FIRST: the live partition minus the moved rows, and the
      // merged archive sink. Only when persistence fully succeeds do we mutate
      // memory, so a throw fails closed and the task survives in the live set.
      if (isGit) {
        // saveArchiveTask git-rms the live card and writes + commits the
        // archive card; the archive sink has no separate file for git.
        for (const archived of newArchived) {
          await storage.saveArchiveTask(archived);
        }
      } else {
        // Deep-review: write the SAFETY SINK first, then the partition — a
        // crash between the two must leave the moved cards parked in the
        // archive, never lost in both (Git's saveArchiveTask already removes
        // the live card last). Sink rewrite is gated on a real move (FIX 3).
        const survivors = (liveList || []).filter((t) => !eligibleIds.has(t.id));
        const merged = [...(archive[project] || []), ...newArchived];
        await storage.saveArchive(merged);
        await storage.save(survivors);
      }

      // (c) Only after every persistence call succeeded: drop the moved rows
      // from the in-memory live set/index and append them to the live archive.
      for (const t of eligible) {
        removeFromMemory(project, t.id);
      }
      const list = archive[project] || (archive[project] = []);
      for (const archived of newArchived) {
        list.push(archived);
      }
      // COR-12: the archived snapshot keeps its inline logs; its spilled
      // history moves out of the live namespace with it (parked beside the
      // archive, keyed by archived_at) so a future card reusing the id does
      // not inherit it.
      for (const archived of newArchived) {
        await moveSpillFile(
          spillFile(project, archived.id),
          parkedSpillFile(project, archived.id, 'archive', archived.archived_at),
        );
      }
      for (const archived of newArchived) {
        archivedSemantic.set(compositeKey(project, archived.id), {
          kind: 'archived', actor: 'system', reason: 'archived', task: archived,
          });
        }
      moved += eligible.length;
      touchedProjects.add(project);
      };

    // Run for every project that currently has live tasks.
    for (const [project, liveList] of byProject) {
      if (projectFilter && !projectFilter.has(project)) continue;
      await runFor(project, liveList);
     }

    // A project whose only record is an archive list is re-processed here, but
    // the early return in runFor makes it a no-op unless it actually has
    // eligible rows to move (so no archive sink churn when nothing moved).
    for (const project of Object.keys(archive)) {
      if (projectFilter && !projectFilter.has(project)) continue;
      if (!byProject.has(project)) {
        await runFor(project, []);
      }
    }

    if (moved > 0) {
      notify({ actor: 'system', reason: 'archived', semantic: archivedSemantic });
      }
    return moved;
   });
}
