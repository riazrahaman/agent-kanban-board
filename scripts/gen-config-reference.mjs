#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const DESCRIPTIONS = {
  'KANBAN_ADMIN_TOKEN': 'Admin token that spans every project (audited as admin_write). Required, or a privileged session, for delete/purge/trash restore and hard-delete in every auth mode',
  'KANBAN_ALLOWED_ORIGIN': 'Comma-separated CORS origin allow-list',
  'KANBAN_ALLOW_DEV_CORS': 'Set to "1" to accept the localhost development CORS default even when NODE_ENV=production',
  'KANBAN_IDEMPOTENCY_TTL_MS': 'How long a POST /api/tasks Idempotency-Key is retained (default 600000)',
  'KANBAN_IDEMPOTENCY_MAX_ENTRIES': 'Max retained Idempotency-Key entries before the oldest is evicted (default 1000)',
  'KANBAN_ARCHIVE_AFTER_DAYS': 'Days a DONE task waits before the archive sweep moves it',
  'KANBAN_AUDIT_LOG': 'Set truthy to persist the audit stream as JSONL',
  'KANBAN_AUTH_LOG': 'Set truthy to log redacted auth failures',
  'KANBAN_AUTH_RATE_LIMIT_PER_MIN': 'Failed auth attempts per client address per window before failures are answered 429 (default 60, or KANBAN_RATE_LIMIT_PER_MIN when set; 0 disables). Valid credentials are still served; an address over 10x the limit is refused outright until the window ends. Forwarding headers are ignored unless KANBAN_TRUST_PROXY is set. Ask-the-Board wrong-password backoff reads it with its own default of 10',
  'KANBAN_AUTH_SECRET': 'HMAC secret enabling stateless session tokens',
  'KANBAN_AUTH_TOKEN': 'Global shared token gating every mutating request',
  'KANBAN_AUTO_PROMOTE': 'Set falsy to disable auto-promoting unblocked tasks',
  'KANBAN_BACKUP_ENABLED': 'Set truthy to enable periodic on-disk backups',
  'KANBAN_BACKUP_INTERVAL_MS': 'Backup interval in milliseconds (default 600000)',
  'KANBAN_BACKUP_KEEP': 'How many backup snapshots to retain (default 10)',
  'KANBAN_BOARD_URL': 'Board base URL used in Telegram reclaim alerts (and, when set, shown in the footer of Report-a-bug messages)',
  'KANBAN_CLAIM_TTL_MS': 'Lease TTL for a claimed task (default 600000)',
  'KANBAN_HOLDER_WRITE_RENEWS_ALL': 'Set falsy to disable renewing all sibling leases on a holder write (default 1)',
  'KANBAN_MAX_CLAIMS_PER_AGENT': 'Cap on active claims one agent may hold at once (0/unset = unlimited; privileged roles exempt)',
  'KANBAN_MAX_LEASE_MS': 'Upper bound for a per-task lease window in ms (default 7200000)',
  'KANBAN_MIN_LEASE_MS': 'Lower bound for a per-task lease window in ms (default 60000)',
  'KANBAN_DATA_DIR': 'Directory for named-project JSON data and archives',
  'KANBAN_DATA_FILE': 'Path to the default-project tasks file',
  'KANBAN_DEFAULT_PROJECT': 'Project id used when none is supplied (default "default")',
  'KANBAN_DEPLOY_DRIFT_INTERVAL_MS': 'Deploy-drift check interval in ms (default 1800000 = 30 min; <= 0 disables the monitor)',
  'KANBAN_DEPLOY_DRIFT_GRACE_MS': 'How long a version mismatch must persist before it is reported as drift (default 2700000 = 45 min)',
  'KANBAN_DEPLOY_DRIFT_API_URL': '(optional) Release feed the drift monitor reads (default https://api.github.com/repos/riazrahaman/agent-kanban-board/releases/latest)',
  'KANBAN_DEPLOY_DRIFT_TAGS_API_URL': '(optional) Tag list used when the release feed is missing or older than the newest tag; defaults to the tags endpoint of the same repository (/releases/latest -> /tags?per_page=100)',
  'KANBAN_GIT_COMMIT': 'Set falsy to skip the per-transition git commit',
  'KANBAN_GIT_DIR': 'Directory for the git-backed YAML storage backend',
  'KANBAN_INLINE_COMMENT_CAP': 'Inline comments kept per task before spilling (default 50)',
  'KANBAN_INLINE_LOG_CAP': 'Inline agent-log entries kept per task before spilling (default 50)',
  'KANBAN_JOURNAL_COMPACT_BYTES': 'Journal size that triggers compaction (default 1MB)',
  'KANBAN_MASTER_PASSWORD': '(secret) Optional master password for card details. Unset: details are readable by every reader. Set (12+ characters, not blank; must differ from every token and from KANBAN_AUTH_SECRET, or startup refuses): the board stays publicly viewable, but description, agent log, comments, metadata and spilled logs are returned only to a caller with a board token or the master unlock (typed into the header token box, exchanged at POST /api/auth/unlock for a 12-hour token). Titles, milestones, issue ids and the short estimate stay public. The unlock is read-only apart from saving column colours; with KANBAN_READ_AUTH=token it is a read credential for every read. POST /api/auth/unlock allows 10 unrecognised attempts per client address per minute (KANBAN_AUTH_RATE_LIMIT_PER_MIN when set), then refuses even the correct password until the window ends: behind a reverse proxy set KANBAN_TRUST_PROXY or all visitors share one counter. A random signing secret is kept in <data dir>/.secrets/master-unlock.json (0600)',
  'KANBAN_MAX_SSE_STREAMS': 'Cap on concurrent SSE connections (default 100)',
  'KANBAN_MAX_SSE_STREAMS_PER_IP': 'Cap on concurrent SSE connections per client IP (default 20; negative disables; still bounded by the global cap). Keys on req.ip, so set KANBAN_TRUST_PROXY correctly behind a proxy',
  'KANBAN_REQUIRE_BOUND_CREDENTIALS': 'Set to "1" to reject writes (403) from credentials with no agent_id binding (legacy string tokens, {token} entries, KANBAN_AUTH_TOKEN); admin and bound credentials are unaffected. Default off; a startup warning counts unbound credentials either way',
  'KANBAN_NOTIFY_EVENTS': 'Comma-separated reclaim reasons that trigger an alert',
  'KANBAN_NOTIFY_INCLUDE_DESC': 'Set falsy to omit the task description from alerts',
  'KANBAN_NOTIFY_MIN_INTERVAL_MS': 'Minimum gap between outbound notifications',
  'KANBAN_NOTIFY_PROJECTS': 'Comma-separated allow-list of projects that notify',
  'KANBAN_ORPHAN_GRACE_MS': 'Grace before an ownerless active task is normalized (default 300000)',
  'KANBAN_PROGRESS_STALL_MS': 'Progress stall timeout in ms before inactive task is reaped (default 1800000; 0 disables)',
  'KANBAN_PROJECT_TOKENS': 'Per-project credentials with optional role AND identity binding: "tok" (unbound), {"token":"tok"}, {"token":"tok","role":"builder"} (role forced server-side), {"token":"tok","agent_id":"agent-7"} (identity forced server-side), {"token":"tok","role":"tester","agent_id":"t-1"}, or {"credentials":[…]}; one credential per agent role',
  'KANBAN_RATE_LIMIT_PER_MIN': 'Per-project mutation limit per window (0 disables)',
  'KANBAN_ROLE_CROSSING_AUDIT': 'Set truthy to emit a role_crossing audit event when one agent presents bound credentials for several roles (off by default; ADR-006)',
  'KANBAN_RATE_LIMIT_WINDOW_MS': 'Fixed rate-limit window in milliseconds (default 60000)',
  'KANBAN_READ_AUTH': 'Set to "token" to require auth on reads and SSE',
  'KANBAN_REAP_ENABLED': 'Set falsy to disable the background lease reaper',
  'KANBAN_REAP_INTERVAL_MS': 'Lease reaper sweep interval (default 30000; <= 0 disables the reaper)',
  'KANBAN_STAGE_STALL_MS': 'Progress stall window for decision-pending stages IN_REVIEW/VALIDATION (default 86400000 = 24h; 0 disables). IN_PROGRESS/PLANNING keep KANBAN_PROGRESS_STALL_MS',
  'KANBAN_SESSION_CHALLENGE_TTL_MS': 'TTL for a single-use /api/auth/challenge nonce (default 120000). Unset/invalid falls back to the default',
  'KANBAN_SESSION_NONCE_MODE': 'Session-handshake proof mode. Default "required": POST /api/auth/session needs a live unconsumed POST /api/auth/challenge nonce. Only the exact value "legacy" accepts the old challenge-less proof (startup warning); any other value means "required"',
  'KANBAN_STORAGE_BACKEND': 'Persistence backend: "json" or "git"',
  'KANBAN_WEBHOOK_URLS': 'Comma-separated outbound webhook subscriber URLs (unset disables webhooks)',
  'KANBAN_WEBHOOK_EVENTS': 'Comma-separated event kinds to deliver (unset = every kind)',
  'KANBAN_WEBHOOK_SECRET': '(secret) HMAC secret used to sign outbound webhook bodies',
  'KANBAN_WEBHOOK_MAX_ATTEMPTS': 'Delivery attempts per webhook event (default 3; transient failures only)',
  'KANBAN_WEBHOOK_BACKOFF_MS': 'Base webhook retry backoff in ms (default 250; 0 disables waiting)',
  'KANBAN_WEBHOOK_MAX_QUEUE': 'Per-URL webhook queue cap; exceeding it drops the oldest event (default 100)',
  'KANBAN_WEBHOOK_DEAD_LETTER_MAX': 'Per-URL in-memory dead-letter ring size (default 50)',
  'KANBAN_STORAGE_JOURNAL': 'Append-only JSON journal; on by default, set "0" or "false" to opt out',
  'KANBAN_TELEGRAM_BACKUP_ENABLED': 'Set truthy to send a full .tar.gz backup to the Telegram chat once a day (needs the bot token + chat id)',
  'KANBAN_TELEGRAM_BACKUP_HOUR': 'Hour of day (0-23) the daily Telegram backup is sent (default 3)',
  'KANBAN_TELEGRAM_BACKUP_TZ': 'IANA time zone for the backup hour (default Asia/Dubai = Abu Dhabi, UTC+4)',
  'KANBAN_TELEGRAM_BOT_TOKEN': '(secret) Telegram bot token for reclaim alerts, the daily backup and Report-a-bug messages (the one board bot)',
  'KANBAN_TELEGRAM_CHAT_ID': 'Telegram chat id that receives reclaim alerts (and Report-a-bug messages unless KANBAN_REPORT_TELEGRAM_CHAT_ID is set)',
  'KANBAN_TRASH_DAYS': 'Days a soft-deleted task stays in the trash sink (default 30)',
  'KANBAN_TRUST_PROXY': 'Express "trust proxy" setting. Unset: no proxy is trusted (forwarding headers ignored). Behind one reverse proxy such as the Railway edge set 1; otherwise a hop count, 0/false for none, true for all, or an address/CIDR list',
  'KANBAN_REPORT_GITHUB_TOKEN': 'REMOVED, no longer read: Report-a-bug now sends a Telegram message instead of filing a GitHub issue. Safe to delete',
  'KANBAN_REPORT_REPO': 'REMOVED, no longer read: Report-a-bug no longer files GitHub issues. Safe to delete',
  'KANBAN_REPORT_TELEGRAM_CHAT_ID': '(optional) Chat or channel id that receives Report-a-bug / Request-a-feature messages, sent by the same bot (KANBAN_TELEGRAM_BOT_TOKEN). Unset: KANBAN_TELEGRAM_CHAT_ID. The bot must be a member of that chat (for a channel: an admin allowed to post)',
  'KANBAN_REPORT_TELEGRAM_API_URL': '(optional) Telegram Bot API base for Report-a-bug messages (default https://api.telegram.org); for a local stub such as scripts/stub-telegram.mjs. Ignored (with a startup warning) when NODE_ENV=production or RAILWAY_ENVIRONMENT/RAILWAY_PROJECT_ID is set',
  'TURNSTILE_SECRET': '(secret) Cloudflare Turnstile secret key for captcha verification',
  'TURNSTILE_SITE_KEY': '(public) Cloudflare Turnstile site key, served to the browser',
  'TURNSTILE_HOSTNAMES': '(optional) Comma-separated siteverify hostname allow-list; unset skips the check',
  'KANBAN_REPORT_DAILY_CAP': '(optional) Global bug-report cap per rolling 24-hour window (default 50)',
  'KANBAN_REPORT_PER_IP_PER_HOUR': '(optional) Per-IP bug-report cap per rolling hour (default 3)',
  'KANBAN_REPORT_GITHUB_API_URL': 'REMOVED, no longer read (was the GitHub API base for Report-a-bug). Safe to delete',
  'TURNSTILE_SITEVERIFY_URL': '(optional) Turnstile siteverify URL (default Cloudflare\'s); for a local stub such as scripts/stub-telegram.mjs only. Ignored (with a startup warning) when NODE_ENV=production or RAILWAY_ENVIRONMENT/RAILWAY_PROJECT_ID is set',
  'KANBAN_ASK_PROVIDER': 'LLM provider for Ask-the-Board: "openrouter" or "ollama" (auto-detected if unset)',
  'KANBAN_ASK_OLLAMA_HOST': 'Base URL for Ollama instance (default http://localhost:11434)',
  'KANBAN_ASK_GITHUB_TOKEN': '(secret) Optional read-only GitHub token for the Ask commit-history lookup; unset = unauthenticated public API',
  'KANBAN_ASK_OLLAMA_AUTH_HEADER': '(secret) Optional Authorization header token for Ollama / tunnel gateway',
  'KANBAN_ASK_OPENROUTER_API_KEY': '(secret) OpenRouter API key; required only for the "openrouter" provider (the default)',
  'KANBAN_ASK_PASSWORD': '(secret) Shared password gate for POST /api/ask — an OWNER credential: by default it grants read access to every project on the board',
  'KANBAN_ASK_SNAPSHOT_PROJECTS': '(optional) Comma-separated allow-list limiting the Ask snapshot to those projects. Unset = every project (owner default)',
  'KANBAN_ASK_MODEL': 'Model id for Ask-the-Board (default openai/gpt-oss-20b for OpenRouter, qwen3.6:latest for Ollama)',
  'KANBAN_ASK_DAILY_CAP': 'Global Ask-the-Board answers cap per UTC day (default 50)',
  'KANBAN_ASK_PER_IP_PER_HOUR': 'Per-IP Ask-the-Board answers cap per hour (default 3)',
  'KANBAN_ASK_TIMEOUT_MS': 'Upstream request timeout for Ask-the-Board in ms (default 45000)',
  'KANBAN_ASK_MAX_PROMPT_TOKENS': 'System-prompt token budget for Ask-the-Board on a hosted provider (default 24000). Ignored for a local Ollama: no budget is applied there',
  'KANBAN_ASK_MAX_OUTPUT_TOKENS': 'Max completion tokens for one Ask-the-Board answer (default 1500)',
  'KANBAN_ASK_INCLUDE_LOGS': 'Card text sent to Ask-the-Board: "redacted" (default, credential-shaped values become [redacted]) or "raw"',
  'PORT': 'HTTP port for the server',
  'HOST': 'Host interface to bind to',
  'VITE_API_BASE': 'Base URL for API calls',
  'VITE_PORT': 'Vite development port',
};

