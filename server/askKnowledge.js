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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('./package.json');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceCache = new Map();
// This module's own repo path. Its content is not scanned for keyword matches
// because it embeds the guardrail/protocol prose (see rankSourceFiles).
const SELF_PATH = 'server/askKnowledge.js';

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

/** Full text of a repo file (cached by abs path + mtime); null on error. */
export function readSourceFile(relPath) {
  try {
    const abs = path.join(REPO_ROOT, relPath);
    const stat = fs.statSync(abs);
    const cached = sourceCache.get(abs);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text;
    const text = fs.readFileSync(abs, 'utf8');
    sourceCache.set(abs, { text, mtimeMs: stat.mtimeMs });
    return text;
  } catch {
    return null;
  }
}

/**
 * Reads one repo file (relative to the repo root) and returns the first
 * `maxChars` characters. Cached by absolute path + mtime. Returns null on any
 * error (missing file, unreadable) so callers degrade gracefully.
 */
export function readSourceExcerpt(relPath, maxChars = 6000) {
  const text = readSourceFile(relPath);
  return text === null ? null : text.slice(0, maxChars);
}

/**
 * Common English words that must never count as a keyword match: without this,
 * an off-topic question matches almost every file-map note on the word "the"
 * and retrieves irrelevant source. Purely a filter on the question tokens;
 * domain words (claim, lease, reaper, git, sse, ...) are kept.
 *
 * Keep this comment free of ordinary off-topic nouns: rankSourceFiles() scans
 * file *contents*, so spelling an example out here would make this file match
 * the very questions the stopwords exist to reject.
 */
const QUESTION_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'been', 'being', 'does', 'did',
  'has', 'have', 'had', 'how', 'what', 'why', 'when', 'where', 'which', 'who',
  'whom', 'this', 'that', 'these', 'those', 'its', 'you', 'your', 'our', 'their',
  'can', 'could', 'would', 'should', 'may', 'might', 'will', 'shall', 'about',
  'over', 'under', 'then', 'than', 'such', 'not', 'with', 'from', 'into', 'but',
  'any', 'all', 'some', 'each', 'more', 'most', 'other', 'only', 'also', 'just',
]);

/** Splits a question into lowercase keyword tokens (>= 3 chars, stopwords removed). */
function questionTokens(question) {
  return String(question || '')
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((t) => t.length >= 3 && !QUESTION_STOPWORDS.has(t));
}

/**
 * Folds British/American -ise/-ize (and -isation/-ization) spelling so a question
 * that says "serialise" still matches source that says "serialize". Symmetric
 * (z -> s), so it only ever makes two spellings compare equal, never apart.
 */
function foldSpelling(text) {
  return String(text).toLowerCase().replace(/z/g, 's');
}

/**
 * Scores FILE_MAP entries against a question using (a) path/note metadata and
 * (b) a cached content scan. Content hits are strong evidence, so a precise
 * symbol name (e.g. renewAllLeasesInner) finds its file even when the map note
 * never mentions it. Pure-ish (only reads the cached file text); never throws.
 */
export function rankSourceFiles(question, { maxFiles = 3 } = {}) {
  const tokens = questionTokens(question);
  if (tokens.length === 0) return [];
  const scored = FILE_MAP.map((f) => {
    const hay = `${f.path} ${f.note}`.toLowerCase();
    const segments = f.path.toLowerCase().split(/[\/.]/);
    let score = 0;
    for (const t of tokens) {
      if (hay.includes(t)) score += 1;
      if (segments.includes(t)) score += 2;
    }
    // Skip the content scan for this module: it embeds the guardrail and
    // protocol prose (e.g. "world facts", "unrelated"), which would otherwise
    // self-match almost any question. It stays rankable via metadata only.
    const text = f.path === SELF_PATH ? null : readSourceFile(f.path);
    if (text) {
      const lc = foldSpelling(text);
      for (const t of tokens) {
        if (t.length >= 5 && lc.includes(foldSpelling(t))) score += 3;
      }
    }
    return { ...f, score };
  }).filter((f) => f.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxFiles);
}

/**
 * Returns the most relevant slice of a file for a question: a sliding window of
 * `windowLines` lines with the highest density of question keywords, capped at
 * `maxChars`. Falls back to the head of the file when there are no keyword hits.
 */
