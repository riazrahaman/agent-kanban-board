import { Router } from 'express';
import * as store from '../store.js';
import { logWarn } from '../logger.js';
import {
  IDEMPOTENCY_MAX_KEY_LENGTH,
  beginIdempotentCreate,
  callerNamespace,
  completeIdempotentCreate,
  failIdempotentCreate,
} from '../idempotency.js';
import { VALID_ROLES, getAuthorizedProjects } from '../middleware/auth.js';
import { projectScopeGuard } from '../middleware/projectScope.js';

const router = Router();

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * §2.1 project resolution order:
 *   ?project= query > ?workspace= alias > X-Kanban-Project header
 * An empty/invalid value yields undefined so the caller falls back to the
 * task's own project or the default.
 */
function resolveProjectFromReq(req) {
  const raw =
    req.query?.project ??
    req.query?.workspace ??
    req.headers['x-kanban-project'];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'string' && store.isValidProjectId(raw)) return raw;
  return undefined;
}

/**
 * §2.6: resolve the expected-version guard for a mutation. A body
 * `expected_version` takes precedence; otherwise an `If-Match` header is used.
 * Returns `{ expected_version }` so the store runs the CAS check; returns
 * `null` when no guard was supplied.
 *
 * RFC 7232 §3.1: an `If-Match` value is a list of entity-tags — `"5"`,
 * weak `W/"5"`, or `*` — and the board's validators are plain version
 * integers. Passing the raw header to the store made `Number('"5"')` NaN, so
 * a spec-conformant client (or a proxy echoing an ETag) got a permanent 409.
 * Strip the weak prefix and the surrounding quotes; `*` means "any current
 * representation", i.e. no version precondition. Only the version number is
 * meaningful here — an ETag's payload is never interpreted.
 *
 * Documented contract for a list: only the FIRST tag is authoritative (a
 * conditional request against one resource is answered by one entity-tag);
 * later entries are ignored and never fall back. `"2", "9"` therefore matches
 * version 2; `"9", "2"` is a 409 echoing `9`.
 *
 * Only an ABSENT header (or `*`) may mean "no precondition". Every present,
 * non-`*` value reaches the CAS guard, including an empty entity-tag:
 * `If-Match: ""` and `W/""` are syntactically valid tags that match no
 * representation, so they must 409 — folding them into "absent" silently
 * disabled the guard (a lost-update bug, C5 regression).
 */
function parseIfMatchVersion(header) {
  if (header === undefined || header === null) return undefined;
  // Express may surface the header as an array on repeated names; coerce.
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return raw;
  // First tag only; a later entry never rescues an unmatched first one.
  let value = raw.split(',')[0].trim();
  if (value === '*') return undefined;
  if (value.startsWith('W/')) value = value.slice(2).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1).trim();
    // `""` is an empty entity-tag, not an omitted precondition: keep the
    // quoted form so the CAS guard rejects it and echoes the validator.
    return inner === '' ? value : inner;
  }
  return value;
}

function resolveExpectedVersion(req) {
  const fromBody = req.body?.expected_version;
  if (fromBody !== undefined && fromBody !== null && fromBody !== '') {
    return { expected_version: fromBody };
  }
  const value = parseIfMatchVersion(req.headers['if-match']);
  if (value !== undefined) return { expected_version: value };
  return null;
}

// A supplied-but-invalid project scope is a client error, never a widening.
// Shared with the metrics router — see middleware/projectScope.js.
router.use(projectScopeGuard());

// --- Collection ---------------------------------------------------------

/**
 * Deep-review (auth P1/P2): read authorization used to be a boolean — a valid
 * credential was enough. With per-token isolation, the caller's AUTHORIZED
 * PROJECTS (attached by the middleware as req.caller.authorizedProjects) must
 * gate every read, not just list endpoints. It returns true when reads are open
 * (anonymous/admin/global/unscoped credentials ⇒ null) or the task's project is
 * inside the caller's allowed set.
 */