const findEnvVars = (dir, prefix) => {
  const vars = new Set();
  const walk = (currentDir) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
        walk(fullPath);
      } else if (entry.isFile() && !/\.test\./.test(entry.name) && (entry.name.endsWith('.js') || entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name === 'vite.config.ts')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        const regex = new RegExp(`${prefix}(\\w+)`, 'g');
        let match;
        while ((match = regex.exec(content)) !== null) {
          vars.add(match[1]);
        }
      }
    }
  };
  walk(dir);
  return vars;
};

const serverVars = findEnvVars(path.join(repoRoot, 'server'), 'process.env.KANBAN_');
const v = new Set();

const scanForVite = (dir) => {
  const vars = new Set();
  const walk = (curr) => {
    const entries = fs.readdirSync(curr, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(curr, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
        walk(full);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(full, 'utf8');
        const match = content.matchAll(/VITE_(\w+)/g);
        for (const m of match) vars.add(m[1]);
      }
    }
  };
  walk(dir);
  return vars;
};

const viteVars = scanForVite(path.join(repoRoot, 'client'));

const allVars = [];
for (const k of serverVars) {
  allVars.push({ name: `KANBAN_${k}`, scope: 'server' });
}
if (!serverVars.has('PORT')) allVars.push({ name: 'PORT', scope: 'server' });
if (!serverVars.has('HOST')) allVars.push({ name: 'HOST', scope: 'server' });

