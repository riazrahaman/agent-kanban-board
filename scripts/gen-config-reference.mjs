#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const DESCRIPTIONS = {
  'KANBAN_ADMIN_TOKEN': 'Admin token that spans every project (audited as admin_write)',
  'KANBAN_ALLOWED_ORIGIN': 'Comma-separated CORS origin allow-list',
  'KANBAN_ARCHIVE_AFTER_DAYS': 'Days a DONE task waits before the archive sweep moves it',
  'KANBAN_ARCHIVING_DISABLED': 'Set truthy to disable the automatic archive sweep',
  'KANBAN_AUDIT_LOG': 'Set truthy to persist the audit stream as JSONL',
  'KANBAN_AUTH_LOG': 'Set truthy to log redacted auth failures',
  'KANBAN_AUTH_RATE_LIMIT_PER_MIN': 'Per-IP limit for failed auth/handshake attempts',
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
  'KANBAN_GIT_COMMIT': 'Set falsy to skip the per-transition git commit',
  'KANBAN_GIT_DIR': 'Directory for the git-backed YAML storage backend',
  'KANBAN_INLINE_COMMENT_CAP': 'Inline comments kept per task before spilling (default 50)',
  'KANBAN_INLINE_LOG_CAP': 'Inline agent-log entries kept per task before spilling (default 50)',
  'KANBAN_JOURNAL_COMPACT_BYTES': 'Journal size that triggers compaction (default 1MB)',
  'KANBAN_MAX_SSE_STREAMS': 'Cap on concurrent SSE connections (default 100)',
  'KANBAN_NOTIFY_EVENTS': 'Comma-separated reclaim reasons that trigger an alert',
  'KANBAN_NOTIFY_INCLUDE_DESC': 'Set falsy to omit the task description from alerts',
  'KANBAN_NOTIFY_MIN_INTERVAL_MS': 'Minimum gap between outbound notifications',
  'KANBAN_NOTIFY_PROJECTS': 'Comma-separated allow-list of projects that notify',
  'KANBAN_ORPHAN_GRACE_MS': 'Grace before an ownerless active task is normalized (default 300000)',
  'KANBAN_PROJECT_TOKENS': 'JSON map of project id to per-project token',
  'KANBAN_RATE_LIMIT_PER_MIN': 'Per-project mutation limit per window (0 disables)',
  'KANBAN_RATE_LIMIT_WINDOW_MS': 'Fixed rate-limit window in milliseconds (default 60000)',
  'KANBAN_READ_AUTH': 'Set to "token" to require auth on reads and SSE',
  'KANBAN_REAP_ENABLED': 'Set falsy to disable the background lease reaper',
  'KANBAN_REAP_INTERVAL_MS': 'Lease reaper sweep interval (default 30000)',
  'KANBAN_STORAGE_BACKEND': 'Persistence backend: "json" or "git"',
  'KANBAN_STORAGE_JOURNAL': 'Set to "1" to enable the append-only JSON journal',
  'KANBAN_TELEGRAM_BOT_TOKEN': 'Telegram bot token for reclaim alerts',
  'KANBAN_TELEGRAM_CHAT_ID': 'Telegram chat id that receives reclaim alerts',
  'KANBAN_TRASH_DAYS': 'Days a soft-deleted task stays in the trash sink (default 30)',
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