function readScopeAllows(req, taskProject) {
  const allowed = req.caller?.authorizedProjects;
  return !(allowed instanceof Set) || allowed.has(taskProject);
}

// --- Collection ---------------------------------------------------------

router.get('/', asyncHandler(async (req, res) => {
  // §2.8 lazy sweep before every list read.
  await store.runArchiveSweep({ lazy: true });
  const project = resolveProjectFromReq(req);
  const authorized = getAuthorizedProjects(req);

  if (authorized instanceof Set) {
    if (project) {
      if (!authorized.has(project)) return res.json([]);
      return res.json(store.getTasks(project));
    }
    return res.json(store.getTasks().filter((t) => authorized.has(t.project)));
  }

  res.json(store.getTasks(project));
}));

/**
 * D3 (v3.12.6): the project a create lands in, resolved the same order as
 * `store.createTask` (body.project > body.workspace_id > query/header >
 * board default). Used only to namespace the idempotency map, so two projects
 * that share a key never replay each other's card.
 */
function resolveCreateProject(ctx, body) {
  const raw = body.project ?? body.workspace_id ?? resolveProjectFromReq(ctx);
  if (raw === undefined || raw === null || raw === '') return store.getDefaultProject();
  return String(raw);
}

/**
 * POST /api/tasks - create a card.
 *
 * RETRY SAFETY (D3, v3.12.6): the caller-supplied `id` is itself a NATURAL
 * idempotency handle - a retry of a create that timed out after commit hits the
 * composite-id uniqueness check and gets 409 `already exists`, which is a false
 * failure for an operation that actually succeeded. For clients that want the
 * original response instead, send an `Idempotency-Key` header (Express/node
 * lowercases headers, so `Idempotency-Key` and `idempotency-key` are the same
 * header):
 *
 *   - the key is scoped to this project AND to the caller's identity (a
 *     SHA-256 fingerprint of the credential plus agent id + role), so two
 *     callers can never replay each other's response; the raw token is never
 *     stored. The key is retained for `KANBAN_IDEMPOTENCY_TTL_MS` (default
 *     10 min), capped at `KANBAN_IDEMPOTENCY_MAX_ENTRIES` (default 1000,
 *     oldest evicted first);
 *   - only successful creations (201) are recorded. A replay with the same
 *     key returns the ORIGINAL 201 body plus `Idempotency-Replayed: true`;
 *   - a duplicate arriving while the first request is still committing gets
 *     409 `{ error: 'idempotency_key_in_progress' }` - it is neither replayed
 *     (there is no body yet) nor allowed to double-create;
 *   - no header (or an empty one) is exactly the historical behaviour, and the
 *     only validation is a 200-character cap -> 400.
 *
 * Everything here is in-memory: a restart forgets the keys, which is why the
 * composite `id` remains the durable natural handle.
 */
router.post('/', asyncHandler(async (req, res) => {
  const body = req.body ?? {};
   // §2.1: project may arrive as body.project, body.workspace_id, or ?project=.
  const project = resolveProjectFromReq(req);
  const rawKey = req.headers['idempotency-key'];
  const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;

  const create = () => store.createTask(body, project, { caller: req.caller || {} });
  const respondToResult = (result) => {
    if (result.error) {
      logWarn('rejection', `POST /api/tasks: ${result.status} ${result.error}`);
      return res.status(result.status).json({ error: result.error, ...(result.reason ? { reason: result.reason } : {}) });
    }
    return res.status(201).json(result.task);
  };

  // Missing header -> unchanged behaviour (the `id` alone is the natural key).
  if (idempotencyKey === undefined || idempotencyKey === null || idempotencyKey === '') {
    return respondToResult(await create());
  }

  if (typeof idempotencyKey !== 'string' || idempotencyKey.length > IDEMPOTENCY_MAX_KEY_LENGTH) {
    return res.status(400).json({
      error: `Idempotency-Key must be at most ${IDEMPOTENCY_MAX_KEY_LENGTH} characters`,
    });
  }

  const namespace = callerNamespace(req, resolveCreateProject(req, body));
  const reservation = beginIdempotentCreate(namespace, idempotencyKey);
  if (reservation.state === 'replay') {
    res.set('Idempotency-Replayed', 'true');
    return res.status(201).json(reservation.body);
  }
  if (reservation.state === 'in_progress') {
    return res.status(409).json({ error: 'idempotency_key_in_progress' });
  }

  try {
    const result = await create();
    if (result.error) {
      // Nothing successful to replay: release the key so a corrected retry can
      // use it again.
      failIdempotentCreate(namespace, idempotencyKey);
      return respondToResult(result);
    }
    completeIdempotentCreate(namespace, idempotencyKey, result.task);
    return respondToResult(result);
  } catch (err) {
    failIdempotentCreate(namespace, idempotencyKey);
    throw err;
  }
}));

