#!/usr/bin/env node
/**
 * Header layout guard: the header toolbar must not grow taller/wrap an extra
 * row at any of the widths below.
 *
 * WHY THIS EXISTS (v2.16.0 review round 2). A standalone, always-visible
 * "Report a bug" button added to the header's flex toolbar cost just enough
 * width to push the row onto an extra line at several mid viewports (824px:
 * 120px either way, already two rows; 1100px: 120px vs the feature-off 82px
 * — the theme toggle was orphaned onto its own row). A className assertion
 * cannot know how the browser actually wraps a flex row; this measures the
 * REAL rendered header height, the same way scripts/check-card-layout.mjs
 * measures real card geometry instead of trusting a class string.
 *
 * The fix moved the entry point inside HeaderHelp's existing `absolute`-
 * positioned "i" popover, which costs zero width in the toolbar's flex
 * layout by construction — but "by construction" is exactly the kind of
 * claim this guard exists to verify empirically, and to keep verifying on
 * every future change to the header.
 *
 * Expected heights are the board's OWN real breakpoints (measured against
 * this exact header, feature on AND off — see CHANGELOG v2.16.0 "Fixed"):
 * phones collapse to the single-row chrome (~84px), the header/filter
 * disclosure range doubles up (~120px) until `lg`, then settles back to a
 * single row (~49-82px). A small tolerance absorbs font-rendering variance
 * across runner images; it must NOT absorb a whole extra wrapped row.
 *
 * Dependency-free, same CDP-over-WebSocket approach as check-card-layout.mjs
 * and check-browser-smoke.mjs — no puppeteer/playwright.
 *
 * Usage:
 *   node scripts/check-header-layout.mjs <base-url> [cdp-port]
 *
 * Exit 0 = every width stays within tolerance of its expected height.
 * Exit 1 = at least one width grew (wrapped an extra row).
 * Exit 2 = environmental skip/error (no Chrome / no server / no page).
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

// width -> { expected, tolerance }. Measured against a real Chromium build
// of this exact client (see CHANGELOG v2.16.0 "Fixed" for the ON/OFF table);
// identical with the bug-report feature on or off, in both themes.
const EXPECTATIONS = {
  320: 84, 360: 84, 390: 84,
  768: 120, 824: 120, 900: 120, 1024: 120,
  1100: 82,
  1280: 49, 1440: 49, 1920: 49,
};
const TOLERANCE_PX = 6;

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
    for (const m of [...txt.matchAll(/ws:\/\/127\.0\.0\.1:(\d+)/g)].slice(-3)) {
      const p = Number(m[1]);
      if (!list.includes(p)) list.push(p);
    }
  }
  for (const d of defs) if (!list.includes(d)) list.push(d);
  return list;
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

const HEADER_HEIGHT_PROBE = `(() => {
  const h = document.querySelector('header');
  return h ? Math.round(h.getBoundingClientRect().height) : null;
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
    } catch (e) { tried.push(`${port}:${e.message}`); }
  }
  if (!target) {
    console.error('header layout guard: no reachable Chrome DevTools page target.');
    console.error('  tried -> ' + tried.join(', '));
    process.exit(2);
  }
  if (!WS) {
    console.error('header layout guard: global WebSocket unavailable (needs Node 22+)');
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
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1024, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url: BASE });

  // Wait for the header to actually exist before measuring anything.
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    const r = await send('Runtime.evaluate', { expression: HEADER_HEIGHT_PROBE, returnByValue: true });
    if (r.result && typeof r.result.value === 'number') { ready = true; break; }
  }
  if (!ready) {
    ws.close();
    console.error('header layout guard: header never rendered within 15s');
    process.exit(2);
  }

  const offenders = [];
  const measured = {};
  for (const [widthStr, expected] of Object.entries(EXPECTATIONS)) {
    const width = Number(widthStr);
    await send('Emulation.setDeviceMetricsOverride', {
      width, height: 900, deviceScaleFactor: 1, mobile: width < 768,
    });
    // Let layout settle after the viewport resize.
    await new Promise((r) => setTimeout(r, 150));
    const r = await send('Runtime.evaluate', { expression: HEADER_HEIGHT_PROBE, returnByValue: true });
    const h = r.result && r.result.value;
    measured[width] = h;
    if (typeof h !== 'number') {
      offenders.push({ width, expected, actual: h, reason: 'header missing' });
      continue;
    }
    if (h > expected + TOLERANCE_PX) {
      offenders.push({ width, expected, actual: h, reason: `+${h - expected}px over tolerance` });
    }
  }
  ws.close();

  console.log(`header layout guard (CDP :${usedPort}): ${JSON.stringify(measured)}`);
  if (offenders.length === 0) {
    console.log(`  OK — header height stayed within ${TOLERANCE_PX}px of baseline at every tested width`);
    process.exit(0);
  }
  console.error(`  FAIL — ${offenders.length} width(s) grew past the expected header height:`);
  for (const o of offenders) {
    console.error(`    ${o.width}px: expected <= ${o.expected + TOLERANCE_PX}, got ${o.actual}  (${o.reason})`);
  }
  process.exit(1);
}

main().catch((e) => { console.error('header layout guard error:', e.message); process.exit(2); });
