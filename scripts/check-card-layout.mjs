#!/usr/bin/env node
/**
 * Layout guard: verify every task card's header row renders on ONE line.
 *
 * WHY THIS EXISTS. The 2.3.8 release fixed a long-token overflow by putting
 * `overflow-wrap:anywhere` on the card's id <span>. That silently introduced a
 * WORSE defect: `anywhere` lowers an element's min-content size, and in the
 * header's flex row (min-width:auto, flex-shrink:1) the span then absorbed
 * nearly all the shrink, collapsing `init-agent-investment-advisor` into a
 * ~30px sliver wrapped character-by-character over 11 lines. 64 of 142 live
 * cards had a multi-line header id.
 *
 * The unit suite could not catch it: an assertion on a className string cannot
 * know how the browser lays that class out. This script measures the REAL
 * rendered geometry of every card and fails on the layout symptom itself.
 *
 * It is deliberately dependency-free (no puppeteer): it drives the Chrome
 * DevTools Protocol over the WebSocket that the browser-harness already
 * exposes, or reuses an existing target if one is available.
 *
 * Usage:
 *   node scripts/check-card-layout.mjs <base-url> [cdp-port]
 *   node scripts/check-card-layout.mjs http://127.0.0.1:4100
 *
 * Exit 0 = every card header is single-line. Exit 1 = at least one is not.
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

// `WebSocket` is a global on Node 22+ but NOT on Node 20, so this guard is run
// on the 22.x CI leg only (see the workflow's `if:`). It is a browser-layout
// integration check — Node-version independent — so running it once per push is
// the right coverage, and the unit/server matrix still exercises both versions.
const WS = globalThis.WebSocket;

const BASE = process.argv[2] || 'http://127.0.0.1:4100';
const PORT_ARG = process.argv[3] || process.env.CDP_PORT;

/**
 * Resolves the Chrome DevTools port. Harnesses often launch Chrome with
 * `--remote-debugging-port=0` (an ephemeral port) and record the real endpoint
 * in a log, so a hardcoded 9222 is not reliable. Order: explicit argument ->
 * CDP_PORT -> the most recent `ws://127.0.0.1:<port>` found in a harness log ->
 * the common defaults.
 */
function candidatePorts() {
  const list = [];
  if (PORT_ARG) list.push(Number(PORT_ARG));
  const defs = [9222, 9223, 9224];
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
    const matches = [...txt.matchAll(/ws:\/\/127\.0\.0\.1:(\d+)/g)];
    for (const m of matches.slice(-3)) {
      const p = Number(m[1]);
      if (!list.includes(p)) list.push(p);
    }
  }
  for (const d of defs) if (!list.includes(d)) list.push(d);
  return list;
}

function pathJoin(a, b) { return a + '/' + b; }
function statMtime(p) { try { return statMtimeOf(p).mtimeMs; } catch { return 0; } }

// Max header height for a single-line row: the id is text-xs (16px line box)
// plus p-3 padding on the card. Anything past this means the row wrapped.
const MAX_HEADER_PX = 26;
const MAX_HORIZONTAL_OVERFLOW_PX = 1;

function getJSON(path, port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: port || 9222, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

// The probe runs INSIDE the page. Kept as a string so it can be evaluated.
const PROBE = `(() => {
  const MAX_HEADER = ${MAX_HEADER_PX};
  const cards = [...document.querySelectorAll('[data-id]')];
  if (!cards.length) return { error: 'no cards found — is the board scrolled/loaded?', cards: 0 };
  const offenders = [];
  let checked = 0;
  for (const c of cards) {
    const hdr = c.querySelector('div');
    if (!hdr) continue;
    const s = hdr.querySelector('span');
    if (!s) continue;
    checked++;
    const h = Math.round(hdr.getBoundingClientRect().height);
    const cardR = c.getBoundingClientRect();
    let over = 0;
    for (const k of hdr.children) {
      over = Math.max(over, Math.round(k.getBoundingClientRect().right - (cardR.right - 12)));
    }
    // Count the rendered text lines of the id span, which is the precise symptom.
    let lines = 0;
    for (const nd of s.childNodes) {
      if (nd.nodeType !== 3) continue;
      const r = document.createRange();
      r.selectNodeContents(nd);
      for (const cr of r.getClientRects()) if (cr.width > 0.5) lines++;
    }
    if (h > MAX_HEADER || over > ${MAX_HORIZONTAL_OVERFLOW_PX}) {
      offenders.push({ id: c.dataset.id, headerH: h, idLines: lines, overflowPx: over });
    }
  }
  offenders.sort((a, b) => b.idLines - a.idLines || b.overflowPx - a.overflowPx);
  return { cards: cards.length, checked, offenders: offenders.slice(0, 20), offenderCount: offenders.length };
})()`;

async function main() {
  let target = null;
  let usedPort = null;
  const tried = [];
  for (const port of candidatePorts()) {
    try {
      const list = await getJSON('/json/list', port);
      const t = (list || []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) { target = t; usedPort = port; break; }
      tried.push(`${port}:no-page`);
    } catch (e) {
      tried.push(`${port}:${e.message}`);
    }
  }
  if (!target) {
    console.error('layout guard: no reachable Chrome DevTools page target.');
    console.error('  tried -> ' + tried.join(', '));
    console.error('  start Chromium with --remote-debugging-port=9222 (or pass the port as arg 2 / CDP_PORT)');
    process.exit(2);
  }

  // Fail fast BEFORE constructing: `new undefined` would throw an opaque
  // TypeError instead of the message below.
  if (!WS) {
    console.error('layout guard: global WebSocket unavailable (needs Node 22+) — run this on the 22.x leg');
    process.exit(2);
  }

  const ws = new WS(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };

  await send('Page.enable');
  await send('Page.navigate', { url: BASE });
  // Give the SPA time to fetch tasks and paint cards. Cards arrive after a
  // network round-trip, so poll rather than sleeping a fixed guess.
  let result = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    const v = r.result && r.result.value;
    if (v && !v.error && v.cards > 0) { result = v; break; }
    if (v && v.error) result = v;
  }
  ws.close();

  if (!result) {
    console.error('layout guard: board never rendered cards within 15s');
    process.exit(2);
  }
  if (result.error) {
    console.error(`layout guard: ${result.error}`);
    process.exit(2);
  }

  console.log(`layout guard: checked ${result.checked} of ${result.cards} cards (CDP :${usedPort})`);
  if (result.offenderCount === 0) {
    console.log(`  OK — every card header renders on one line (<= ${MAX_HEADER_PX}px, no horizontal overflow)`);
    process.exit(0);
  }
  console.error(`  FAIL — ${result.offenderCount} card(s) have a wrapped/squashed header:`);
  for (const o of result.offenders) {
    console.error(`    ${o.id}  headerH=${o.headerH}px  idLines=${o.idLines}  overflow=${o.overflowPx}px`);
  }
  process.exit(1);
}

main().catch((e) => { console.error('layout guard error:', e.message); process.exit(2); });
