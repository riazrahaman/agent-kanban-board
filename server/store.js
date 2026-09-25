import { readFile, writeFile, rename, mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'yaml';
import { escapeHtml } from './utils/sanitize.js';
import {
  STATUSES,
  VALID_STATUS_LIST,
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

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ENH-11 (v2.10.0): the loop state machine (statuses + transition graph + role
// matrix) lives in ./state-machine.js. Re-exported here so every existing
// `../store.js` importer keeps working unchanged.
export {
  STATUSES,
  VALID_STATUS_LIST,
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

// ============================================================================
// Injectable clock (§2.4) — all lease math goes through nowFn() so tests can
// force expiry deterministically. Pass undefined to restore the wall clock.
// ============================================================================
let nowFn = () => Date.now();

export function setNowFn(fn) {
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
}

// ============================================================================
// Lease / reaper / auto-promote config (§2.4 / §2.5) — read at call time so a
// test suite can override per-suite via env. (Minor deviation from the plan's
// "cache at load": call-time reads are correct for env-toggle tests.)
// ============================================================================
function getClaimTtlMs() {
  const raw = process.env.KANBAN_CLAIM_TTL_MS;
  // Default raised 300000 -> 600000 (v2.3.11): headless builders only POST /logs
  // (which extends the lease since v2.3.4) and the browser heartbeats every 5s,
  // but measured log gaps on the production board showed median 46s / p95 315s,
  // so a 5-minute TTL reaped live work 6% of the time; 10 minutes cuts that to
  // ~2.6% without meaningfully delaying recovery of genuinely dead agents.
  if (raw === undefined || raw === '') return 600000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 600000;
}

export function getMinLeaseMs() {
  const raw = process.env.KANBAN_MIN_LEASE_MS;
  if (raw === undefined || raw === '') return 60000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 60000;
}

export function getMaxLeaseMs() {
  const raw = process.env.KANBAN_MAX_LEASE_MS;
  if (raw === undefined || raw === '') return 7200000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 7200000;
}

export function leaseWindowFor(task) {
  return task.claim_lease_ms ?? getClaimTtlMs();
}

function resolveLeaseMs(requested) {
  if (requested === undefined || requested === null || requested === '') {
    // No explicit request (including an empty `?lease_ms=`): the lease keeps
    // the global default, and we do NOT pin it — the caller stores `null` so a
    // later config change still applies.
    return { ok: true, ms: getClaimTtlMs(), explicit: false };
  }
  // v2.12.1 (I-8): accept only an actual number or a numeric string. Before
  // this guard, `Number(requested)` coerced `true` -> 1 and `[5]` -> 5, so a
  // malformed request silently got clamped up to the SHORTEST possible lease
  // (KANBAN_MIN_LEASE_MS) instead of being rejected — the exact failure mode
  // this feature exists to prevent.
  const isNumericType = typeof requested === 'number';
  const isNumericString = typeof requested === 'string' && /^\d+(\.\d+)?$/.test(requested.trim());
  if (!isNumericType && !isNumericString) {
    return { ok: false, status: 400, error: 'lease_ms must be a positive number of milliseconds' };
  }
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, status: 400, error: 'lease_ms must be a positive number of milliseconds' };
  }
  const min = getMinLeaseMs();
  const max = getMaxLeaseMs();
  return { ok: true, ms: Math.min(Math.max(n, min), max), explicit: true };
}

// E-2: cap how many active leases one agent may hold at once. 0/unset =
// unlimited (unchanged default behavior). Privileged roles are exempt (they
// administer the board, e.g. an orchestrator batch-assigning via /assign).
function getMaxClaimsPerAgent() {
  const raw = process.env.KANBAN_MAX_CLAIMS_PER_AGENT;
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function countActiveClaims(agentId) {
  let count = 0;
  for (const t of tasks) {
    if (t.assigned_agent !== agentId) continue;
    if (
      t.status === STATUSES.BUILDING ||
      t.status === STATUSES.IN_REVIEW ||
      t.status === STATUSES.IN_TEST
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * §2.4b Fix 3 (v2.12.0). When a task holder writes to any one card, renew the
 * leases on every OTHER card they also hold, in the same lock — otherwise an
 * orchestrator busy on one card silently loses its siblings to the reaper even
 * though it was demonstrably active. Default ON; set KANBAN_HOLDER_WRITE_RENEWS_ALL=0
 * (or false) to disable.
 */
function holderWriteRenewsAll() {
  const raw = process.env.KANBAN_HOLDER_WRITE_RENEWS_ALL;
  if (raw === undefined || raw === '') return true;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

function getReapIntervalMs() {
  const raw = process.env.KANBAN_REAP_INTERVAL_MS;
  if (raw === undefined || raw === '') return 30000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 30000;
}

/**
 * §2.4 orphan grace — how long an ownerless ACTIVE task may sit untouched before
 * the reaper treats it as structurally stuck.
 *
 * An active task with no owner/lease is normally created by a status-only PATCH
 * (the documented orchestrator flow: `PATCH {status:'BUILDING', role:'admin'}`).
 * That is a *legitimate* intermediate state — per-stage ownership deliberately
 * keeps `assigned_agent` as the lease holder rather than reassigning it — so
 * reaping it on the very next sweep destroys a card that was just written to.
 * The grace window is anchored on `updated`, so any later write (a log, a
 * transition) resets it. Defaults to a FIXED 5-minute window, deliberately
 * DECOUPLED from the claim TTL (v2.3.11): deriving it from `getClaimTtlMs()`
 * meant raising the TTL (300s -> 600s) silently doubled how long an ownerless
 * active card could sit unowned before being normalized. The two knobs answer
 * different questions — "how long may a lease run idle" vs "how long may a
 * nobody-owned card sit untouched" — so they no longer share a default.
 * `0` disables the grace (reap orphans immediately).
 */
function getOrphanGraceMs() {
  const raw = process.env.KANBAN_ORPHAN_GRACE_MS;
  if (raw === undefined || raw === '') return 300000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 300000;
}

export function isReaperEnabled() {
  const raw = process.env.KANBAN_REAP_ENABLED;
  if (raw === undefined || raw === '') return true;
  return raw !== 'false' && raw !== '0';
}

function isAutoPromoteEnabled() {
  const raw = process.env.KANBAN_AUTO_PROMOTE;
  if (raw === undefined || raw === '') return true;
  return raw !== 'false' && raw !== '0';
}

function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

// ENH-11 (v2.10.0): Atomic File Operations + Project/Workspace namespacing
// moved to ./task-identity.js and re-exported at the top of this file.

function compositeKey(project, id) {
  return `${project}/${id}`;
}

// ============================================================================
// Store State & API
// ============================================================================

let storage = null;
let storeLoaded = false;    // true once loadStore() has completed (§health read-only)
let tasks = [];             // every live task across all projects
let archive = {};           // project -> Task[] (archived, not in `tasks`)
let listeners = [];
const index = new Map();    // `${project}/${id}` -> Task   (O(1) composite lookup)
const storageCache = new Map(); // project -> per-project storage instance
let mutationQueue = Promise.resolve();

// v2.5.0: per-project display settings (column colors). Maps project -> raw
// saved settings object; resolution (board default -> project override) happens
// at read time in getSettings().
let projectSettings = new Map();
let settingsListeners = [];

// v2.5.6 (ENH-03): trash sink. project -> Task[] (soft-deleted, not live).
let trash = {};
// KANBAN_TRASH_DAYS: how long a soft-deleted task survives before the sweep
// hard-deletes it. Default 30; 0 disables retention (trash keeps everything
// until hard-purged); a negative value also disables the sweep.
function getTrashDays() {
  const raw = process.env.KANBAN_TRASH_DAYS;
  if (raw === undefined || raw === null || raw === '') return 30;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30;
}

export function withMutationLock(operation) {
  const run = mutationQueue.then(() => operation(), () => operation());
  mutationQueue = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Incremental aggregate cache (Pipeline C)
// ---------------------------------------------------------------------------
//
// getProjectSummaries() and getMetrics() are hot observability endpoints that
// used to scan every live task AND every archive entry on each call. That cost
// grows without bound as archive history accumulates. Instead we cache the
// task-derived aggregates and rebuild them lazily only after a committed
// mutation (create/patch/claim/reclaim/archive/unlock), so a clean read is
// O(projects) instead of O(live + archive). The two time/event-dependent bits
// — `active_agents` (lease expiry vs now) and `claim_contention` (since-boot
// map) — are still resolved at read time, matching the original semantics.
//
// `aggregatesDirty` is set by the same serialized mutation paths that touch
// state (updateInMemoryTask / removeFromMemory / rebuildIndex), so the cache
// never observes a torn state. Cold start is handled by rebuildIndex marking
// the cache dirty on load.
let aggregatesDirty = true;
let cachedSummaries = null;   // sorted array result of getProjectSummaries()
let cachedMetricBases = null; // Map<project, baseMetric> (counts + sorted cycles)
let cachedAggregateCycleTime = null; // summarizeDurations(all cycle samples)

function invalidateAggregates() {
  aggregatesDirty = true;
}

// ---------------------------------------------------------------------------
// Storage factory (per-project, cached)
// ---------------------------------------------------------------------------

// ENH-11 (v2.10.0): gitRoot() / jsonDataDir() moved to ./task-identity.js
// (re-exported at the top of this file).

export function getStorage(project) {
  const p = project === undefined ? defaultProjectName() : normalizeProject(project);
  if (storageCache.has(p)) return storageCache.get(p);

  const backend = process.env.KANBAN_STORAGE_BACKEND || 'json';
  let inst;
  if (backend === 'git') {
    const root = gitRoot();
    const autoCommit = process.env.KANBAN_GIT_COMMIT !== 'false';
    if (p === defaultProjectName()) {
      // Default project reuses the flat legacy root.
      inst = new GitYamlStorage(root, { autoCommit, rootPath: root, project: p });
    } else {
      inst = new GitYamlStorage(path.join(root, p), { autoCommit, rootPath: root, project: p });
    }
  } else {
    if (p === defaultProjectName()) {
      // Default project reuses KANBAN_DATA_FILE / server/tasks.json unchanged.
      const live = process.env.KANBAN_DATA_FILE || path.join(__dirname, 'tasks.json');
      inst = new JsonStorage(live, { project: p, isDefault: true });
    } else {
      const live = path.join(jsonDataDir(), 'tasks', `${p}.json`);
      inst = new JsonStorage(live, { project: p, isDefault: false });
    }
  }

  storageCache.set(p, inst);
  return inst;
}

export function setStorage(newStorage, project) {
  if (newStorage === null || newStorage === undefined) {
    storage = null;
    storageCache.clear();
    return;
  }
  if (project === undefined) {
    // Bind to the default project (preserves the existing test contract where
    // every project is the implicit single project).
    storage = newStorage;
    storageCache.set(defaultProjectName(), newStorage);
  } else {
    const p = normalizeProject(project);
    storageCache.set(p, newStorage);
  }
}

// ---------------------------------------------------------------------------
// Enumeration helpers
// ---------------------------------------------------------------------------

async function listJsonProjects() {
  const dir = path.join(jsonDataDir(), 'tasks');
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.json') && isValidProjectId(f.slice(0, -5)))
    .map((f) => f.slice(0, -5));
}

export async function listGitProjects(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // BUG-06 (v2.7.0): a blanket `entry.name === 'archive'` skip made a real
    // git project literally named `archive` invisible after restart. The
    // archive SINK dir (`<root>/archive/`) holds only per-project SUBDIRECTORIES
    // and no direct `.yml`, so the `files.some(yml)` check below already
    // excludes it. Only dotfiles are skipped here.
    if (entry.name.startsWith('.')) continue;
    let files;
    try {
      files = await readdir(path.join(root, entry.name));
    } catch {
      continue;
    }
    if (files.some((f) => (f.endsWith('.yml') || f.endsWith('.yaml')) && !f.startsWith('.'))) {
      projects.push(entry.name);
    }
  }
  return projects;
}

// ---------------------------------------------------------------------------
// Index maintenance
// ---------------------------------------------------------------------------

function rebuildIndex(loaded) {
  index.clear();
  tasks = loaded.slice();
  for (const t of tasks) {
    index.set(compositeKey(t.project, t.id), t);
  }
  invalidateAggregates();
}

function updateInMemoryTask(updatedTask) {
  const key = compositeKey(updatedTask.project, updatedTask.id);
  index.set(key, updatedTask);
  const idx = tasks.findIndex((t) => t.id === updatedTask.id && t.project === updatedTask.project);
  if (idx >= 0) {
    tasks[idx] = updatedTask;
   } else {
    tasks.push(updatedTask);
   }
  invalidateAggregates();
}

/**
 * Test-only helper: install/replace a task's in-memory copy in place (no
 * persistence, no version bump, no notify). Used by tests to seed synthetic
 * states that are otherwise unreachable through the claim path (e.g. a held but
 * dependency-unmet task, which no legal claim can produce).
 */
export function setTaskInMemory(task) {
  updateInMemoryTask(task);
}

function removeFromMemory(project, id) {
  index.delete(compositeKey(project, id));
  const idx = tasks.findIndex((t) => t.id === id && t.project === project);
  if (idx >= 0) tasks.splice(idx, 1);
  invalidateAggregates();
}

/**
 * Builds the live bucket for a project with `candidate` applied (replacing or
 * appending). Used for the partition-scoped save so only that project's file
 * (JSON) / card (Git) is rewritten.
 */
export function getProjectBucket(project) {
  return tasks.filter((t) => t.project === project);
}

function projectBucket(project, candidate) {
  const out = tasks.filter((t) => t.project === project);
  const idx = out.findIndex((t) => t.id === candidate.id);
  if (idx >= 0) out[idx] = candidate;
  else out.push(candidate);
  return out;
}

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
  for (const t of loaded) {
    t.project = t.project && isValidProjectId(t.project) ? t.project : dp;
    if (!t.created_at) t.created_at = t.updated || nowIso;
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

  rebuildIndex(loaded);

  // Load per-project archives.
  archive = {};
  for (const p of projectSet) {
    try {
      const a = await getStorage(p).loadArchive();
      if (a && a.length) archive[p] = a;
    } catch (err) {
      console.warn(`[kanban] archive load error for ${p}: ${err.message}`);
    }
  }

  // v2.5.0: load per-project display settings (column colors) alongside the
  // archives. A project with no saved settings simply has no override entry.
  projectSettings = new Map();
  for (const p of projectSet) {
    try {
      const s = await getStorage(p).loadSettings();
      if (s && typeof s === 'object' && Object.keys(s).length) projectSettings.set(p, s);
    } catch (err) {
      console.warn(`[kanban] settings load error for ${p}: ${err.message}`);
    }
  }

  // v2.5.6: load the trash sink alongside archives so a restart never loses
  // soft-deleted rows (the whole point of the sink).
  trash = {};
  for (const p of projectSet) {
    try {
      const tl = await getStorage(p).loadTrash();
      if (tl && tl.length) trash[p] = tl;
    } catch (err) {
      console.warn(`[kanban] trash load error for ${p}: ${err.message}`);
    }
  }

  await runArchiveSweep();
  storeLoaded = true;
  notify();
}

/**
 * Read-only liveness signal: true once `loadStore()` has completed. The health
 * endpoint derives `store_loaded` from this without mutating anything.
 */
export function isStoreLoaded() {
  return storeLoaded;
}

// §2.2 diff-event layer: on each notify(), compute created/updated/removed vs the
// previous snapshot, then dispatch {kind, task, prev?, project} events to
// diffListeners. Backward-compat: full-snapshot `onChange` listeners still see
// every mutation, unmodified.
let diffListeners = [];
let prevTaskMap = new Map(); // `${project}/${id}` -> Task (previous snapshot)
let diffListenersInitialized = false;

/**
 * §2.2 — register a diff listener. Receives `{ kind, task, prev?, project }` on
 * every mutation where something changed. `kind` is one of
 * 'created' | 'updated' | 'removed' | 'archived'. Returns unsubscribe.
 */
export function onDiff(listener) {
  diffListeners.push(listener);
  return () => {
    diffListeners = diffListeners.filter((l) => l !== listener);
   };
}

/**
 * §2.9 — structured audit-log entry for every committed mutation. Shape:
 *   { ts, kind, project, task, prev?, actor, reason? }
 * `kind` mirrors the diff layer. `actor` is the mutating agent (system for
 * reaper/unlock/archive). `reason` carries a short human-readable cause (e.g.
 * 'lease_expired', 'unblocked', 'archived'...). This is the substrate for
 * §2.9 metrics + audit; today it's just a console line.
 */
let auditListeners = [];
export function onAudit(fn) {
  if (typeof fn !== 'function') throw new Error('onAudit listener must be a function');
  auditListeners.push(fn);
  return () => {
    auditListeners = auditListeners.filter((f) => f !== fn);
   };
}

export function emitAudit(entry) {
  for (const fn of [...auditListeners]) {
    try {
      fn(entry);
    } catch (err) {
      console.error('[kanban audit] listener error:', err);
    }
  }
  // Default: console line. Best-effort, must not throw.
  try {
    console.log(
      `[kanban audit] ${entry.ts} ${entry.kind} ${entry.project}/${entry.task ? entry.task.id : 'n/a'} ` +
        `actor=${entry.actor || 'anon'}${entry.reason ? ' reason=' + entry.reason : ''}`
     );
  } catch {/* ignore */}
}

// Dispatch structured diff events computed from the previous vs current task
// map. `opts.semantic` is a Map of `${project}/${id}` -> { kind, reason, actor }
// used to override the inferred kind for a specific mutated task (e.g. a claim
// surfaces as 'claimed' not 'updated'). One event per changed task, never two.
function dispatchDiffEvents({ actor = 'user', reason = null, semantic = null } = {}) {
  if (!diffListenersInitialized) {
    prevTaskMap = new Map(tasks.map((t) => [
      compositeKey(t.project, t.id), t,
      ]));
    diffListenersInitialized = true;
    return;
    }
  const now = new Map(tasks.map((t) => [
    compositeKey(t.project, t.id), t,
    ]));
  const tsMs = Date.now();

  const fire = (key, kind, task, prev, evActor, evReason) => {
    const event = {
      kind, task, prev: prev || null, project: task?.project,
      actor: evActor || actor, reason: evReason ?? reason, ts: tsMs,
      };
    for (const l of [...diffListeners]) {
      try { l(event); } catch (err) {
        console.error('[kanban diff] listener error:', err);
        }
      }
    emitAudit({
      ts: new Date(tsMs).toISOString(), kind,
      project: task?.project, task, prev: prev || null,
      actor: evActor || actor, reason: evReason ?? reason,
      });
   };

    // Removed: present previously, gone now. The archive sweep drops rows from
    // the live set, so an archived task lands here — a semantic override is the
    // only way it can surface as 'archived' rather than a bare 'removed'.
   for (const [key, prevTask] of prevTaskMap) {
    if (!now.has(key)) {
      const sev = semantic && semantic.get(key);
      if (sev) {
        fire(key, sev.kind, sev.task || prevTask, prevTask, sev.actor, sev.reason);
        continue;
        }
      fire(key, 'removed', prevTask, prevTask, actor, reason);
      }
    }
    // Created + updated: present now.
   for (const [key, task] of now) {
    const prevTask = prevTaskMap.get(key) || null;
     // A supplied semantic override wins for this exact task.
    const sev = semantic && semantic.get(key);
    if (sev) {
      fire(key, sev.kind, task, prevTask, sev.actor, sev.reason);
      continue;
     }
    // Unchanged rows must stay silent: without this, every mutation fanned out
    // one 'updated' per task in the store. Mutation paths are copy-on-write
    // (setTaskInMemory swaps the object), so identity is the change signal —
    // and a semantic override above already fired unconditionally, so the
    // claim/renew/unblock/reclaim paths never depend on this check.
    if (prevTask === task) continue;
    // 'archived' is never inferred here: archiving removes the row from the
    // live set, so it is emitted from the removed branch via a semantic
    // override. Inferring it from a DONE->DONE transition mislabelled every
    // ordinary edit of a done task.
    const kind = prevTask ? 'updated' : 'created';
    fire(key, kind, task, prevTask, actor, reason);
   }
  prevTaskMap = now;
}

/**
 * §2.2/§2.9 — notify snapshot listeners (unchanged shape, backward-compat) and
 * layer the structured diff + audit. Optional semantic metadata:
 *   actor  — who caused this mutation ('builder-x', 'system', ...)
 *   reason — short human cause ('lease_expired', 'unblocked', 'archived')
 *   semantic — Map`${project}/${id}` -> { kind, actor, reason } to override the
 *              inferred kind for a specific mutated task (claim -> 'claimed',
 *              reclaim -> 'reclaimed', unlock -> 'unblocked').
 */
export function notify(opts = {}) {
  const snapshot = tasks;
   for (const listener of listeners) {
    try {
      listener(snapshot);
      } catch (err) {
       console.error('[kanban] listener error:', err);
       }
     }
   dispatchDiffEvents(opts);
}

/**
 * Live listener counts. Exists so a leak is testable: the SSE handler
 * subscribes per connection and unsubscribes on `req.on('close')`, and the
 * §2.10 project switcher re-subscribes on every project change — so
 * open/close has to balance or a long session accumulates dead sockets.
 */
export function listenerCounts() {
  return {
    snapshot: listeners.length,
    diff: diffListeners.length,
    audit: auditListeners.length,
  };
}

export function onChange(listener) {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
   };
}

// ---------------------------------------------------------------------------
// v2.5.0 — Per-project display settings (column colors)
// ---------------------------------------------------------------------------
//
// A board-wide default (the `default` project's saved settings) plus optional
// per-project overrides. The palette is the client's existing accent token set
// (muted/live/warn/test/fail/pass/block/line) — raw hex never crosses the wire,
// so every choice keeps the validated WCAG contrast of the design system.

export const COLUMN_COLOR_KEYS = [...VALID_STATUS_LIST, 'UNKNOWN', 'ISSUES'];

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
  BUILDING: 'live',
  IN_REVIEW: 'warn',
  IN_TEST: 'test',
  BLOCKED: 'fail',
  DONE: 'pass',
  UNKNOWN: 'line',
  ISSUES: 'warn',
});

export function onSettings(listener) {
  settingsListeners.push(listener);
  return () => {
    settingsListeners = settingsListeners.filter((l) => l !== listener);
  };
}

export function settingsListenerCount() {
  return settingsListeners.length;
}

function emitSettings(project, settings) {
  for (const listener of [...settingsListeners]) {
    try {
      listener({ project, settings });
    } catch (err) {
      console.error('[kanban] settings listener error:', err);
    }
  }
}

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

/**
 * Orders records most-recently-touched first.
 *
 * The board renders a lane top-to-bottom in the order the API returns, so the
 * list must be recency-ordered or "what just moved" is buried wherever the
 * record happened to sit in the array. `updated` is stamped on create and on
 * every mutation, so it is the right key. Falls back to created_at, then to
 * insertion into the returned copy for records that carry neither (legacy
 * data), so the comparison is total and stable.
 *
 * Sorts a COPY: `tasks` is the live in-memory array the store mutates.
 */
function byRecency(a, b) {
  const ka = Date.parse(a.updated ?? a.created_at ?? '');
  const kb = Date.parse(b.updated ?? b.created_at ?? '');
  const va = Number.isNaN(ka) ? -Infinity : ka;
  const vb = Number.isNaN(kb) ? -Infinity : kb;
  if (vb !== va) return vb - va;
  return 0;
}

export function getTasks(project) {
  // No filter -> all live projects (preserves current single-project behavior).
  if (project === undefined || project === null || project === '') return [...tasks].sort(byRecency);
  if (!isValidProjectId(project)) return [];
  return tasks.filter((t) => t.project === project).sort(byRecency);
}

export function getTask(id, project) {
  const { project: resolved, shortId } = resolveProjectScope(id, project);
  return index.get(compositeKey(resolved, shortId)) ?? null;
}

export function getArchivedTasks(project) {
  if (project === undefined || project === null || project === '') {
    let out = [];
    for (const list of Object.values(archive)) out = out.concat(list);
    return out;
  }
  return archive[project] || [];
}

function rebuildSummaries() {
  const map = new Map();
  const ensure = (p) => {
    let s = map.get(p);
    if (!s) {
      s = { project: p, task_count: 0, done_count: 0, live_count: 0, archived_count: 0, updated: null };
      map.set(p, s);
    }
    return s;
  };
  const touch = (s, iso) => {
    if (iso && (!s.updated || iso > s.updated)) s.updated = iso;
  };
  for (const t of tasks) {
    const s = ensure(t.project);
    s.live_count += 1;
    s.task_count += 1;
    if (t.status === STATUSES.DONE) s.done_count += 1;
    touch(s, t.updated);
  }
  for (const [p, list] of Object.entries(archive)) {
    const s = ensure(p);
    s.archived_count += list.length;
    s.task_count += list.length;
    for (const t of list) touch(s, t.archived_at || t.updated);
  }
  cachedSummaries = [...map.values()].sort((a, b) => a.project.localeCompare(b.project));
}

// Builds the task-derived, durable portion of §2.9 metrics (everything except
// `active_agents` — lease expiry is measured against wall-clock `now` — and
// `claim_contention` — a since-boot counter). Cycle samples are sorted once here
// so `cycle_time` is O(1) at read time instead of re-sorting the completed set.
function rebuildMetricBases() {
  const byProject = new Map();
  const ensure = (p) => {
    if (!byProject.has(p)) {
      byProject.set(p, {
        project: p,
        task_count: 0,
        live_count: 0,
        archived_count: 0,
        done_count: 0,
        completed_count: 0,
        by_status: Object.fromEntries(VALID_STATUS_LIST.map((s) => [s, 0])),
        reclaim_count: 0,
        reclaimed_task_count: 0,
        cycles: [],
      });
    }
    return byProject.get(p);
  };
  const ingest = (task, archived) => {
    const m = ensure(task.project);
    m.task_count += 1;
    if (archived) m.archived_count += 1;
    else m.live_count += 1;

    if (Object.prototype.hasOwnProperty.call(m.by_status, task.status)) {
      m.by_status[task.status] += 1;
    }
    if (task.status === STATUSES.DONE) {
      m.completed_count += 1;
      if (!archived) m.done_count += 1;
    }

    const reclaims = Number.isInteger(task.reclaim_count) ? task.reclaim_count : 0;
    m.reclaim_count += reclaims;
    if (reclaims > 0) m.reclaimed_task_count += 1;

    if (task.completed_at && task.created_at) {
      const start = Date.parse(task.created_at);
      const end = Date.parse(task.completed_at);
      if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
        m.cycles.push(end - start);
      }
    }
  };

  for (const t of tasks) ingest(t, false);
  for (const [p, list] of Object.entries(archive)) {
    for (const t of list) ingest({ ...t, project: t.project || p }, true);
  }

  // Pre-sorted union of every project's cycle samples, for the unscoped
  // aggregate. (The scoped aggregate's cycle time equals that project's own.)
  const allCycles = [];
  for (const m of byProject.values()) {
    for (const d of m.cycles) allCycles.push(d);
    m.cycles.sort((a, b) => a - b);
    m.cycle_time = summarizeDurations(m.cycles);
    delete m.cycles;
  }
  allCycles.sort((a, b) => a - b);
  cachedMetricBases = byProject;
  cachedAggregateCycleTime = summarizeDurations(allCycles);
}

// Empty (no tasks) per-project metric base, for a valid-but-unknown scope.
function emptyBase(project) {
  return {
    project,
    task_count: 0,
    live_count: 0,
    archived_count: 0,
    done_count: 0,
    completed_count: 0,
    by_status: Object.fromEntries(VALID_STATUS_LIST.map((s) => [s, 0])),
    cycle_time: summarizeDurations([]),
    reclaim_count: 0,
    reclaimed_task_count: 0,
  };
}

// Recomputes the aggregate caches from authoritative live + archive state. Only
// runs after a committed mutation (or load) flips `aggregatesDirty`.
function rebuildAggregates() {
  if (!aggregatesDirty) return;
  rebuildSummaries();
  rebuildMetricBases();
  aggregatesDirty = false;
}

export function getProjectSummaries() {
  rebuildAggregates();
  return cachedSummaries;
}

// ---------------------------------------------------------------------------
// §2.9 — cross-project observability
// ---------------------------------------------------------------------------

/**
 * Claim-contention counters, per project. This is the one metric with no
 * durable source: a rejected claim is not a committed mutation, so it leaves no
 * trace on any task and emits no audit entry. It is therefore reported as an
 * explicitly since-boot figure (`claim_contention.since`) rather than being
 * presented alongside the durable counts as if it survived a restart.
 */
let contentionCounts = new Map();
let contentionSince = new Date().toISOString();

function recordClaimContention(project) {
  const key = project || defaultProjectName();
  contentionCounts.set(key, (contentionCounts.get(key) || 0) + 1);
}

export function resetClaimContention() {
  contentionCounts = new Map();
  contentionSince = new Date().toISOString();
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarizeDurations(values) {
  if (values.length === 0) {
    return { count: 0, mean_ms: null, median_ms: null, p90_ms: null, min_ms: null, max_ms: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    mean_ms: Math.round(total / sorted.length),
    median_ms: percentile(sorted, 50),
    p90_ms: percentile(sorted, 90),
    min_ms: sorted[0],
    max_ms: sorted[sorted.length - 1],
  };
}

/**
 * §2.9 metrics for one project, or every project plus an aggregate.
 *
 * Everything except claim contention is computed from persisted task fields
 * (`created_at` / `completed_at` / `reclaim_count` / `assigned_agent`) rather
 * than from accumulated in-process counters, so the numbers survive a restart
 * and can never drift from the tasks they describe.
 *
 * Archived tasks are included. They are exactly the completed work, so
 * excluding them would make cycle time silently improve as history is swept.
 */
export function getMetrics(project) {
  const scope =
    project === undefined || project === null || project === '' ? null : project;
  if (scope !== null && !isValidProjectId(scope)) return null;

  rebuildAggregates();

  const nowMs = Date.now();

  // Only `active_agents` depends on wall-clock lease expiry, so it must be
  // recomputed per read. Everything else (counts, by_status, reclaims, sorted
  // cycle samples) is served from the cached metric bases rebuilt only on a
  // committed mutation. `active_agents` scans only live tasks, never archive,
  // so it stays O(live) even as archive history grows unbounded.
  const liveAgents = new Map(); // project -> Set<agent>
  for (const t of tasks) {
    if (scope !== null && t.project !== scope) continue;
    if (!t.assigned_agent) continue;
    const expiry = t.claim_expires_at ? Date.parse(t.claim_expires_at) : NaN;
    if (!Number.isNaN(expiry) && expiry > nowMs) {
      if (!liveAgents.has(t.project)) liveAgents.set(t.project, new Set());
      liveAgents.get(t.project).add(t.assigned_agent);
    }
  }

  // Build the per-project result list from cached bases (or an empty base for a
  // valid-but-unknown scope), overlaying the live `active_agents`.
  const bases = [];
  if (scope !== null) {
    const cached = cachedMetricBases.get(scope);
    bases.push(cached ? { ...cached } : emptyBase(scope));
  } else {
    for (const m of cachedMetricBases.values()) bases.push({ ...m });
  }

  const projects = bases
    .map((m) => {
      const agents = [...(liveAgents.get(m.project) || [])].sort();
      return {
        project: m.project,
        task_count: m.task_count,
        live_count: m.live_count,
        archived_count: m.archived_count,
        done_count: m.done_count,
        completed_count: m.completed_count,
        by_status: { ...m.by_status },
        cycle_time: m.cycle_time,
        reclaim_count: m.reclaim_count,
        reclaimed_task_count: m.reclaimed_task_count,
        active_agents: agents,
        active_agent_count: agents.length,
        claim_contention: {
          conflicts: contentionCounts.get(m.project) || 0,
          since: contentionSince,
        },
      };
    })
    .sort((a, b) => a.project.localeCompare(b.project));

  // Aggregate over the scope. The unscoped aggregate's cycle time uses the
  // pre-sorted union of all cycle samples. For a scoped read the aggregate is
  // over exactly one project, so its cycle time equals that project's own
  // (already-computed, already-sorted) cycle time.
  const allAgents = new Set();
  for (const a of liveAgents.values()) for (const x of a) allAgents.add(x);

  const sum = (key) => projects.reduce((acc, m) => acc + m[key], 0);
  const aggregate = {
    project: null,
    project_count: projects.length,
    task_count: sum('task_count'),
    live_count: sum('live_count'),
    archived_count: sum('archived_count'),
    done_count: sum('done_count'),
    completed_count: sum('completed_count'),
    by_status: Object.fromEntries(
      VALID_STATUS_LIST.map((s) => [s, projects.reduce((acc, m) => acc + m.by_status[s], 0)]),
      ),
    cycle_time: scope !== null ? projects[0].cycle_time : cachedAggregateCycleTime,
    reclaim_count: sum('reclaim_count'),
    reclaimed_task_count: sum('reclaimed_task_count'),
    active_agents: [...allAgents].sort(),
    active_agent_count: allAgents.size,
    claim_contention: {
      conflicts: projects.reduce((acc, m) => acc + m.claim_contention.conflicts, 0),
      since: contentionSince,
    },
  };

  return { generated_at: new Date().toISOString(), scope, projects, aggregate };
}

// ---------------------------------------------------------------------------
// Optimistic concurrency (§2.6)
// ---------------------------------------------------------------------------

/**
 * Centralizes the version bump so every committed mutation advances the
 * task's monotonically-increasing `version` by exactly one. A task missing a
 * (or carrying a non-integer) version is treated as version 1, which keeps the
 * CAS total on legacy records that have not yet been backfilled.
 */
export function nextVersionFor(task) {
  const current = task && Number.isInteger(task.version) ? task.version : 1;
  return current + 1;
}

/**
 * Evaluates an optional expected-version guard supplied via a body
 * `expected_version` field or an `If-Match` header (Etag-style bare int).
 * Returns a 409 version-conflict payload when the supplied version differs
 * from the task's current version, or `null` when no guard was supplied so
 * callers that omit a version keep working unchanged.
 *
 * The conflict error reads "Version mismatch" so it is distinguishable from
 * the claim-contention 409 ("… already claimed by …"): a version conflict is a
 * *stale read* while a contention conflict is *lost a race the caller knew
 * about*. Both carry a details object with the current vs. supplied version.
 */
function versionConflict(task, rawExpected) {
  if (rawExpected === undefined || rawExpected === null || rawExpected === '') return null;
  const current = Number.isInteger(task.version) ? task.version : 1;
  const provided = Number(rawExpected);
  if (Number.isNaN(provided) || provided !== current) {
    return {
      error: 'Version mismatch',
      status: 409,
      details: { expected: current, provided: Number.isNaN(provided) ? rawExpected : provided },
    };
  }
  return null;
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
    if (!Number.isInteger(data.round) || data.round < 1) {
      return { error: 'round must be a positive integer', status: 400 };
    }

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
      issues: Array.isArray(data.issues) ? data.issues : [],
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

      // §2.6: enforce the expected-version guard BEFORE building the candidate
      // so a stale read rejects without touching storage. The route injects the
      // If-Match header as `patch.expected_version`; a body-supplied field is
      // equivalent. A "Version mismatch" 409 is distinct from a claim-contention
      // 409 ("… already claimed by …").
    const conflict = versionConflict(task, patch.expected_version);
    if (conflict) return conflict;

    const candidate = structuredClone(task);
    const role = caller.role || patch.role || null;
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
      // that contract. Any entry into BUILDING / IN_REVIEW / IN_TEST is gated
      // here, so PATCH and claim agree on what may go active. Transitions
      // within/through DONE, BLOCKED and BACKLOG stay ungated: unblocking
      // (maybeUnlockDependentsInner) and backtracking are lock-internal or
      // non-claiming moves.
      if (
        nextStatus === STATUSES.BUILDING ||
        nextStatus === STATUSES.IN_REVIEW ||
        nextStatus === STATUSES.IN_TEST
      ) {
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
      // real change (nextStatus !== wasStatus) and only for the four active
      // stages. `assigned_agent` stays the lease holder — this is a per-stage
      // provenance map, not a reassignment.
      const actor = caller?.agent_id || caller?.agentId || null;
      if (
        nextStatus !== wasStatus &&
        actor &&
        (nextStatus === STATUSES.BUILDING ||
          nextStatus === STATUSES.IN_REVIEW ||
          nextStatus === STATUSES.IN_TEST ||
          nextStatus === STATUSES.DONE)
      ) {
        const owners = candidate.stage_owners && typeof candidate.stage_owners === 'object'
          ? candidate.stage_owners
          : {};
        candidate.stage_owners = { ...owners, [nextStatus]: actor };
      }
     }

     // §2.8: anchor completion time on the transition into DONE.
    if (candidate.status === STATUSES.DONE && !candidate.completed_at) {
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
          candidate[key] = toBranch(patch[key]);
        } else if (key === 'milestone') {
          // v2.11.0 (opt-milestones): same shared rule as branch — a non-empty
          // string is kept verbatim, `milestone: null` clears it, and anything
          // else (number/object/blank) becomes null rather than a bogus label.
          candidate[key] = toMilestone(patch[key]);
        } else if (key === 'depends_on') {
          // BUG-05 (v2.5.8): same shape rule as createTask — a bare string is
          // rejected rather than silently dropped.
          const dependsOnError = validateDependsOn(patch[key]);
          if (dependsOnError) return { error: dependsOnError, status: 400 };
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
        } else {
          candidate[key] = patch[key];
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
        await maybeUnlockDependentsInner(candidate.id, Date.now());
       } catch (err) {
        console.error('[kanban] auto-promote unlock failed:', err && err.message);
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
  validatePriority,
  MAX_TITLE_LEN,
  MAX_DESCRIPTION_LEN,
  MAX_METADATA_BYTES,
  validateDependsOn,
  validateMetadata,
  priorityRank,
} from './task-fields.js';
export {
  PRIVILEGED_ROLE_SET,
  isPrivilegedRole,
  validatePriority,
  MAX_TITLE_LEN,
  MAX_DESCRIPTION_LEN,
  MAX_METADATA_BYTES,
  validateDependsOn,
  validateMetadata,
  priorityRank,
};

/**
 * BUG-03 (v2.5.8): statuses a client may NOT create directly. These are work
 * states whose only legitimate entry is a claim (BUILDING) or a role-gated
 * transition. BACKLOG is the normal create status and BLOCKED is a parking
 * state, so both stay open to unprivileged creation.
 */
const IMPORT_GATED_STATUSES = new Set([
  STATUSES.BUILDING,
  STATUSES.IN_REVIEW,
  STATUSES.IN_TEST,
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
    const depTask = getTask(dep, task.project);
    if (!depTask || depTask.status !== STATUSES.DONE) unresolved.push(dep);
  }
  return { ok: unresolved.length === 0, unresolved };
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
 *      BACKLOG → BUILDING, seed reclaim_count, push the claim log, persist.
 *
 * Pass `{ renew: true }` for a lease renewal: skip contention when the caller is
 * privileged (they may renew any lease), skip the dependency gate (the lease was
 * earned at a satisfied gate), do not move status, and push no log (no spam).
 */
async function applyClaim(task, agentId, caller, nowMs, { renew = false, leaseMs = null, leaseExplicit = false } = {}) {
  const role = caller?.role || null;
  const isPriv = isPrivilegedRole(role);

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
  if (!renew && candidate.status === STATUSES.BACKLOG) {
    candidate.status = STATUSES.BUILDING;
    // §2.x: the fresh claim promotes BACKLOG → BUILDING; record the builder as
    // the stage owner for BUILDING (the lease holder stays in `assigned_agent`).
    const owners = candidate.stage_owners && typeof candidate.stage_owners === 'object'
      ? candidate.stage_owners
      : {};
    candidate.stage_owners = { ...owners, BUILDING: agentId };
  }
  candidate.updated = isoFromMs(nowMs);
  candidate.version = nextVersionFor(task);
  if (!renew) {
    // E-1: a fresh claim is progress on THIS card specifically — distinct from
    // the lease-window renewal above, which only proves the AGENT is alive.
    // Never set by a sibling renewal (renewAllLeasesInner does not touch it).
    candidate.last_progress_at = candidate.updated;
  }
  if (!Array.isArray(candidate.agent_logs)) candidate.agent_logs = [];
  if (!renew) {
    candidate.agent_logs.push({
      timestamp: candidate.updated,
      message: `${agentId} claimed this task.`,
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
        r.catch((err) => console.error('[kanban] completion hook rejected:', err && err.message));
      }
    } catch (err) {
      console.error('[kanban] completion hook error:', err && err.message);
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
  candidate.status = STATUSES.BACKLOG;
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
async function maybeUnlockDependentsInner(completedRef, nowMs) {
  const unblocked = [];
  for (const t of tasks.slice()) {
    if (t.status !== STATUSES.BLOCKED) continue;
    const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
    if (!deps.includes(completedRef)) continue;
      // Only unlock when *every* dep is now DONE (the last-dep-completes case).
    if (!dependencyGate(t).ok) continue;
    const r = await unlockTaskInner(t, nowMs, completedRef);
    if (!r.error) unblocked.push(t.id);
    }
  // Each unlock fired its own semantic event inside unlockTaskInner; this
     // extra snapshot notify is a no-op re-broadcast so downstream listeners
     // see the whole set in one tick.
  notify({ actor: 'system', reason: 'unblocked_batch' });
  return { unblocked };
}

/**
 * §2.5 maybeUnlockDependents — lock-wrapped, idempotent. Finds BLOCKED tasks
 * whose `completedRef` is a dependency and whose deps are now all DONE, and
 * unblocks them (clears owner + lease). Re-running finds no matching BLOCKED
 * task, so it is safe to call repeatedly.
 */
export async function maybeUnlockDependents(completedRef, { now } = {}) {
  return withMutationLock(async () => {
    const nowMs = typeof now === 'number' ? now : nowFn();
    return maybeUnlockDependentsInner(completedRef, nowMs);
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

       // A non-privileged caller must be the current holder.
    if (!isPrivilegedRole(caller.role) && task.assigned_agent !== agentId) {
      return { error: 'Caller is not the lease holder', status: 409, reason: 'not_lease_holder' };
     }

       // Shared core in renew mode: extends the lease, no status move, no log.
    const lease = resolveLeaseMs(requestedLease);
    if (!lease.ok) return { error: lease.error, status: lease.status };
    return applyClaim(task, agentId, caller, nowFn(), { renew: true, leaseMs: requestedLease === undefined || requestedLease === null ? null : lease.ms });
       });
       }

/**
 * §2.4b bulk lease renewal (v2.12.0, RC-2). An orchestrator that holds N tasks
 * previously had to make N heartbeat calls, one per card; missing even one while
 * a long job ran let the reaper return that card to BACKLOG as a false alarm.
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
async function renewAllLeasesInner(agentId, nowMs, { excludeKey = null, project = null } = {}) {
  if (!agentId || typeof agentId !== 'string') return [];
  const renewed = [];
  for (const t of tasks.slice()) {
    if (excludeKey !== null && compositeKey(t.project, t.id) === excludeKey) continue;
    if (project !== null && t.project !== project) continue;
    if (t.assigned_agent !== agentId) continue;
    if (
      t.status !== STATUSES.BUILDING &&
      t.status !== STATUSES.IN_REVIEW &&
      t.status !== STATUSES.IN_TEST
    ) {
      continue;
    }
    const expiresMs = t.claim_expires_at ? Date.parse(t.claim_expires_at) : NaN;
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) continue;
    try {
      const candidate = structuredClone(t);
      candidate.claim_expires_at = isoFromMs(nowMs + leaseWindowFor(candidate));
      candidate.updated = isoFromMs(nowMs);
      const storage = getStorage(candidate.project);
      await storage.saveTask(candidate, projectBucket(candidate.project, candidate));
      updateInMemoryTask(candidate);
      renewed.push(compositeKey(candidate.project, candidate.id));
    } catch (err) {
      // I-6: never let a sibling's save failure fail the caller's real write.
      console.error(
        `[kanban] sibling lease renewal failed for ${compositeKey(t.project, t.id)}:`,
        err && err.message,
      );
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
 * stage it lands in, and — like a claim — lifts a BACKLOG card to BUILDING so
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
      // normalise it anyway) — return it to BACKLOG so it is claimable again.
      if (
        candidate.status === STATUSES.BUILDING ||
        candidate.status === STATUSES.IN_REVIEW ||
        candidate.status === STATUSES.IN_TEST
      ) {
        candidate.status = STATUSES.BACKLOG;
      }
    } else {
      candidate.assigned_agent = agentId;
      // Keep the card's own window if it had one; otherwise pin the global TTL.
      candidate.claim_lease_ms = leaseWindowFor(candidate);
      candidate.claim_expires_at = isoFromMs(nowMs + candidate.claim_lease_ms);
      if (!Number.isInteger(candidate.reclaim_count)) candidate.reclaim_count = 0;
      if (candidate.status === STATUSES.BACKLOG) {
        candidate.status = STATUSES.BUILDING;
        const owners = candidate.stage_owners && typeof candidate.stage_owners === 'object'
          ? candidate.stage_owners
          : {};
        candidate.stage_owners = { ...owners, BUILDING: agentId };
      }
    }
    candidate.updated = isoFromMs(nowMs);
    candidate.version = nextVersionFor(task);
    if (!Array.isArray(candidate.agent_logs)) candidate.agent_logs = [];
    const actor = caller?.agent_id || caller?.agentId || 'operator';
    candidate.agent_logs.push({
      timestamp: candidate.updated,
      message: release
        ? `Assignment cleared by ${actor} (released to BACKLOG).`
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

       // ---------------------------------------------------------------------------
       // §2.4 stale-task reaper
       // ---------------------------------------------------------------------------

       /**
       * reclaimTask inner — a DOCUMENTED SYSTEM OVERRIDE (like the §2.5 unlock). It
       * forces an active claim (BUILDING / IN_REVIEW / IN_TEST) back to BACKLOG, which
       * is NOT a legal agent transition per canTransition (those states have no
       * → BACKLOG edge). The reaper is ownerless and exempt from the agent state
       * machine; this is the single sanctioned place that exemption exists. Clears
       * owner + lease, bumps reclaim_count, and logs the reclaim. Persist-first →
       * in-memory → notify (KB-05 fail-closed): a storage failure leaves the active
       * claim untouched.
       *
       * UNLOCKED: the caller must already hold the mutation lock. This is required
       * because reapExpiredClaims (a single locked sweep) calls it per-task; a
       * promise-queue lock cannot safely re-enter itself, so the reclaim body is
       * kept out of withMutationLock and the public reclaimTask wrapper supplies the
       * one lock.
       */
  async function reclaimTaskInner(task, { reason = 'lease_expired', nowMs } = {}) {
    const activeStatus = task.status === STATUSES.BUILDING
      || task.status === STATUSES.IN_REVIEW
      || task.status === STATUSES.IN_TEST;
    if (!task.assigned_agent && !activeStatus) {
      // Not currently held and not active — nothing to reclaim. Idempotent.
      return { task, status: 200, reclaimed: false };
    }
    const fromAgent = task.assigned_agent;
    const candidate = structuredClone(task);
    candidate.status = STATUSES.BACKLOG;
    candidate.assigned_agent = null;
    candidate.claim_expires_at = null;
    candidate.claim_lease_ms = null;
    candidate.reclaim_count = (Number.isInteger(task.reclaim_count) ? task.reclaim_count : 0) + 1;
    candidate.updated = isoFromMs(nowMs);
    candidate.version = nextVersionFor(task);
    if (!Array.isArray(candidate.agent_logs)) candidate.agent_logs = [];
    candidate.agent_logs.push({
      timestamp: candidate.updated,
         message: !fromAgent
          ? 'Task had no owner — reclaimed to BACKLOG by system normalizer.'
          : (reason === 'lease_expired'
           ? 'LEASE EXPIRED — task reclaimed to BACKLOG by system reaper.'
           : `Task reclaimed to BACKLOG by system (${reason}).`),
         agent_id: 'system',
         reason: !fromAgent ? reason : 'lease_expired',
         reclaimed_from: fromAgent,
         });

         // KB-05: persist first, then mutate memory, then notify.
         await getStorage(candidate.project).saveTask(candidate, projectBucket(candidate.project, candidate));
         updateInMemoryTask(candidate);
         // §2.2/§2.9: surface a semantic 'reclaimed' event + audit who/why.
         notify({
         actor: 'system',
         reason: reason,
         semantic: new Map([[
           compositeKey(candidate.project, candidate.id),
           { kind: 'reclaimed', actor: 'system', reason, prevTask: task },
           ]]),
           });
         return { task: candidate, status: 200, reclaimed: true, reclaimed_from: fromAgent };
         }

        /**
        * reclaimTask(id, { reason, now }) — public, lock-wrapped reclaim. Delegates
        * to the unlocked inner so a caller that is already inside the lock
        * (reapExpiredClaims) does not deadlock on the promise-queue lock.
        */
       export async function reclaimTask(id, { reason = 'lease_expired', now, project } = {}) {
       return withMutationLock(async () => {
        const task = getTask(id, project);
        if (!task) return { error: 'Task not found', status: 404 };
        const nowMs = typeof now === 'number' ? now : nowFn();
        return reclaimTaskInner(task, { reason, nowMs });
         });
       }

       /**
       * reapExpiredClaims — sweep active claims whose lease has expired and reclaim
       * them. Runs in the mutation lock so it is serialized with every other writer
       * (a heartbeat that lands first commits before the sweep sees a fresh expiry).
       * `now` is injectable so tests can force expiry. Returns the reclaimed ids.
       * Calls the UNLOCKED reclaimTaskInner directly (it already holds the lock).
       */
       export async function reapExpiredClaims({ now } = {}) {
       return withMutationLock(async () => {
       const nowMs = typeof now === 'number' ? now : nowFn();
       const candidates = tasks.filter((t) => {
        const active = t.status === STATUSES.BUILDING
        || t.status === STATUSES.IN_REVIEW
        || t.status === STATUSES.IN_TEST;
       if (!active) return false;
      if (t.assigned_agent === null || t.claim_expires_at === null || t.claim_expires_at === undefined) {
        // Orphan: active with no owner/lease. Normally this is a status-only
        // PATCH that has not yet been claimed — a legitimate intermediate state,
        // not a stuck card. Only reclaim once it has been untouched for the
        // grace window, so a freshly-written card survives the next sweep.
        const graceMs = getOrphanGraceMs();
        if (graceMs <= 0) return true;
        const touchedMs = Date.parse(t.updated);
        if (Number.isNaN(touchedMs)) return true;
        return nowMs - touchedMs >= graceMs;
        }
       const expiresMs = Date.parse(t.claim_expires_at);
        if (Number.isNaN(expiresMs)) return false;
        return expiresMs <= nowMs;
         });
       let reclaimed = 0;
       const ids = [];
       for (const t of candidates) {
         // getTask MUST be given the candidate's own project: task ids are unique
         // only within a project, so the 1-arg form resolves against `default` and
         // either returns null (throwing, aborting the whole sweep) or — when the
         // same short id exists in `default` — reclaims the wrong task.
         const task = getTask(t.id, t.project);
         const reason = (task.assigned_agent === null || task.claim_expires_at == null)
          ? 'orphan_normalized'
          : 'lease_expired';
         const r = await reclaimTaskInner(task, { reason, nowMs });
         if (r && r.reclaimed) {
           reclaimed += 1;
           ids.push(compositeKey(t.project, t.id));
            }
           }
           if (reclaimed > 0) notify();
           return { reclaimed: ids, now: nowMs };
           });
       }

       /**
       * §2.7 nextClaim — atomically select the highest-priority, unclaimed,
       * dependency-satisfied BACKLOG task and claim it for `agentId`, all inside one
       * mutation-lock critical section. Priority order: high < medium < low, tie-broke
       * by creation order (array index, FIFO), then by id for total determinism.
       *
       * Only BACKLOG + unclaimed + gate-passing tasks are candidates, so the winner
       * never hits a dependency 409. Two concurrent calls get distinct winners (the
       * first claims it → the second sees it held and skips it). No 409 storm.
       *
       * Returns `{ task, status: 200 }` on a claim, or `{ unavailable: true,
       * status: 204 }` when nothing is claimable (a cheap poll target for agents).
       */
       export async function nextClaim({ agentId, role, project, now, lease_ms: requestedLease } = {}) {
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
         if (t.status !== STATUSES.BACKLOG) return false;
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
       const r = await applyClaim(winner, agentId, role ? { role } : {}, nowMs, { leaseMs: lease.ms, leaseExplicit: lease.explicit });
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
function spillDir(project) {
  return path.join(jsonDataDir(), 'spill', project || defaultProjectName());
}

function spillFile(project, taskId) {
  return path.join(spillDir(project), `${taskId}.jsonl`);
}

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
    console.warn(`[kanban spill] read error for ${project}/${taskId}: ${err.message}`);
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
  const spilled_count = await countSpill(task.project, id);
  let entries = [];
  if (include_spilled) {
    const allSpilled = await readSpill(task.project, id);
    entries = allSpilled;
  } else {
    const allSpilled = await readSpill(task.project, id);
    entries = allSpilled.slice(offset, offset + limit);
  }
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

        // §2.6: enforce the version guard before building the candidate.
    const conflict = versionConflict(task, expectedVersion);
    if (conflict) return conflict;

    const safeIssueId = escapeHtml(issueId);

    const candidate = structuredClone(task);
    if (!Array.isArray(candidate.issues)) {
      candidate.issues = [];
      }
    if (!candidate.issues.includes(safeIssueId)) {
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
export async function runArchiveSweep() {
  return withMutationLock(async () => {
    // v2.5.6: the trash-retention sweep rides the same cadence (any read path
    // that sweeps the archive also ages out the trash sink). Called via the
    // UNLOCKED inner — runArchiveSweep already holds the lock; awaiting the
    // locked wrapper here would deadlock the non-reentrant promise chain.
    await runTrashSweepInner();
    const days = getArchiveAfterDays();
    if (days === 0) return 0;

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

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
      const eligible = (liveList || []).filter((t) => isEligibleForArchive(t, days, nowMs));
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
        // Live partition rewrite: the project had live rows, so the dropped
        // ones must be reflected on disk. (Archive-only projects hit the
        // early return above and never reach this branch.)
        const survivors = (liveList || []).filter((t) => !eligibleIds.has(t.id));
        await storage.save(survivors);
        // Archive sink rewrite is gated on a real move (FIX 3): no churn when
        // this project moved nothing, and we merge onto any existing rows.
        const merged = [...(archive[project] || []), ...newArchived];
        await storage.saveArchive(merged);
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
      await runFor(project, liveList);
     }

    // A project whose only record is an archive list is re-processed here, but
    // the early return in runFor makes it a no-op unless it actually has
    // eligible rows to move (so no archive sink churn when nothing moved).
    for (const project of Object.keys(archive)) {
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

// ---------------------------------------------------------------------------
// Admin delete & bulk purge (§admin-purge)
// ---------------------------------------------------------------------------

/**
 * SEC-02 (v2.5.2): destructive operations are gated on a privilege flag the
 * auth middleware DERIVES from the credential, never on the caller-asserted
 * `X-Agent-Role` header alone. When the middleware stamped a flag, it wins;
 * direct store callers (unit tests, legacy middleware) fall back to the role
 * check so single-token deployments keep their historical semantics.
 */
function destructivePrivilege(caller) {
  return callerIsPrivileged(caller);
}

/**
 * v2.12.1 (I-4): shared credential-derived privilege check, extracted from
 * `destructivePrivilege` so the bulk-heartbeat route (and any other caller)
 * can use the SAME rule instead of trusting the self-asserted `X-Agent-Role`
 * header directly. A per-project token cannot send itself `X-Agent-Role:
 * admin` and pass this check — the auth middleware sets `caller.privileged`
 * from the credential itself (see middleware/auth.js), and that flag wins
 * whenever it is present.
 */
export function callerIsPrivileged(caller) {
  return caller.privileged === undefined || caller.privileged === null
    ? isPrivilegedRole(caller.role)
    : caller.privileged === true;
}

/**
 * Admin-only delete of a single task. Persists FIRST (fail-closed, KB-05):
 * the JSON backend rewrites the project partition minus this task; the Git
 * backend git-rms the card file + commits. Only then is the task dropped from
 * memory. Requires a privileged credential (see destructivePrivilege).
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

    if (!destructivePrivilege(caller)) {
      return { error: 'Forbidden: admin role required to delete tasks', status: 403 };
    }

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
      await storage.trashTask(task);
    } else {
      const survivors = getProjectBucket(task.project).filter((t) => t.id !== task.id);
      await storage.save(survivors);
      const sink = [...(trash[task.project] || []), trashed];
      await storage.saveTrash(sink);
    }

    trash[task.project] = [...(trash[task.project] || []), trashed];
    removeFromMemory(task.project, task.id);
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
    if (!destructivePrivilege(caller)) {
      return { error: 'Forbidden: admin role required to delete tasks', status: 403 };
    }

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
      } else {
        // Soft-delete: park each row in the trash sink (persist-first), then
        // drop it from the live partition.
        const deletedAt = new Date(nowFn()).toISOString();
        if (storage instanceof GitYamlStorage) {
          for (const t of list) {
            await storage.trashTask(t);
          }
        } else {
          const deleteIds = new Set(list.map((t) => t.id));
          const survivors = getProjectBucket(p).filter((t) => !deleteIds.has(t.id));
          await storage.save(survivors);
          const sink = [
            ...(trash[p] || []),
            ...list.map((t) => Object.assign(structuredClone(t), {
              deleted_at: deletedAt,
              deleted_by: caller.agent_id || 'admin',
              version: nextVersionFor(t),
            })),
          ];
          await storage.saveTrash(sink);
        }
        trash[p] = [
          ...(trash[p] || []),
          ...list.map((t) => Object.assign(structuredClone(t), {
            deleted_at: deletedAt,
            deleted_by: caller.agent_id || 'admin',
            version: nextVersionFor(t),
          })),
        ];
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

// ---------------------------------------------------------------------------
// v2.5.6 (ENH-03): soft-delete trash sink. deleteTask/purgeTasks route into
// `trash` (a per-project sink beside the archive) instead of destroying data;
// restore returns a card to BACKLOG; a sweep hard-deletes rows older than
// KANBAN_TRASH_DAYS (default 30). `purgeTasks({hard:true})` bypasses the sink
// for true permanent deletion.
// ---------------------------------------------------------------------------

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

async function trashPersistRemove(project, removedTask) {
  const storage = getStorage(project);
  const remaining = (trash[project] || []).filter((t) => t.id !== removedTask.id);
  if (storage instanceof GitYamlStorage) {
    await storage.trashRemove(removedTask);
  } else {
    await storage.saveTrash(remaining);
  }
  if (remaining.length === 0) delete trash[project];
  else trash[project] = remaining;
}

/**
 * Admin-only restore of a soft-deleted task back to the live board (BACKLOG).
 * Persists FIRST (KB-05): the live partition gains the restored card and the
 * trash sink loses it, both before memory mutates.
 */
export async function restoreFromTrash(id, { caller = {}, project } = {}) {
  return withMutationLock(async () => {
    const authorizedProject =
      project === undefined || project === null || project === ''
        ? defaultProjectName()
        : project;
    const trashed = trashFind(authorizedProject, id);
    if (!trashed) return { error: 'Task not found in trash', status: 404 };

    if (index.has(compositeKey(authorizedProject, id))) {
      return { error: 'A live task with this id already exists', status: 409 };
    }

    const restored = structuredClone(trashed);
    restored.status = STATUSES.BACKLOG;
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
      await storage.saveTask(restored);
      await storage.trashRemove(trashed);
    } else {
      await storage.saveTask(restored, getProjectBucket(authorizedProject));
      await trashPersistRemove(authorizedProject, trashed);
    }

    updateInMemoryTask(restored);
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
    if (!destructivePrivilege(caller)) {
      return { error: 'Forbidden: admin role required to delete tasks', status: 403 };
    }
    const authorizedProject =
      project === undefined || project === null || project === ''
        ? defaultProjectName()
        : project;
    const trashed = trashFind(authorizedProject, id);
    if (!trashed) return { error: 'Task not found in trash', status: 404 };
    await trashPersistRemove(authorizedProject, trashed);
    notify({
      actor: caller.agent_id || 'admin',
      reason: 'purged_from_trash',
      semantic: new Map([[
        compositeKey(authorizedProject, id),
        { kind: 'deleted', actor: caller.agent_id || 'admin', reason: 'purged_from_trash', task: trashed },
      ]]),
    });
    return { task: trashed, status: 200 };
  });
}

/**
 * Trash retention sweep: hard-deletes sink rows older than
 * KANBAN_TRASH_DAYS (default 30). Runs inside the existing archive sweep
 * cadence (GET /archive, GET /tasks, GET /metrics all sweep first).
 *
 * Lock discipline (mirrors reclaimTaskInner/public reclaimTask): the inner
 * function does the work WITHOUT acquiring the mutation lock, so
 * runArchiveSweep — which already holds the lock — can call it directly.
 * The exported wrapper acquires the lock for standalone callers.
 */
async function runTrashSweepInner() {
  const days = getTrashDays();
  if (days <= 0) return { purged: [], now: Date.now() };
  const nowMs = Date.now();
  const purged = [];
  for (const [project, list] of Object.entries(trash)) {
    const expired = list.filter((t) => {
      const anchor = t.deleted_at || t.updated || t.created_at;
      if (!anchor) return false;
      const age = nowMs - Date.parse(anchor);
      return !Number.isNaN(age) && age >= days * 86400000;
    });
    for (const t of expired) {
      await trashPersistRemove(project, t);
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

// Re-export for convenience / tests
export { defaultProjectName as getDefaultProject };

// ---------------------------------------------------------------------------
// §2.4 reaper timer — started ONLY in startServer (never in createApp, so the
// HTTP-contract tests never spawn a timer). The timer is unref()'d so an idle
// process can still exit, and startReaper/stopReaper let a caller control it.
// ---------------------------------------------------------------------------
let reapTimer = null;

export function startReaper() {
  if (reapTimer) return reapTimer;
  reapTimer = setInterval(() => {
     // Fire-and-forget; the lock serializes it with the other writers. Swallow
     // so a sweep throw can never kill the interval or the process.
    reapExpiredClaims().catch((err) => {
      console.error('[kanban reaper] sweep failed:', err && err.message);
     });
   }, getReapIntervalMs());
      // An unref'd timer must not keep a (possibly test-driven) process alive.
    reapTimer.unref();
    console.log(`[kanban reaper] started (interval=${getReapIntervalMs()}ms)`);
    return reapTimer;
   }

export function stopReaper() {
  if (reapTimer) {
    clearInterval(reapTimer);
    reapTimer = null;
    return true;
   }
  return false;
}

export function isReaperRunning() {
  return reapTimer !== null;
}

// ---------------------------------------------------------------------------
// §2.7 periodic backup — opt-in snapshot of the live JSON data file(s) into a
// sibling `backups/` directory, rotated to a bounded count. OFF unless
// KANBAN_BACKUP_ENABLED is set. Read-only: never takes the mutation lock.
// ---------------------------------------------------------------------------
function getBackupIntervalMs() {
  const raw = process.env.KANBAN_BACKUP_INTERVAL_MS;
  if (raw === undefined || raw === '') return 600000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 600000;
}

function getBackupKeep() {
  const raw = process.env.KANBAN_BACKUP_KEEP;
  if (raw === undefined || raw === '') return 10;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10;
}

function isBackupEnabled() {
  const raw = process.env.KANBAN_BACKUP_ENABLED;
  if (raw === undefined || raw === '') return false;
  return raw !== 'false' && raw !== '0';
}

function sanitizeTimestamp(iso) {
  return iso.replace(/[:.]/g, '-');
}

function backupSourceDir() {
  if (process.env.KANBAN_DATA_DIR) return process.env.KANBAN_DATA_DIR;
  const defaultLive = process.env.KANBAN_DATA_FILE || path.join(__dirname, 'tasks.json');
  return path.dirname(defaultLive);
}

function defaultBackupRoot() {
  return path.join(backupSourceDir(), 'backups');
}

async function runBackup() {
  const root = defaultBackupRoot();
  const stamp = sanitizeTimestamp(new Date().toISOString());
  const destDir = path.join(root, stamp);
  await mkdir(destDir, { recursive: true });

  const dataDir = process.env.KANBAN_DATA_DIR;
  if (dataDir && existsSync(dataDir)) {
    await copyDirTree(dataDir, destDir);
  } else {
    const defaultLive = process.env.KANBAN_DATA_FILE || path.join(__dirname, 'tasks.json');
    if (existsSync(defaultLive)) {
      await copyFile(defaultLive, path.join(destDir, path.basename(defaultLive)));
    }
    const jsonDir = jsonDataDir();
    const tasksDir = path.join(jsonDir, 'tasks');
    const archiveDir = path.join(jsonDir, 'archive');
    if (existsSync(tasksDir)) await copyDirTree(tasksDir, path.join(destDir, 'tasks'));
    if (existsSync(archiveDir)) await copyDirTree(archiveDir, path.join(destDir, 'archive'));
  }

  await rotateBackups(root);
}

async function copyDirTree(src, dest) {
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'backups') continue;
      await copyDirTree(s, d);
    } else {
      await copyFile(s, d);
    }
  }
}

async function rotateBackups(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const stamps = entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  const keep = getBackupKeep();
  for (const stale of stamps.slice(keep)) {
    await rm(path.join(root, stale), { recursive: true, force: true });
  }
}

let backupTimer = null;

export function startBackup() {
  if (backupTimer) return backupTimer;
  if (!isBackupEnabled()) return null;
  backupTimer = setInterval(() => {
    runBackup().catch((err) => {
      console.error('[kanban backup] run failed:', err && err.message);
    });
  }, getBackupIntervalMs());
  backupTimer.unref();
  console.log(`[kanban backup] started (interval=${getBackupIntervalMs()}ms, keep=${getBackupKeep()})`);
  return backupTimer;
}

export function stopBackup() {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
    return true;
  }
  return false;
}

export function isBackupRunning() {
  return backupTimer !== null;
}

export async function runBackupNow() {
  await runBackup();
}

/**
 * Backup observability for /api/health (ENH-02, v2.5.5). Reports the current
 * config, whether the timer is running, and the freshest snapshot on disk so
 * operators can verify snapshots are actually happening without shelling into
 * the container. Read-only; never touches the mutation lock.
 */
export function backupStatus() {
  const enabled = isBackupEnabled();
  const root = defaultBackupRoot();
  let lastBackupAt = null;
  let backupCount = 0;
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(e.name))
      .map((e) => e.name)
      .sort();
    backupCount = entries.length;
    if (entries.length > 0) {
      // Stamp format is an ISO timestamp with : and . replaced by -, so the
      // freshest snapshot sorts last lexicographically.
      const stamp = entries[entries.length - 1];
      const iso = stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z');
      const parsed = Date.parse(iso);
      lastBackupAt = Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
    }
  } catch {
    // No backups directory yet: count stays 0, last stays null.
  }
  return {
    enabled,
    running: isBackupRunning(),
    interval_ms: getBackupIntervalMs(),
    keep: getBackupKeep(),
    backup_root: root,
    backup_count: backupCount,
    last_backup_at: lastBackupAt,
  };
}
