/**
 * Ask-the-Board knowledge pack (v3.4.0).
 *
 * Builds the system prompt used by `POST /api/ask`. It has three parts:
 *   1. A curated, code-derived protocol summary (the 8-state lifecycle,
 *      claims/leases, the reaper, the two 409s, auth, storage, metrics).
 *   2. A source-code file map + the public repository URL, so questions about
 *      "where does X live / what does file Y do" can be answered.
 *   3. A live, read-only snapshot of the deployed board (counts, projects,
 *      reaper + credential-map health) assembled IN-PROCESS — never over HTTP.
 *
 * The snapshot is assembled by calling the same store accessors the metrics and
 * health routes use. This matters: `isProbePath()` exempts only `/api/health`
 * and `/healthz`, so scraping `/api/metrics` over HTTP would silently break
 * under `KANBAN_READ_AUTH=token`. Importing `server/store.js` directly has no
 * HTTP-auth dependency at all.
 *
 * Everything here is read-only. The model never claims, patches, or moves a
 * card and is never given a token.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('./package.json');

/** Public repository the guardrail points at for source-code questions. */
export const ASK_REPO_URL = 'https://github.com/riazrahaman/agent-kanban-board';

/** Statuses counted as "someone is actively working". */
const ACTIVE_STATUSES = ['PLANNING', 'IN_PROGRESS', 'IN_REVIEW', 'VALIDATION'];

/** Rough characters-per-token used to keep the prompt inside its budget. */
const CHARS_PER_TOKEN = 4;

/**
 * The protocol knowledge pack. Kept deliberately dense and code-derived so the
 * model can answer board/protocol/functionality questions without guessing.
 */
