#!/usr/bin/env node
// Dated-allowlist gate over `npm audit --json`.
//
// The CI audit step used to run `npm audit --audit-level=high` directly, which
// hard-fails on ANY advisory at or above the level. When an advisory has no
// patched release upstream (GHSA-fc5q-39xc-vjpf: picomatch ReDoS,
// CVE-2026-112366 - every published picomatch is affected and the fix PR is
// still unmerged), the audit cannot be satisfied by any dependency change and
// blocks every commit on main.
//
// This gate keeps the same bar - fail on any advisory at or above --level -
// except for advisories listed in scripts/audit-allowlist.json, where each
// entry carries a written reason and an expiry date. Entries are fail-closed:
// past their expiry they stop exempting anything, so a forgotten allowlist
// entry turns back into a hard failure rather than a silent permanent pass.
//
// Usage:
//   node scripts/npm-audit-gate.mjs --prefix server --level high
//   node scripts/npm-audit-gate.mjs --self-test
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = path.join(__dirname, 'audit-allowlist.json');

const LEVEL_ORDER = { low: 0, moderate: 1, high: 2, critical: 3 };

export function loadAllowlist() {
  const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : (parsed.entries || []);
  return entries.filter((e) => e && e.id);
}

// npm audit --json (report version 2+) keys advisories under
// `vulnerabilities.<package>.via[]`; each `via` entry that is an object carries
// the advisory's `url` (normally a GHSA advisory page). The GHSA id is the
// stable key - module names can appear at several points in one tree.
export function collectAdvisories(report) {
  const advisories = new Map();
  for (const [name, vuln] of Object.entries(report?.vulnerabilities || {})) {
    for (const via of vuln?.via || []) {
      if (typeof via !== 'object' || !via?.url) continue;
      const match = String(via.url).match(/\/(GHSA-[a-zA-Z0-9-]+)/);
      const id = match ? match[1] : String(via.url);
      if (!advisories.has(id)) {
        advisories.set(id, {
          id,
          module: name,
          title: via.title || '(no title)',
          severity: via.severity || vuln.severity,
          url: via.url,
        });
      }
    }
  }
  return advisories;
}

// Pure decision over the audit report, the allowlist and today's date, so the
// logic can be asserted without running npm or the network. `today` is an
// ISO date string; an allowlist entry is active while today <= entry.expires.
export function decide({ report, allowlist, today, level = 'high' }) {
  const minLevel = LEVEL_ORDER[level] ?? LEVEL_ORDER.high;
  const advisories = collectAdvisories(report);
  const inScope = [...advisories.values()].filter(
    (a) => (LEVEL_ORDER[a.severity] ?? LEVEL_ORDER.critical) >= minLevel
  );
  const active = new Map();
  const expired = [];
  for (const entry of allowlist) {
    if (entry.expires && today > entry.expires) {
      expired.push(entry);
      continue;
    }
    active.set(entry.id, entry);
  }
  const failing = inScope.filter((a) => !active.has(a.id));
  return { pass: failing.length === 0, failing, expired, inScope };
}

