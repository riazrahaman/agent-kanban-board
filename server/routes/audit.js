import { Router } from 'express';
import { readAudit, auditLogEnabled } from '../auditLog.js';

const router = Router();

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/**
 * §2.9 GET /api/audit
 *
 * Returns persisted audit-log entries (newest-first). Open to reads like the
 * other GETs — gate-able by KANBAN_READ_AUTH automatically (no special case).
 *
 * Query params:
 *   limit   — max entries to return (default 100, capped at 1000)
 *   since   — ISO timestamp; only entries with ts >= since
 *   project — filter by project id
 *   kind    — filter by event kind (created/updated/removed/archived/…)
 */
router.get('/', asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const since = typeof req.query.since === 'string' && req.query.since ? req.query.since : null;
  const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : null;
  const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : null;
  const entries = await readAudit({ limit, since, project, kind });
  // Deep-review (auth P2): audit entries name agents, projects and reasons —
  // they are read-scoped like every other list, not open to every credential.
  // A scoped caller's project filter is additionally honoured: asking for a
  // project outside their scope simply yields an empty result.
  const allowed = req.caller?.authorizedProjects;
  const scoped = (allowed instanceof Set)
    ? entries.filter((e) => !e.project || allowed.has(e.project))
    : entries;
  res.json({ entries: scoped, count: scoped.length, enabled: auditLogEnabled() });
}));

export default router;