export const PROTOCOL_KNOWLEDGE = `AGENT KANBAN BOARD — PROTOCOL SUMMARY (authoritative)
The "Agent Kanban Board" is a headless-first task board for AI agents. Agents claim
cards, walk them through a fixed lifecycle, and release them with a lease. The board
is the source of truth; an orchestrator skill manages workers against it.

LIFECYCLE (8 canonical states + one exception), in order:
  BACKLOG -> READY -> PLANNING -> IN_PROGRESS -> IN_REVIEW -> VALIDATION -> READY_TO_SHIP -> DONE
  BLOCKED is reachable from (almost) any state.
Legal transitions (server/state-machine.js):
  BACKLOG       -> READY, BLOCKED
  READY         -> PLANNING, IN_PROGRESS, BACKLOG, BLOCKED
  PLANNING      -> IN_PROGRESS, READY, BLOCKED
  IN_PROGRESS   -> IN_REVIEW, PLANNING, BLOCKED
  IN_REVIEW     -> VALIDATION, IN_PROGRESS, BLOCKED
  VALIDATION    -> READY_TO_SHIP, IN_PROGRESS, BLOCKED
  READY_TO_SHIP -> DONE, IN_PROGRESS, BLOCKED
  BLOCKED       -> BACKLOG, READY, PLANNING, IN_PROGRESS, IN_REVIEW, VALIDATION
  DONE is TERMINAL.
Legacy aliases normalise on read/write: TODO->BACKLOG, BUILDING->IN_PROGRESS, IN_TEST->VALIDATION.
Role gates on transitions: planner (READY->PLANNING), validator (VALIDATION->READY_TO_SHIP),
releaser (READY_TO_SHIP->DONE); privileged roles (runner, system, human, admin) may move anything.

CLAIMS & LEASES
- A card must be CLAIMED before it is worked. A claim sets the holder (assigned_agent)
  and a lease expiry (claim_expires_at = now + lease window). A fresh claim requires the
  card to be READY; claiming straight from BACKLOG is refused (409 reason "not_ready").
- A per-task lease window (lease_ms / claim_lease_ms) may be pinned at claim time,
  clamped between KANBAN_MIN_LEASE_MS (default 60000) and KANBAN_MAX_LEASE_MS (7200000).
  Otherwise the global TTL KANBAN_CLAIM_TTL_MS (default 600000) applies.
- POST /api/tasks/:id/heartbeat renews the lease. A lease-only renewal does NOT bump the
  card's version (so heartbeats never invalidate an in-flight edit). Bulk renewal for an
  agent is POST /api/agents/:agent_id/heartbeat (self, or privileged).
- last_progress_at records the last time the CARD ITSELF changed (claim, log, PATCH).
  A sibling lease renewal deliberately does NOT touch it — that separation is what lets the
  reaper detect an "immortal zombie" claim that is being heart-beated but is not progressing.

THE REAPER
- A background sweep (KANBAN_REAP_INTERVAL_MS, default 30000) reclaims stale claims for
  three reasons: orphan_normalized (active card with no owner), progress_stalled
  (last_progress_at older than KANBAN_PROGRESS_STALL_MS, default 1800000 = 30 min), and
  lease_expired (claim_expires_at in the past).
- IMPORTANT: the reaper resets a reclaimed card to READY (immediately re-claimable), NOT
  BACKLOG — even though older comments/changelog text says "back to BACKLOG". READY is the
  actual behaviour.

OPTIMISTIC CONCURRENCY — THE TWO DIFFERENT 409s
- "Version mismatch" (409, details.expected/currentVersion): a stale read. Re-read the card
  and retry the PATCH with the fresh expected_version. Every committed mutation bumps version.
- "Task <id> is already claimed by <agent>" (409): you lost a claim race (contention).
- Other reason-tagged 409s: dependency_unsatisfied, not_ready, status_not_claimable, claim_limit.

WHO MAY WRITE (auth, server/middleware/auth.js)
- Token families: KANBAN_AUTH_TOKEN (legacy global), KANBAN_ADMIN_TOKEN (spans every project,
  privileged), KANBAN_PROJECT_TOKENS (a JSON map { project: token } — one token per project),
  KANBAN_AUTH_SECRET (HMAC session tokens, 24h, revocable via a jti deny-list), plus 60s
  single-use SSE stream tickets.
- A project token authorises a request only if the map has a matching entry for EVERY project
  the request references (query ?project=, body.project / workspace_id, X-Kanban-Project header,
  and composite "project:id" path segments). Otherwise: 403 "token is not authorized for project 'X'".
- The admin token bypasses the per-project check and is audited as an admin_write.
- If KANBAN_PROJECT_TOKENS is set but malformed, mutations fail closed with 503. If no auth
  mechanism is configured at all, mutations fail closed with 503.
- Reads are open by default; set KANBAN_READ_AUTH=token to require auth on reads and SSE.
- Privilege is derived from the CREDENTIAL (admin token / session role), not from the
  self-asserted X-Agent-Role header. A per-project token can never perform privileged ops.

STORAGE
- Two interchangeable backends selected by KANBAN_STORAGE_BACKEND: "json" (default) and "git"
  (one YAML card per task, one git commit per transition). Writes are atomic (temp file + rename)
  and persist-first: storage commits before in-memory state changes and before listeners fire.
- Projects: the default project reuses the legacy file/root; named projects live under
  KANBAN_DATA_DIR (tasks/<project>.json, or <project>/ for git). A corrupt JSON file fails
  closed at boot (refuses to start) rather than being overwritten.

KEY ENDPOINTS
- POST /api/tasks (create; requires id + title), GET /api/tasks, GET/PATCH/DELETE /api/tasks/:id
- POST /api/tasks/:id/claim, POST /api/tasks/:id/assign (privileged),
  POST /api/tasks/:id/heartbeat, POST /api/tasks/next-claim (claim-first picker)
- POST /api/tasks/:id/logs, POST /api/tasks/:id/comments, GET/POST /api/tasks/:id/issues
- GET /api/projects, GET /api/metrics, GET /api/health (+ /healthz, /ready)
- GET /api/milestones, GET /api/settings (PUT privileged), GET /api/audit
- Task paths take ?project=<id>; the project must be authorised by the calling token.`;