// --- §2.8 archive (MUST be declared before /:id so Express treats `archive`
//     as a static segment, not an :id match) ----------------------------

router.get('/archive', asyncHandler(async (req, res) => {
  await store.runArchiveSweep({ lazy: true });
  const project = resolveProjectFromReq(req);
  const authorized = getAuthorizedProjects(req);

  // A4 (v3.12.2): the archive sink is a read like the list endpoint above —
  // a project-scoped credential is clamped to its authorized projects instead
  // of silently seeing every project's archived cards. Same clamp semantics:
  // an unauthorized explicit ?project= is an empty list, never a widening.
  if (authorized instanceof Set) {
    if (project) {
      if (!authorized.has(project)) return res.json([]);
      return res.json(store.getArchivedTasks(project));
    }
    let out = [];
    for (const p of authorized) out = out.concat(store.getArchivedTasks(p));
    return res.json(out);
  }

  res.json(store.getArchivedTasks(project));
}));

router.post('/archive/sweep', asyncHandler(async (req, res) => {
  // A4 (v3.12.2): a project-scoped credential may only sweep its OWN projects
  // — the store narrows its per-project loop (archive move + trash retention)
  // to the authorized set, and the response's project summaries are clamped
  // the same way. Unscoped callers (admin/global/open reads) sweep everything,
  // unchanged.
  const authorized = getAuthorizedProjects(req);
  const projects = authorized instanceof Set ? [...authorized] : null;
  const moved = await store.runArchiveSweep({ force: true, projects });
  const summaries = store.getProjectSummaries();
  res.json({
    moved,
    projects: projects ? summaries.filter((s) => projects.includes(s.project)) : summaries,
  });
}));

// --- §admin-purge bulk purge (MUST be declared before /:id so Express treats
//     `purge` as a static segment, not an :id match) ----------------------

router.post('/purge', asyncHandler(async (req, res) => {
  const result = await store.purgeTasks({
    caller: req.caller || {},
    project: resolveProjectFromReq(req),
    ids: req.body?.ids,
    filter: req.body?.filter,
    // v2.5.6: {hard:true} permanently deletes instead of parking in the trash sink.
    hard: req.body?.hard === true,
  });
  if (result.error) {
    logWarn('rejection', `POST /api/tasks/purge: ${result.status} ${result.error}`);
    return res.status(result.status).json({ error: result.error });
  }
  res.status(result.status).json({ deleted: result.deleted, count: result.count });
}));

// --- §2.9 trash sink (v2.5.6, ENH-03; MUST be declared before /:id so Express
//     treats `trash` as a static segment, not an :id match) ----------------

router.get('/trash', asyncHandler(async (req, res) => {
  await store.runArchiveSweep({ lazy: true });
  const project = resolveProjectFromReq(req);
  const authorized = getAuthorizedProjects(req);

  // A4 (v3.12.2): same clamp as /archive — the trash sink must not leak
  // other projects' soft-deleted cards to a scoped credential.
  if (authorized instanceof Set) {
    if (project) {
      if (!authorized.has(project)) return res.json([]);
      return res.json(store.getTrashedTasks(project));
    }
    let out = [];
    for (const p of authorized) out = out.concat(store.getTrashedTasks(p));
    return res.json(out);
  }

  res.json(store.getTrashedTasks(project));
}));

