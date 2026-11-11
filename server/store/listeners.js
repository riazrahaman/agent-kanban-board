/**
 * C1 (v3.12.5) — the store's four listener buses: full-snapshot (`onChange`),
 * structured diff (`onDiff`), audit (`onAudit`) and settings (`onSettings`).
 *
 * These own their listener arrays and the previous-snapshot map; they READ the
 * live task array from ./core.js. Extracted verbatim from store.js — the only
 * edits are the imports and the mutation-serial bump going through core's
 * setter, so the SSE/notifier event stream is byte-identical.
 */
import { tasks, compositeKey, bumpMutationSerial } from './core.js';
import { createLogger, logError } from '../logger.js';

const log = createLogger(null);

// §2.2 diff-event layer: on each notify(), compute created/updated/removed vs the
// previous snapshot, then dispatch {kind, task, prev?, project} events to
// diffListeners. Backward-compat: full-snapshot `onChange` listeners still see
// every mutation, unmodified.
let listeners = [];
let diffListeners = [];
let settingsListeners = [];
let prevTaskMap = new Map(); // `${project}/${id}` -> Task (previous snapshot)
let diffListenersInitialized = false;

// §2.2 diff-event layer: on each notify(), compute created/updated/removed vs the
// previous snapshot, then dispatch {kind, task, prev?, project} events to
// diffListeners. Backward-compat: full-snapshot `onChange` listeners still see
// every mutation, unmodified.

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
      logError('audit', 'listener error', { error: err });
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
        logError('diff', 'listener error', { error: err });
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
  // Deep-review: counts every committed mutation batch, so the archive sweep
  // can skip itself only when NOTHING has changed since its last pass.
  bumpMutationSerial();
  const snapshot = tasks;
   for (const listener of listeners) {
    try {
      listener(snapshot);
      } catch (err) {
       log.error('listener error', { error: err });
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

export function onSettings(listener) {
  settingsListeners.push(listener);
  return () => {
    settingsListeners = settingsListeners.filter((l) => l !== listener);
  };
}

export function settingsListenerCount() {
  return settingsListeners.length;
}

export function emitSettings(project, settings) {
  for (const listener of [...settingsListeners]) {
    try {
      listener({ project, settings });
    } catch (err) {
      log.error('settings listener error', { error: err });
    }
  }
}