function runAudit({ prefix, level }) {
  const command = ['npm', '--prefix', prefix, 'audit', '--json', '--audit-level', level];
  try {
    const stdout = execFileSync(command[0], command.slice(1), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (err) {
    // A nonzero exit means npm found in-scope vulnerabilities; the JSON report
    // is still on stdout (npm reports it before exiting). Anything without a
    // report body (network failure, missing lockfile) must fail loudly.
    const stdout = err?.stdout || '';
    if (!stdout.trim().includes('"vulnerabilities"')) {
      console.error(`[audit-gate] npm audit failed without a report (prefix=${prefix})`);
      if (err?.stderr) console.error(String(err.stderr).trim());
      process.exit(1);
    }
    return { ok: false, stdout };
  }
}

export function selfTest() {
  const allowlist = [
    { id: 'GHSA-aaaa-aaaa-aaaa', reason: 'fixture', expires: '2999-12-31' },
    { id: 'GHSA-bbbb-bbbb-bbbb', reason: 'fixture-expired', expires: '2020-01-01' },
  ];
  const report = {
    vulnerabilities: {
      picomatch: {
        severity: 'high',
        via: [
          { url: 'https://github.com/advisories/GHSA-aaaa-aaaa-aaaa', severity: 'high', title: 'fixture active' },
          { url: 'https://github.com/advisories/GHSA-bbbb-bbbb-bbbb', severity: 'high', title: 'fixture expired' },
        ],
      },
      other: {
        severity: 'high',
        via: [{ url: 'https://github.com/advisories/GHSA-cccc-cccc-cccc', severity: 'high', title: 'fixture unlisted' }],
      },
      minor: {
        severity: 'moderate',
        via: [{ url: 'https://github.com/advisories/GHSA-dddd-dddd-dddd', severity: 'moderate', title: 'below level' }],
      },
    },
  };
  const cases = [
    // Active allowlist entry exempts; expired entry does NOT; unlisted high fails.
    ['fail with only an active entry', decide({ report, allowlist: [allowlist[0]], today: '2026-11-18', level: 'high' }), false, ['GHSA-bbbb-bbbb-bbbb', 'GHSA-cccc-cccc-cccc']],
    // Expired entries are surfaced so the drift is visible.
    ['expired entry is reported', decide({ report, allowlist, today: '2026-11-18', level: 'high' }), false, ['GHSA-bbbb-bbbb-bbbb', 'GHSA-cccc-cccc-cccc']],
    // Below-level advisories never block.
    ['moderate advisory under --level high passes', decide({ report, allowlist: [], today: '2026-11-18', level: 'high' }), false, ['GHSA-aaaa-aaaa-aaaa', 'GHSA-bbbb-bbbb-bbbb', 'GHSA-cccc-cccc-cccc']],
    // Clean report passes even with an empty allowlist.
    ['clean report passes', decide({ report: { vulnerabilities: {} }, allowlist: [], today: '2026-11-18', level: 'high' }), true, []],
    // Today on the expiry date itself is still inside the window.
    ['expiry date is inclusive', decide({ report: { vulnerabilities: { p: { severity: 'high', via: [{ url: 'https://github.com/advisories/GHSA-aaaa-aaaa-aaaa', severity: 'high' }] } } }, allowlist: [allowlist[0]], today: '2999-12-31', level: 'high' }), true, []],
  ];
  let failed = 0;
  for (const [label, result, expectPass, expectFailing] of cases) {
    const gotPass = result.pass;
    const gotFailing = result.failing.map((f) => f.id).sort();
    const wantFailing = [...expectFailing].sort();
    if (gotPass !== expectPass || JSON.stringify(gotFailing) !== JSON.stringify(wantFailing)) {
      failed += 1;
      console.error(`[audit-gate] self-test FAIL: ${label}`);
      console.error(`  pass=${gotPass} want=${expectPass} failing=${JSON.stringify(gotFailing)} want=${JSON.stringify(wantFailing)}`);
    }
  }
  if (failed) {
    console.error(`[audit-gate] self-test: ${failed} failure(s)`);
    process.exit(1);
  }
  // Fail-closed expiry: the expired fixture entry must stop exempting AND be
  // surfaced as expired, so a forgotten allowlist entry cannot pass silently.
  const expiredCase = decide({ report, allowlist, today: '2026-11-18', level: 'high' });
  if (expiredCase.expired.length !== 1 || expiredCase.expired[0].id !== 'GHSA-bbbb-bbbb-bbbb') {
    console.error('[audit-gate] self-test FAIL: expired entry not surfaced as expired');
    process.exit(1);
  }
  console.log('[audit-gate] self-test ok (5 cases)');
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const get = (flag) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const prefix = get('--prefix') || 'server';
  const level = get('--level') || 'high';
  const { stdout } = runAudit({ prefix, level });
  const result = decide({ report: JSON.parse(stdout), allowlist: loadAllowlist(), today: new Date().toISOString().slice(0, 10), level });

  if (result.expired.length) {
    for (const entry of result.expired) {
      console.warn(`[audit-gate] ALLOWLIST ENTRY EXPIRED (${entry.expires}): ${entry.id} - ${entry.reason || ''}`);
    }
  }
  if (result.pass) {
    console.log(`[audit-gate] ${prefix}: pass (${result.inScope.length} in-scope advisory(ies))`);
    return;
  }
  console.error(`[audit-gate] ${prefix}: FAIL - ${result.failing.length} unexempted advisory(ies) at or above ${level}:`);
  for (const a of result.failing) {
    console.error(`  ${a.id} (${a.severity}) ${a.module}: ${a.title}`);
    console.error(`    ${a.url}`);
  }
  console.error(`[audit-gate] If this advisory has no upstream fix, add a dated, reasoned entry to scripts/audit-allowlist.json - never widen the level or drop the gate.`);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