router.post('/trash/:id/restore', asyncHandler(async (req, res) => {
  const result = await store.restoreFromTrash(req.params.id, {
    caller: req.caller || {},
    project: resolveProjectFromReq(req),
    ...(({ expected_version: v }) => (v !== undefined && v !== null && v !== '' ? { expected_version: v } : {}))(req.body ?? {}),
  });
  if (result.error) {
    logWarn('rejection', `POST /api/tasks/trash/${req.params.id}/restore: ${result.status} ${result.error}`);
    return res.status(result.status).json({ error: result.error });
  }
  res.status(200).json(result.task);
}));

router.delete('/trash/:id', asyncHandler(async (req, res) => {
  const result = await store.hardDeleteFromTrash(req.params.id, {
    caller: req.caller || {},
    project: resolveProjectFromReq(req),
  });
  if (result.error) {
    logWarn('rejection', `DELETE /api/tasks/trash/${req.params.id}: ${result.status} ${result.error}`);
    return res.status(result.status).json({ error: result.error });
  }
  res.status(200).json(result.task);
}));

// --- §2.7 fair claim queue (MUST be declared before /:id so Express treats
//     `next-claim` as a static segment, not an :id match) ------------------

/**
 * §2.7 POST /api/tasks/next-claim — atomically select + claim the highest-
 * priority, unclaimed, dependency-satisfied READY task for the caller (v3: only
 * READY cards are claimable; the claim lifts READY -> IN_PROGRESS, or PLANNING
 * for a planner).
 * The caller's role is taken from the authenticated identity only (never the
 * query string). Query: ?project= (accepted, no-op today), ?lease_ms=. The
 * claiming identity is credential-bound (v3.12.1): ?agent_id= no longer
 * participates. Returns 200 + the claimed task, or 204 when nothing is
 * claimable.
 */
router.post('/next-claim', asyncHandler(async (req, res) => {
  // Deep-review (auth P1, v3.12.1): a non-privileged bearer claims only as
  // THEMSELVES — mirroring the claim route. The query string is scope/params
  // only and is NEVER identity: `?agent_id=` no longer participates at all.
  // The role stays credential-derived (req.caller?.role) as before.
  const agentId = store.callerIsPrivileged(req.caller)
    ? (req.body?.agent_id || req.caller?.agent_id)
    : req.caller?.agent_id;
  if (!agentId) {
    return res.status(400).json({ error: 'agent_id is required' });
    }

  // Deep-review (auth P1): an unscoped sweep must not hand out another
  // project's card to a caller whose credential is itself project-scoped —
  // mirroring the I-3 fix in /api/agents/:id/heartbeat. Unscoped credentials
  // (legacy global/admin) keep their historical whole-board reach.
  const nextClaimProject = resolveProjectFromReq(req);
  const allowedScopes = getAuthorizedProjects(req);
  if (allowedScopes instanceof Set && !nextClaimProject) {
    return res.status(400).json({ error: 'project scope (?project=) is required for next-claim' });
  }

  // §2.7: the role is taken from the authenticated caller only, never the query
  // string, so an authenticated `builder` cannot elevate to `reviewer` via
  // `?role=reviewer`. It is still validated against VALID_ROLES (403 on bad).
  const rawRole = req.caller?.role;
  if (rawRole !== undefined && rawRole !== null && rawRole !== '') {
    const role = typeof rawRole === 'string' ? rawRole.toLowerCase() : null;
    if (!role || !VALID_ROLES.has(role)) {
      logWarn('next-claim', `403 invalid role: ${rawRole}`);
      return res.status(403).json({
        error: `A valid agent role is required for next-claim (got '${rawRole}')`,
       });
    }
   }

   // §2.7: project scoping is a no-op today (accepted, ignored — §2.1 lands it).
    const project = nextClaimProject;
    const result = await store.nextClaim({
      agentId,
      role: rawRole ? String(rawRole).toLowerCase() : undefined,
      project,
      lease_ms: req.query?.lease_ms ?? req.body?.lease_ms,
     });

     if (result.unavailable) {
        return res.status(204).end();
    }
     if (result.error) {
      logWarn('next-claim', `${result.status} ${result.error} ${result.reason || ''}`);
      return res.status(result.status).json({
        error: result.error,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.unresolved_dependencies
           ? { unresolved_dependencies: result.unresolved_dependencies }
           : {}),
       });
     }
     return res.status(200).json(result.task);
     }));