export function excerptWindow(text, question, { maxChars = 12000, windowLines = 120 } = {}) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const tokens = questionTokens(question);
  const lines = text.split('\n');
  if (tokens.length === 0 || lines.length <= windowLines) return text.slice(0, maxChars);
  const scores = lines.map((l) => {
    const lc = foldSpelling(l);
    let s = 0;
    for (const t of tokens) if (lc.includes(foldSpelling(t))) s += 1;
    return s;
  });
  let bestStart = 0;
  let bestScore = -1;
  let running = 0;
  for (let i = 0; i < lines.length; i += 1) {
    running += scores[i];
    if (i >= windowLines) running -= scores[i - windowLines];
    if (i >= windowLines - 1) {
      const start = i - windowLines + 1;
      if (running > bestScore) { bestScore = running; bestStart = start; }
    }
  }
  if (bestScore <= 0) return text.slice(0, maxChars);
  const header = `... (lines ${bestStart + 1}-${Math.min(bestStart + windowLines, lines.length)}) ...\n`;
  return (header + lines.slice(bestStart, bestStart + windowLines).join('\n')).slice(0, maxChars);
}

/**
 * Selects the most relevant source files for a question and returns their
 * verbatim excerpts. Returns `{ files: string[], text: string }`; `text` is ''
 * when nothing matched or nothing could be read.
 *
 * `maxCharsPerFile` defaults to 12000 (not 6000): the flagship files are large
 * (server/store.js is ~143k chars, with `reapExpiredClaims` at ~92k and
 * `renewAllLeasesInner` at ~62k), so a head-only excerpt would return only
 * imports and would not answer implementation questions. `excerptWindow` instead
 * centres the excerpt on where the question's keywords actually occur.
 */
export function gatherSourceContext(question, { maxFiles = 3, maxCharsPerFile = 12000, maxTotalChars = 20000 } = {}) {
  const picked = rankSourceFiles(question, { maxFiles });
  const parts = [];
  let total = 0;
  for (const f of picked) {
    const full = readSourceFile(f.path);
    if (!full) continue;
    const body = excerptWindow(full, question, { maxChars: maxCharsPerFile });
    if (!body) continue;
    const block = `--- ${f.path} (excerpt) ---\n${body}`;
    if (total + block.length > maxTotalChars) break;
    parts.push(block);
    total += block.length;
  }
  return { files: parts.length ? picked.map((f) => f.path) : [], text: parts.join('\n\n') };
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
 * Enriches each project's bucket with state counts (total, done, active, backlog,
 * blocked) and up to `maxRecentTasksPerProject` recent/active task items with
 * their status, id, and title so the assistant can answer questions about
 * what work has been done and what is in flight.
 *
 * @param {object} store - the imported `server/store.js` module (injectable for tests).
 * @param {object} [opts]
 * @param {number} [opts.maxRecentTasksPerProject=3]
 * @param {number} [opts.maxTitleChars=80]
 */
