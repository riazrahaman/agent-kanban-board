#!/usr/bin/env node
/**
 * Browser smoke test (v2.9.0, ENH-07).
 *
 * WHY THIS EXISTS. The card-layout guard measures ONE symptom (wrapped card
 * headers) on whatever data happens to be on the board. This smoke test goes a
 * step further: it seeds a worst-case fixture project and then drives a real
 * headless Chrome to assert the board still renders cleanly — cards present, no
 * page-level horizontal overflow, and zero uncaught page errors. A layout or
 * render regression that isn't a wrapped header (e.g. a crash in a card, a new
 * overlay that breaks the page width) is caught here.
 *
 * Dependency-free: it talks to the Chrome DevTools Protocol over the WebSocket
 * the browser harness exposes (Node 22+), same as scripts/check-card-layout.mjs.
 *
 * Usage:
 *   node scripts/check-browser-smoke.mjs <base-url> [cdp-port]
 *   node scripts/check-browser-smoke.mjs http://127.0.0.1:4100
 *
 * Exit 0 = clean, exit 1 = a rendered defect, exit 2 = environmental skip/error
 * (no Chrome / no server). A missing browser is treated as SKIP so CI on a
 * machine without Chrome does not fail spuriously — the caller warns.
 */
import http from 'node:http';
import { homedir as homeDir } from 'node:os';
import {
  existsSync as existsDir,
  readdirSync as readdirSafe,
  statSync as statMtimeOf,
  readFileSync as readRaw,
} from 'node:fs';

const readSafe = (f) => { try { return readRaw(f, 'utf8'); } catch { return ''; } };
const WS = globalThis.WebSocket;

const BASE = process.argv[2] || 'http://127.0.0.1:4100';
const PORT_ARG = process.argv[3] || process.env.CDP_PORT;
const TOKEN = process.env.KANBAN_AUTH_TOKEN || '';
const PROJECT = process.env.SMOKE_PROJECT || 'smokefixture';

// Worst-case strings — long unbreakable tokens + unicode, to stress wrapping.
const LONG_TOKEN = 'AOV_BUILD_PROGRESS/TEST_REPORT/HANDOVER_2026/CHANGELOG_SUMMARY_AND_NOTES_EXTREMELY_LONG';
const UNICODE_TITLE = 'Émoji ✅ 日本語タイトル — a long multilingual card title that must wrap gracefully, not overflow';
const PROJECT_LONG = 'smokefixture-with-a-very-long-project-name-0123456789';

function candidatePorts() {
  const list = [];
  if (PORT_ARG) list.push(Number(PORT_ARG));
  for (const d of [9222, 9223, 9224]) list.push(d);
  const logs = [];
  for (const dir of ['.config/browser-harness/tmp', '.config/browser-harness']) {
    const full = pathJoin(homeDir(), dir);
    if (!existsDir(full)) continue;
    for (const f of readdirSafe(full)) {
      if (!f.endsWith('.log')) continue;
      logs.push({ file: f, mtime: statMtime(full + '/' + f) });
    }
  }
  logs.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of logs.slice(0, 6)) {
    const txt = readSafe(homeDir() + '/.config/browser-harness/tmp/' + file);
    for (const m of [...txt.matchAll(/ws:\/\/127\.0\.0\.1:(\d+)/g)].slice(-3)) {
      const p = Number(m[1]);
      if (!list.includes(p)) list.push(p);
    }
  }
  return [...new Set(list)];
}
function pathJoin(a, b) { return a + '/' + b; }
function statMtime(p) { try { return statMtimeOf(p).mtimeMs; } catch { return 0; } }