/** Curated source-code map: the files a "where is this / what does this do" question hits. */
export const FILE_MAP = [
  { path: 'server/state-machine.js', note: 'Lifecycle states, legal transitions, role gates (pure, no I/O).' },
  { path: 'server/store.js', note: 'The engine: claims, leases, reaper, concurrency lock, all mutations.' },
  { path: 'server/task-identity.js', note: 'Task/project ids, atomic writes, branch/milestone normalisation.' },
  { path: 'server/task-fields.js', note: 'Field validation: priority, depends_on, metadata, privileged roles.' },
  { path: 'server/storage.js', note: 'Pluggable persistence: JsonStorage and GitYamlStorage.' },
  { path: 'server/middleware/auth.js', note: 'Token families, per-project scope checks, fail-closed 503s.' },
  { path: 'server/middleware/rateLimit.js', note: 'Per-project mutation limiter + failed-auth limiter.' },
  { path: 'server/middleware/projectScope.js', note: 'Resolves every project a request references.' },
  { path: 'server/routes/tasks.js', note: 'Task CRUD, claim/assign/heartbeat, logs, issues, comments.' },
  { path: 'server/routes/agents.js', note: 'Bulk per-agent lease heartbeat.' },
  { path: 'server/routes/health.js', note: 'GET /api/health + /ready; version, listeners, credential map.' },
  { path: 'server/routes/metrics.js', note: 'Aggregate + per-project metrics.' },
  { path: 'server/routes/bugReports.js', note: 'Anonymous in-app bug report -> GitHub issue (Turnstile + honeypot).' },
  { path: 'server/routes/ask.js', note: 'This feature: GET /api/ask/config + POST /api/ask (OpenRouter, password-gated).' },
  { path: 'server/askKnowledge.js', note: 'This feature: the protocol knowledge pack + live snapshot builder.' },
  { path: 'server/server.js', note: 'App wiring, middleware mount order, SSE endpoint, trust-proxy handling.' },
  { path: 'server/sessionAuth.js', note: 'HMAC session tokens + jti revoke deny-list.' },
  { path: 'server/streamTicket.js', note: '60s single-use tickets for authenticated SSE reads.' },
  { path: 'server/notifier.js', note: 'Optional Telegram alerts on reclaim events (off by default).' },
  { path: 'server/webhooks.js', note: 'Optional signed outbound JSON webhooks (off by default).' },
  { path: 'client/src/App.tsx', note: 'Board shell: fetch, the single SSE (mode=diff) reconciliation, routing.' },
  { path: 'client/src/lib/claimCoordinator.ts', note: 'Pure claim/heartbeat decisions honouring per-task lease windows.' },
  { path: 'client/src/lib/useClaimCoordinator.ts', note: 'The single writer that claims and heartbeats from the UI.' },
  { path: 'client/src/components/About.tsx', note: 'The About / walkthrough page (this feature is surfaced here).' },
];

/** Builds the file-map text block, keeping the prompt budget honest. */
export function buildFileMapText(fileMap = FILE_MAP) {
  return fileMap.map((f) => `- ${f.path} — ${f.note}`).join('\n');
}