// 8, not 3: the first real question this feature ever answered was "explain
// what has been done in each project", and three titles per project was too
// thin to answer it — the model filled the gap with generic prose instead.
// The prompt budget is 6000 tokens and the fixed blocks leave room for this.
export function gatherSnapshot(store, { maxRecentTasksPerProject = 8, maxTitleChars = 80 } = {}) {
  if (!store || typeof store.getTasks !== 'function') return { available: false };
  try {
    const tasks = store.getTasks() || [];
    const byStatus = {};
    const byProject = {};
    for (const t of tasks) {
      const status = t && t.status ? t.status : 'UNKNOWN';
      byStatus[status] = (byStatus[status] || 0) + 1;
      const project = (t && t.project) || 'default';
      const bucket = (byProject[project] = byProject[project] || {
        total: 0,
        done: 0,
        active: 0,
        backlog: 0,
        blocked: 0,
        recent_tasks: [],
      });
      bucket.total += 1;
      if (status === 'DONE') {
        bucket.done += 1;
      } else if (ACTIVE_STATUSES.includes(status)) {
        bucket.active += 1;
      } else if (status === 'BACKLOG') {
        bucket.backlog += 1;
      } else if (status === 'BLOCKED') {
        bucket.blocked += 1;
      }

      // Collect top recent tasks per project (store.getTasks returns tasks sorted by recency)
      if (bucket.recent_tasks.length < maxRecentTasksPerProject && t && t.id) {
        const rawTitle = typeof t.title === 'string' ? t.title.trim() : '';
        const title = rawTitle.length > maxTitleChars ? `${rawTitle.slice(0, maxTitleChars - 3)}...` : rawTitle;
        bucket.recent_tasks.push({
          id: t.id,
          title: title || '(no title)',
          status,
          assigned_agent: t.assigned_agent || null,
        });
      }
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

  const projectEntries = Object.entries(snapshot.by_project || {});
  const projectParts = projectEntries
    .map(([k, v]) => {
      const counts = [`${v.total} cards`, `${v.done} done`, `${v.active} active`];
      if (v.backlog) counts.push(`${v.backlog} backlog`);
      if (v.blocked) counts.push(`${v.blocked} blocked`);
      return `${k} (${counts.join(', ')})`;
    })
    .join('; ');
  if (projectParts) lines.push(`- by project: ${projectParts}.`);

  // Project activity details (recent task titles and agents)
  const activityBlocks = [];
  for (const [project, info] of projectEntries) {
    if (info.recent_tasks && info.recent_tasks.length > 0) {
      const items = info.recent_tasks
        .map((t) => `    * [${t.status}] ${t.id}: ${t.title}${t.assigned_agent ? ` (@${t.assigned_agent})` : ''}`)
        .join('\n');
      activityBlocks.push(`  - ${project}:\n${items}`);
    }
  }
  if (activityBlocks.length > 0) {
    lines.push(`- recent activity by project:\n${activityBlocks.join('\n')}`);
  }

  if (snapshot.reaper) lines.push(`- reaper: enabled=${snapshot.reaper.enabled}, running=${snapshot.reaper.running}.`);
  return lines.join('\n');
}

/**
 * The scope guardrail. This is an instruction to the model, not a hard security
 * boundary — the About page copy must not word it as a guarantee.
 */
export const GUARDRAIL_INSTRUCTION = `SCOPE — READ THIS FIRST
You answer questions about THIS board: its protocol, lifecycle, engine, API, client,
deployments, configuration, its source code, and the projects and tasks tracked on it.
The public repository is ${ASK_REPO_URL} — you may reference or link files from it.

If a question is outside that scope (general chit-chat, other products, coding help
unrelated to this board, world facts, opinions, etc.), reply with exactly one short
polite line declining, e.g.: "I can only answer questions about the Agent Kanban
Board, its protocol, source code, and tracked projects." Then stop. Do not answer
the off-topic part even partially.

Rules:
- Never invent endpoints, env vars, statuses, or file paths. If unsure, say so.
- Never claim, patch, move, or delete a card, and never ask for or reveal a token.
- When asked about projects, activity, or tasks, use the recent activity and card
  counts in the LIVE BOARD SNAPSHOT to explain what work has been completed, what is
  in progress, and what remains in backlog for each project. Name the actual cards
  from "recent activity by project" — that list is the activity. Do not answer a
  question about what was DONE with counts alone.
- NEVER state a figure that contradicts the snapshot. If a project shows
  "22 cards, 19 done", it has 3 cards that are NOT done: do not write that every
  task is finished, and do not write "0 active" unless the snapshot says active=0.
  Read each project's own numbers; do not generalise one project's state to the
  others.
- The snapshot is a point-in-time read of the WHOLE board. It is not a claim that
  nothing else exists, and counts may have moved on since.
- Prefer the LIVE BOARD SNAPSHOT for current figures; use the protocol summary for
  how things work. Be concise and concrete.

Verbatim source excerpts may be provided; answer code questions precisely from them
and never invent functions, endpoints, or files that are absent from the excerpts or
the file map.`;

/**
 * Builds the full system prompt: guardrail + protocol pack + file map + snapshot.
 *
 * @param {object} [opts]
 * @param {object} [opts.snapshot] - from gatherSnapshot(); omitted -> "unavailable".
 * @param {object} [opts.retrieved] - from gatherSourceContext(); verbatim source excerpts.
 * @param {number} [opts.maxTokens] - soft budget; long sections are trimmed to fit.
 */
export function buildSystemPrompt({ snapshot, retrieved, maxTokens = 6000 } = {}) {
  const header = `You are the "Ask the Board" assistant for the Agent Kanban Board (v${APP_VERSION}).`;
  const snapshotText = formatSnapshot(snapshot);
  const fileMapText = `SOURCE-CODE FILE MAP (public repo: ${ASK_REPO_URL})\n${buildFileMapText()}`;
  const retrievedText = retrieved && retrieved.text
    ? `RELEVANT SOURCE-CODE EXCERPTS (verbatim from the repository)\n${retrieved.text}`
    : 'RELEVANT SOURCE-CODE EXCERPTS: none selected for this question — answer from the protocol summary and file map, and say so if you are unsure.';

  // Assemble longest-first, trimming the protocol pack if we blow the budget.
  const fixed = [header, GUARDRAIL_INSTRUCTION, snapshotText, fileMapText, retrievedText].join('\n\n');
  const fixedTokens = estimateTokens(fixed);
  let protocol = PROTOCOL_KNOWLEDGE;
  const budgetForProtocol = Math.max(200, maxTokens - fixedTokens);
  if (estimateTokens(protocol) > budgetForProtocol) {
    const maxChars = budgetForProtocol * CHARS_PER_TOKEN;
    protocol = `${protocol.slice(0, maxChars)}\n[protocol summary trimmed to fit the prompt budget]`;
  }

  return [header, GUARDRAIL_INSTRUCTION, protocol, fileMapText, retrievedText, snapshotText].join('\n\n');
}
