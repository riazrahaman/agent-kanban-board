/**
 * §2.9 (v2.9.0) — persisted audit stream (JSONL) + read helper.
 *
 * `store.emitAudit` fires for every committed mutation (created/updated/
 * removed/archived). By default that was a console line only. Setting
 * `KANBAN_AUDIT_LOG` to a truthy value additionally appends one compact JSON
 * line per event to `<data-dir>/audit.jsonl`, and `GET /api/audit` reads it
 * back. The data dir is resolved the SAME way the store resolves it so the
 * audit file always lives beside the live data.
 */
import { appendFile, mkdir, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Truthy when `KANBAN_AUDIT_LOG` is set to anything but '', '0', 'false'
 * (case-insensitive). Unset/undefined keeps it off so existing deployments
 * are unaffected.
 */
export function auditLogEnabled(env = process.env) {
  const flag = env.KANBAN_AUDIT_LOG;
  if (flag === undefined || flag === null || flag === '') return false;
  return flag !== '0' && String(flag).toLowerCase() !== 'false';
}

/**
 * Resolves the directory that holds the audit log, mirroring the store's own
 * resolution: `KANBAN_DATA_DIR` → dirname(`KANBAN_DATA_FILE`) → in-repo
 * `server/data`. This matches the v2.7.0 IMPL-02 default so a bare instance
 * writes audit.jsonl next to its tasks.json.
 */
export function auditLogDir(env = process.env) {
  if (env.KANBAN_DATA_DIR) return env.KANBAN_DATA_DIR;
  if (env.KANBAN_DATA_FILE) return path.dirname(env.KANBAN_DATA_FILE);
  return path.resolve(__dirname, 'data');
}

export function auditLogPath(env = process.env) {
  return path.join(auditLogDir(env), 'audit.jsonl');
}

/** Convenience alias used by tests. */
export function auditFilePath() {
  return auditLogPath();
}

/**
 * Append ONE compact JSON line for an audit entry. Derives `task_id` from
 * `entry.task?.id`; never stores the whole task payload. Best-effort: a disk
 * failure is logged and swallowed — it must never break a mutation.
 */
export async function appendAudit(entry) {
  if (!auditLogEnabled()) return;
  try {
    const dir = auditLogDir();
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const line = JSON.stringify({
      ts: entry.ts ?? new Date().toISOString(),
      kind: entry.kind ?? null,
      project: entry.project ?? null,
      task_id: entry.task?.id ?? null,
      actor: entry.actor ?? null,
      reason: entry.reason ?? null,
    });
    await appendFile(auditLogPath(), line + '\n', 'utf8');
  } catch (err) {
    console.error('[kanban audit] append failed:', err.message);
  }
}

/**
 * Read the audit log, newest-first. Parses lines leniently (skipping
 * malformed lines), filters by `since` (ISO string prefix / exact match on
 * `ts`), `project`, and `kind`, then returns the LAST `limit` entries.
 */
export async function readAudit({ limit = 100, since = null, project = null, kind = null } = {}) {
  const filePath = auditLogPath();
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').filter((l) => l.trim());
  const entries = [];
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (since && !(obj.ts && obj.ts >= since)) continue;
    if (project && obj.project !== project) continue;
    if (kind && obj.kind !== kind) continue;
    entries.push(obj);
  }
  entries.reverse();
  const cap = Math.max(0, Math.min(limit, 1000));
  return entries.slice(0, cap);
}

/**
 * Test helper: remove the audit log file if it exists. Must never throw.
 */
export async function resetAuditLog() {
  try {
    await unlink(auditLogPath());
  } catch {
    /* ignore — file may not exist */
  }
}