function getJSON(path, port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: port || 9222, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

/** Seeds the fixture project straight through the REST API (no browser needed). */
async function seed() {
  const call = (route, opts = {}) =>
    fetch(`${BASE}${route}`, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(TOKEN ? { 'x-api-token': TOKEN } : {}),
        'x-agent-id': 'ci-smoke',
        'x-agent-role': 'admin',
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

  // Best-effort purge any previous run (admin token required for destructive ops).
  await call(`/api/tasks/purge?project=${PROJECT}`, {
    method: 'POST',
    body: { filter: { project: PROJECT } },
  }).catch(() => {});

  const cards = [
    { id: 'smoke-1', title: UNICODE_TITLE, status: 'BACKLOG', priority: 'high' },
    { id: 'smoke-2', title: `Long id: ${LONG_TOKEN}`, status: 'BUILDING', priority: 'low' },
    { id: 'smoke-3', title: 'A card with a description', status: 'IN_REVIEW',
      description: 'A moderately long description that should wrap inside the card body without breaking the page width. '.repeat(4) },
    { id: 'smoke-4', title: 'DONE card', status: 'DONE' },
  ];
  let created = 0;
  for (const c of cards) {
    const res = await call('/api/tasks', {
      method: 'POST',
      body: { ...c, project: PROJECT, round: 1 },
    });
    if (res.ok) created++;
  }
  return created;
}

const PROBE = `(() => {
  const cards = [...document.querySelectorAll('[data-id]')];
  const docOverflow = Math.round(
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  const headerH = Math.round((document.querySelector('header')?.getBoundingClientRect().height) || 0);
  return {
    cards: cards.length,
    docOverflowPx: docOverflow,
    headerH,
    title: document.title,
    bodyText: (document.body.innerText || '').slice(0, 200),
  };
})()`;

async function main() {
  const created = await seed().catch((e) => {
    console.error(`smoke: could not seed fixture (${e.message}) — is the server up at ${BASE}?`);
    process.exit(2);
  });
  if (created === 0) {
    console.error('smoke: seeded 0 cards — the API rejected the fixture (check the token/role)');
    process.exit(2);
  }

  let target = null;
  const tried = [];
  for (const port of candidatePorts()) {
    try {
      const list = await getJSON('/json/list', port);
      const t = (list || []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) { target = { ...t, port }; break; }
      tried.push(`${port}:no-page`);
    } catch (e) { tried.push(`${port}:${e.message}`); }
  }
  if (!target) {
    console.error('smoke: no reachable Chrome DevTools page target — SKIP');
    console.error('  tried -> ' + tried.join(', '));
    process.exit(2);
  }
  if (!WS) {
    console.error('smoke: global WebSocket unavailable (needs Node 22+) — run on the 22.x leg');
    process.exit(2);
  }

  const ws = new WS(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails;
      pageErrors.push(d?.exception?.description || d?.text || 'unknown exception');
    }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };

  await send('Runtime.enable');
  await send('Page.enable');
  // Deep-link the fixture project so the assertion is deterministic.
  await send('Page.navigate', { url: `${BASE}/?project=${encodeURIComponent(PROJECT)}` });

  let result = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    const v = r.result && r.result.value;
    if (v && v.cards > 0) { result = v; break; }
  }
  ws.close();

  if (!result) {
    console.error('smoke: board never rendered the fixture cards within 15s');
    process.exit(1);
  }

  const problems = [];
  if (result.cards < 1) problems.push(`expected fixture cards, saw ${result.cards}`);
  if (result.docOverflowPx > 1) problems.push(`page overflows horizontally by ${result.docOverflowPx}px`);
  if (pageErrors.length) problems.push(`${pageErrors.length} page error(s): ${pageErrors.join(' | ')}`);

  console.log(`smoke: rendered ${result.cards} fixture card(s) (CDP :${target.port}), header ${result.headerH}px`);
  if (problems.length === 0) {
    console.log('  OK — fixture rendered, no horizontal overflow, zero page errors');
    process.exit(0);
  }
  console.error('  FAIL — ' + problems.join('; '));
  process.exit(1);
}

main().catch((e) => { console.error('smoke error:', e.message); process.exit(2); });