for (const k of viteVars) {
  allVars.push({ name: `VITE_${k}`, scope: 'client' });
}
if (!viteVars.has('API_BASE')) allVars.push({ name: 'VITE_API_BASE', scope: 'client' });
if (!viteVars.has('PORT')) allVars.push({ name: 'VITE_PORT', scope: 'client' });

const turnstileVars = findEnvVars(path.join(repoRoot, 'server'), 'process.env.TURNSTILE_');
for (const k of turnstileVars) {
  allVars.push({ name: `TURNSTILE_${k}`, scope: 'server' });
}

// A handful of variables are documented but read through a config object
// (`env.KANBAN_*`) rather than `process.env.KANBAN_*`, so the source scan above
// cannot see them. Include every described name that the scan missed, keeping
// the reference complete.
for (const name of Object.keys(DESCRIPTIONS)) {
  if (!allVars.some((item) => item.name === name)) {
    allVars.push({ name, scope: name.startsWith('VITE_') ? 'client' : 'server' });
  }
}

allVars.sort((a, b) => a.name.localeCompare(b.name));

const docPath = path.join(repoRoot, 'docs/CONFIGURATION.md');
const docDir = path.dirname(docPath);
if (!fs.existsSync(docDir)) fs.mkdirSync(docDir, { recursive: true });

let md = `# Configuration\n\n`;
md += `Generated by scripts/gen-config-reference.mjs — run: \`node scripts/gen-config-reference.mjs\`\n\n`;
md += `| Variable | Scope | Description |\n`;
md += `| :--- | :--- | :--- |\n`;

for (const item of allVars) {
  const desc = DESCRIPTIONS[item.name] || '';
  if (!desc) {
    console.error(`Missing description for: ${item.name}`);
    process.exit(1);
  }
  md += `| \`${item.name}\` | ${item.scope} | ${desc} |\n`;
}

fs.writeFileSync(docPath, md);
console.log(`Created ${docPath}`);