/** Coarse prompt-token estimate (chars / 4). Exact counting is not required here. */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function safeGet(fn, fallback) {
  try {
    const value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

/**
 * Assembles a compact, read-only snapshot of the live board via in-process
 * store accessors. Never throws; on failure returns `{ available: false }`.
 *
 * @param {object} store - the imported `server/store.js` module (injectable for tests).
 */
export function gatherSnapshot(store) {
  if (!store || typeof store.getTasks !== 'function') return { available: false };
  try {
    const tasks = store.getTasks() || [];
    const byStatus = {};
    const byProject = {};
    for (const t of tasks) {
      const status = t && t.status ? t.status : 'UNKNOWN';
      byStatus[status] = (byStatus[status] || 0) + 1;
      const project = (t && t.project) || 'default';
      const bucket = (byProject[project] = byProject[project] || { total: 0, done: 0, active: 0 });
      bucket.total += 1;
      if (status === 'DONE') bucket.done += 1;
      else if (ACTIVE_STATUSES.includes(status)) bucket.active += 1;
    }
    const loaded = typeof store.isStoreLoaded === 'function' ? !!store.isStoreLoaded() : undefined;
    const reaperEnabled = typeof store.isReaperEnabled === 'function' ? !!store.isReaperEnabled() : undefined;
    const reaperRunning = typeof store.isReaperRunning === 'function' ? !!store.isReaperRunning() : undefined;
    return {
      available: true,
      version: APP_VERSION,
      store_loaded: loaded,
      tasks_total: tasks.length,
      tasks_live: tasks.length,
      by_status: byStatus,
      by_project: byProject,
      reaper: { enabled: reaperEnabled, running: reaperRunning },
    };
  } catch {
    return { available: false };
  }
}

/** Renders the snapshot as a short, human-readable block for the prompt. */
export function formatSnapshot(snapshot) {
  if (!snapshot || !snapshot.available) {
    return 'LIVE BOARD SNAPSHOT: unavailable right now — answer from the protocol summary, and say the live figures could not be read.';
  }
  const lines = [];
  lines.push(`LIVE BOARD SNAPSHOT (read-only, ${snapshot.version}):`);
  lines.push(`- cards: ${snapshot.tasks_total} total.`);
  const statusParts = Object.entries(snapshot.by_status || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  if (statusParts) lines.push(`- by status: ${statusParts}.`);
  const projectParts = Object.entries(snapshot.by_project || {})
    .map(([k, v]) => `${k} (${v.total} cards, ${v.done} done, ${v.active} active)`)
    .join('; ');
  if (projectParts) lines.push(`- by project: ${projectParts}.`);
  if (snapshot.reaper) lines.push(`- reaper: enabled=${snapshot.reaper.enabled}, running=${snapshot.reaper.running}.`);
  return lines.join('\n');
}

/**
 * The scope guardrail. This is an instruction to the model, not a hard security
 * boundary — the About page copy must not word it as a guarantee.
 */
export const GUARDRAIL_INSTRUCTION = `SCOPE — READ THIS FIRST
You only answer questions about THIS board: its protocol, lifecycle, engine, API,
client, deployments, configuration, and its source code. The public repository is
${ASK_REPO_URL} — you may reference or link files from it.

If a question is outside that scope (general chit-chat, other products, coding help
unrelated to this board, world facts, opinions, etc.), reply with exactly one short
polite line declining, e.g.: "I can only answer questions about the Agent Kanban
Board, its protocol, and its source code." Then stop. Do not answer the off-topic
part even partially.

Rules:
- Never invent endpoints, env vars, statuses, or file paths. If unsure, say so.
- Never claim, patch, move, or delete a card, and never ask for or reveal a token.
- Prefer the LIVE BOARD SNAPSHOT for current figures; use the protocol summary for
  how things work. Be concise and concrete.`;

/**
 * Builds the full system prompt: guardrail + protocol pack + file map + snapshot.
 *
 * @param {object} [opts]
 * @param {object} [opts.snapshot] - from gatherSnapshot(); omitted -> "unavailable".
 * @param {number} [opts.maxTokens] - soft budget; long sections are trimmed to fit.
 */
export function buildSystemPrompt({ snapshot, maxTokens = 2000 } = {}) {
  const header = `You are the "Ask the Board" assistant for the Agent Kanban Board (v${APP_VERSION}).`;
  const snapshotText = formatSnapshot(snapshot);
  const fileMapText = `SOURCE-CODE FILE MAP (public repo: ${ASK_REPO_URL})\n${buildFileMapText()}`;

  // Assemble longest-first, trimming the protocol pack if we blow the budget.
  const fixed = [header, GUARDRAIL_INSTRUCTION, snapshotText, fileMapText].join('\n\n');
  const fixedTokens = estimateTokens(fixed);
  let protocol = PROTOCOL_KNOWLEDGE;
  const budgetForProtocol = Math.max(200, maxTokens - fixedTokens);
  if (estimateTokens(protocol) > budgetForProtocol) {
    const maxChars = budgetForProtocol * CHARS_PER_TOKEN;
    protocol = `${protocol.slice(0, maxChars)}\n[protocol summary trimmed to fit the prompt budget]`;
  }

  return [header, GUARDRAIL_INSTRUCTION, protocol, fileMapText, snapshotText].join('\n\n');
}