// --- Single task --------------------------------------------------------

router.get('/:id', asyncHandler(async (req, res) => {
  const task = store.getTask(req.params.id, resolveProjectFromReq(req));
  if (!task || !readScopeAllows(req, task.project)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json(task);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await store.deleteTask(req.params.id, {
    caller: req.caller || {},
    project: resolveProjectFromReq(req),
  });
  if (result.error) {
    logWarn('rejection', `DELETE /api/tasks/${req.params.id}: ${result.status} ${result.error}`);
    return res.status(result.status).json({ error: result.error });
  }
  res.status(200).json(result.task);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const patch = { ...(req.body ?? {}) };
  const guard = resolveExpectedVersion(req);
  if (guard) patch.expected_version = guard.expected_version;
  const result = await store.patchTask(req.params.id, patch, {
      caller: req.caller || {},
      project: resolveProjectFromReq(req),
      });
  if (result.error) {
        // §2.6: a version-conflict 409 carries the current vs. supplied version
        // so the client can re-fetch and re-apply; surface its details verbatim.
    if (result.status === 409 && result.details) {
     logWarn('version-conflict', `PATCH /api/tasks/${req.params.id}: 409 ` +
       `expected=${result.details.expected} provided=${result.details.provided}`);
      return res.status(409).json({
        error: result.error,
        details: result.details,
        currentVersion: result.details.expected,
        status: 409,
       });
       }
    logWarn('rejection', `PATCH /api/tasks/${req.params.id}: ${result.status} ${result.error}`);
        // §2.5: a dependency-conflict 409 carries a `reason` +
        // `unresolved_dependencies` so callers can branch on "blocked on deps"
        // (mirrors the claim route's shape; a contention/version 409 carries no
        // reason).
    if (result.status === 409 && result.reason) {
     return res.status(409).json({
        error: result.error,
        reason: result.reason,
           ...(result.unresolved_dependencies
              ? { unresolved_dependencies: result.unresolved_dependencies }
              : {}),
         status: 409,
          });
    }
    return res.status(result.status).json({ error: result.error });
      }
  res.status(200).json(result.task);
}));

router.post('/:id/claim', asyncHandler(async (req, res) => {
  // Deep-review (auth P1): a non-privileged bearer claims only as THEMSELVES —
  // otherwise any project token can adopt another agent's identity (their lease
  // never lapses and every write is misattributed). The body agent_id stays
  // meaningful for privileged callers only.
  const agentId = store.callerIsPrivileged(req.caller)
    ? (req.body?.agent_id || req.caller?.agent_id)
    : req.caller?.agent_id;
  if (!agentId) {
    return res.status(400).json({ error: 'agent_id is required' });
      }

  const guard = resolveExpectedVersion(req);
  const result = await store.claimTask(
        req.params.id, agentId, resolveProjectFromReq(req),
        { ...(guard || {}), lease_ms: req.body?.lease_ms, caller: req.caller || {} },
       );
  if (result.error) {
    if (result.status === 400) {
      return res.status(400).json({ error: result.error });
    }
        // §2.6: distinguish a version-conflict 409 from contention 409. A stale
        // claim ("Version mismatch") carries the current version for retry; a
        // contention 409 ("… already claimed by …") carries no version.
    if (result.status === 409 && result.details) {
     return res.status(409).json({
        error: result.error,
        details: result.details,
        currentVersion: result.details.expected,
        status: 409,
         });
     }
       // §2.5: a dependency-conflict 409 carries a `reason` +
       // `unresolved_dependencies` so callers can branch on "blocked on deps"
       // (distinct from a contention 409, which carries no reason).
    if (result.status === 409 && result.reason) {
     return res.status(409).json({
        error: result.error,
        reason: result.reason,
           ...(result.unresolved_dependencies
              ? { unresolved_dependencies: result.unresolved_dependencies }
              : {}),
         status: 409,
          });
    }
    logWarn('rejection', `POST /api/tasks/${req.params.id}/claim: ${result.status} ${result.error}`);
    return res.status(result.status).json({ error: result.error });
      }
  res.status(200).json(result.task);
}));

/**
 * opt-operator-assignment (v2.11.0) — POST /api/tasks/:id/assign.
 * A PRIVILEGED caller (runner/system/human/admin, derived from the credential)
 * hands a task to a named agent without that agent self-claiming. `agent_id:
 * null` releases the assignment. Mirrors the claim route's 409 passthroughs.
 */
router.post('/:id/assign', asyncHandler(async (req, res) => {
  const agentId = 'agent_id' in (req.body || {}) ? req.body.agent_id : undefined;
  const guard = resolveExpectedVersion(req);
  const result = await store.assignTask(req.params.id, agentId === undefined ? null : agentId, {
    caller: req.caller || {},
    project: resolveProjectFromReq(req),
    ...(guard || {}),
  });
  if (result.error) {
    if (result.status === 409 && result.details) {
      return res.status(409).json({
        error: result.error,
        details: result.details,
        currentVersion: result.details.expected,
        status: 409,
      });
    }
    logWarn('rejection', `POST /api/tasks/${req.params.id}/assign: ${result.status} ${result.error}`);
    return res.status(result.status).json({ error: result.error });
  }
  res.status(200).json(result.task);
}));

// --- §2.4 lease heartbeat ------------------------------------------------
/**
 * §2.4 POST /api/tasks/:id/heartbeat — renew the lease on a held task. The
 * HOLDER (the builder/reviewer/tester that owns it) or a PRIVILEGED role
 * (runner/system/human/admin) may renew; a non-privileged non-holder gets a
 * `not_lease_holder` 409, an unclaimed task a `not_claimed` 409, a missing task
 * a 404. Runs in the mutation lock. No log entry by default (no spam).
 */
router.post('/:id/heartbeat', asyncHandler(async (req, res) => {
  // Deep-review (auth P1): same holder-binding as claim — not_lease_holder is
  // only meaningful when the bearer cannot assert somebody else's identity.
  const agentId = store.callerIsPrivileged(req.caller)
    ? (req.body?.agent_id || req.caller?.agent_id)
    : req.caller?.agent_id;
  if (!agentId) {
    return res.status(400).json({ error: 'agent_id is required' });
      }

   const result = await store.renewLease(req.params.id, agentId, {
    caller: req.caller || {},
    project: resolveProjectFromReq(req),
    lease_ms: req.body?.lease_ms,
    });

     if (result.error) {
        // Distinguish the lease 409s with a reason tag.
      if (result.status === 409) {
        logWarn('heartbeat', `409 ${result.reason || ''} on ${req.params.id}`);
        return res.status(409).json({
          error: result.error,
          ...(result.reason ? { reason: result.reason } : {}),
         });
       }
      logWarn('rejection', `POST /api/tasks/${req.params.id}/heartbeat: ${result.status} ${result.error}`);
      return res.status(result.status).json({ error: result.error });
      }
     return res.status(200).json(result.task);
      }));

// ENH-08 (v2.8.0): paging read for a task's log/comment history.
// GET /api/tasks/:id/logs?project=X&offset=&limit=&include_spilled=1
// Returns { inline:[...], spilled_count, entries:[...] }.
// Inline logs are newest-first; spilled entries are oldest-first (append order).
router.get('/:id/logs', asyncHandler(async (req, res) => {
  const task = store.getTask(req.params.id, resolveProjectFromReq(req));
  if (!task || !readScopeAllows(req, task.project)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const project = resolveProjectFromReq(req);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(200, Math.max(0, Number(req.query.limit) || 50));
  const includeSpilled = req.query.include_spilled === '1';
  const result = await store.getTaskLogs(req.params.id, project, {
    offset,
    limit,
    include_spilled: includeSpilled,
  });
  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }
  res.status(200).json({
    inline: result.inline,
    spilled_count: result.spilled_count,
    entries: result.entries,
  });
}));

router.post('/:id/logs', asyncHandler(async (req, res) => {
  // Deep-review (auth P1, v3.12.1): a non-privileged bearer logs only as
  // THEMSELVES — same identity binding as claim/heartbeat, so a project token
  // cannot misattribute progress to another agent. The body agent_id stays
  // meaningful for privileged callers only.
  const agentId = store.callerIsPrivileged(req.caller)
    ? (req.body?.agent_id || req.caller?.agent_id)
    : req.caller?.agent_id;
  const message = req.body?.message;
  if (!agentId || !message) {
    return res.status(400).json({ error: 'agent_id and message are required' });
       }

  const guard = resolveExpectedVersion(req);
  const result = await store.appendLog(
        req.params.id, agentId, message, resolveProjectFromReq(req), guard || {},
        );
  if (result.error) {
    if (result.status === 409 && result.details) {
     return res.status(409).json({
        error: result.error,
        details: result.details,
        currentVersion: result.details.expected,
        status: 409,
         });
     }
    return res.status(result.status).json({ error: result.error });
       }
  res.status(200).json(result.task);
}));

router.get('/:id/issues', (req, res) => {
  const task = store.getTask(req.params.id, resolveProjectFromReq(req));
  if (!task || !readScopeAllows(req, task.project)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json({ issues: task.issues || [] });
});

router.post('/:id/issues', asyncHandler(async (req, res) => {
  const { issue_id } = req.body ?? {};
  if (!issue_id) {
    return res.status(400).json({ error: 'issue_id is required' });
       }

  const guard = resolveExpectedVersion(req);
  const result = await store.addIssue(
        req.params.id, issue_id, resolveProjectFromReq(req), guard || {},
        );
  if (result.error) {
    if (result.status === 409 && result.details) {
     return res.status(409).json({
        error: result.error,
        details: result.details,
        currentVersion: result.details.expected,
        status: 409,
         });
     }
    return res.status(result.status).json({ error: result.error });
       }
  res.status(200).json(result);
}));

// v2.5.0: append a comment to a task's discussion thread. Mirrors /:id/logs —
// agent_id + message required, §2.6 CAS guard, 409 details passthrough.
router.post('/:id/comments', asyncHandler(async (req, res) => {
  // Deep-review (auth P1, v3.12.1): same identity binding as /:id/logs — a
  // non-privileged bearer comments only as the identity on their credential.
  const agentId = store.callerIsPrivileged(req.caller)
    ? (req.body?.agent_id || req.caller?.agent_id)
    : req.caller?.agent_id;
  const message = req.body?.message;
  if (!agentId || !message || typeof message !== 'string') {
    return res.status(400).json({ error: 'agent_id and message are required' });
       }

  const guard = resolveExpectedVersion(req);
  const result = await store.addComment(
        req.params.id, agentId, message, resolveProjectFromReq(req), guard || {},
        );
  if (result.error) {
    if (result.status === 409 && result.details) {
     return res.status(409).json({
        error: result.error,
        details: result.details,
        currentVersion: result.details.expected,
        status: 409,
         });
     }
    return res.status(result.status).json({ error: result.error });
       }
  res.status(200).json(result.task);
}));

export default router;
