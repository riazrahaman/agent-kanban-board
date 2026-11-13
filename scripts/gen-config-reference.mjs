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
  'KANBAN_AUTH_RATE_LIMIT_PER_MIN': 'Failed auth attempts per client address per window before failures are answered 429 (default 60, or KANBAN_RATE_LIMIT_PER_MIN when set; 0 disables). Valid credentials are still served; an address over 10x the limit is refused outright until the window ends. Set KANBAN_TRUST_PROXY=0 when exposed directly without a reverse proxy, otherwise X-Forwarded-For is trusted. Ask-the-Board wrong-password backoff reads it with its own default of 10',
  'KANBAN_AUTH_SECRET': 'HMAC secret enabling stateless session tokens',
  'KANBAN_AUTH_TOKEN': 'Global shared token gating every mutating request',
  'KANBAN_AUTO_PROMOTE': 'Set falsy to disable auto-promoting unblocked tasks',
  'KANBAN_BACKUP_ENABLED': 'Set truthy to enable periodic on-disk backups',
  'KANBAN_BACKUP_INTERVAL_MS': 'Backup interval in milliseconds (default 600000)',
  'KANBAN_BACKUP_KEEP': 'How many backup snapshots to retain (default 10)',
  'KANBAN_BOARD_URL': 'Board base URL used in Telegram reclaim alerts',
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
  'KANBAN_MAX_SSE_STREAMS': 'Cap on concurrent SSE connections (default 100)',
  'KANBAN_MAX_SSE_STREAMS_PER_IP': 'Cap on concurrent SSE connections per client IP (default 20; negative disables; still bounded by the global cap). Keys on req.ip, so set KANBAN_TRUST_PROXY correctly behind a proxy',
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
  'KANBAN_STORAGE_JOURNAL': 'Set to "1" to enable the append-only JSON journal',
  'KANBAN_TELEGRAM_BOT_TOKEN': 'Telegram bot token for reclaim alerts',
  'KANBAN_TELEGRAM_CHAT_ID': 'Telegram chat id that receives reclaim alerts',
  'KANBAN_TRASH_DAYS': 'Days a soft-deleted task stays in the trash sink (default 30)',
  'KANBAN_TRUST_PROXY': 'Express "trust proxy" setting; hop count behind a reverse proxy (default 1)',
  'KANBAN_REPORT_GITHUB_TOKEN': '(secret) Fine-grained PAT with Issues: write, used to file bug reports',
  'KANBAN_REPORT_REPO': 'GitHub repository bug reports are filed against (owner/name)',
  'TURNSTILE_SECRET': '(secret) Cloudflare Turnstile secret key for captcha verification',
  'TURNSTILE_SITE_KEY': '(public) Cloudflare Turnstile site key, served to the browser',
  'TURNSTILE_HOSTNAMES': '(optional) Comma-separated siteverify hostname allow-list; unset skips the check',
  'KANBAN_REPORT_DAILY_CAP': '(optional) Global bug-report cap per UTC day (default 50)',
  'KANBAN_REPORT_PER_IP_PER_HOUR': '(optional) Per-IP bug-report cap per hour (default 3)',
  'KANBAN_REPORT_GITHUB_API_URL': '(optional) GitHub API base URL (default https://api.github.com)',
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
