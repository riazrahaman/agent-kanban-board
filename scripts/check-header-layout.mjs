#!/usr/bin/env node
/**
 * Header layout guard: (1) the header toolbar must not grow taller/wrap an
 * extra row at any of the widths below, and (2) the "i" help popover (which
 * now also hosts the Report-a-bug entry, v2.16.0) must stay fully inside the
 * viewport with a safe margin at every width.
 *
 * WHY THIS EXISTS (v2.16.0 review rounds 2-4). Round 2: a standalone,
 * always-visible "Report a bug" header button cost just enough width to
 * wrap the toolbar onto an extra row at several mid viewports. Round 4: the
 * fix (moving the entry into HeaderHelp's "i" popover) introduced its own
 * defect — `absolute right-0 w-80` clips off the LEFT edge of the viewport
 * whenever the anchor button sits less than 320px from the left edge,
 * measured at 320-390px (~44% clipped) and again at 768-820px (the full
 * header-controls row crowds the button rightward). Neither defect is a
 * className a unit test can see; both are rendered-geometry outcomes, the
 * same reasoning scripts/check-card-layout.mjs gives for driving a real
 * browser instead of asserting a class string.
 *
 * TWO baselines, because TWO real pointer environments produce two
 * genuinely different (and both correct) header heights:
 *
 *   - NON-COARSE (`EXPECTATIONS`, below): a desktop browser window resized
 *     narrow — `pointer: coarse` never matches, so the `pointer-coarse:`
 *     Tailwind variants (44px touch targets on several header controls)
 *     never apply. 84/120/49px. This is what `Emulation.setDeviceMetricsOverride`
 *     alone measures, and it is ALL this guard verified through round 4.
 *   - COARSE (`COARSE_EXPECTATIONS`, below): a REAL touch phone/tablet, where
 *     `pointer: coarse` DOES match, growing the `⋯` toggle (and other
 *     controls) to a 44px minimum and the header along with it:
 *     113/155/101/67px. Round-4 CHANGELOG language claiming "84px, not
 *     113px" was WRONG — both are real, for different pointer types, and
 *     ON == OFF in both. `Emulation.setDeviceMetricsOverride`'s own `mobile`
 *     flag does NOT reliably flip `pointer: coarse` in headless Chrome
 *     either way, which is why an earlier pass toggling it produced neither
 *     number cleanly. `Emulation.setTouchEmulationEnabled` is what actually
 *     flips the media query (verified below) — see the second pass.
 *
 * Both are two-sided on purpose (not just a ceiling): dropping BELOW
 * baseline can mean content silently went missing just as much as growing
 * above it can mean an extra wrapped row.
 *
 * Dependency-free, same CDP-over-WebSocket approach as check-card-layout.mjs
 * and check-browser-smoke.mjs — no puppeteer/playwright.
 *
 * Usage:
 *   node scripts/check-header-layout.mjs <base-url> [cdp-port]
 *
 * Exit 0 = every width stays within tolerance on both guards.
 * Exit 1 = a header-height or popover-containment regression.
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

// width -> expected header height (px), NON-COARSE pointer (desktop window
// resize). Real-Chromium ground truth — see the file header comment.
// Identical with the bug-report feature on or off, in both themes.
const EXPECTATIONS = {
  320: 84, 360: 84, 390: 84,
  768: 120, 820: 120, 824: 120, 900: 120, 1024: 120,
  1100: 82,
  1280: 49, 1440: 49, 1920: 49,
};
// width -> expected header height (px), COARSE pointer (real touch phone/
// tablet — `pointer-coarse:min-h-11` 44px targets grow several header
// controls). Same real-Chromium measurement, `Emulation.setTouchEmulationEnabled`
// forcing `pointer: coarse` to match. Checked at a subset of widths — the
// same ones CONTAINMENT_WIDTHS below already covers.
const COARSE_EXPECTATIONS = {
  320: 113, 768: 155, 1100: 101, 1280: 67,
};
// Two-sided: a height BELOW baseline-tolerance can mean content silently
// disappeared just as much as ABOVE can mean a wrapped row.
const TOLERANCE_PX = 6;

// The popover's bounding box must stay within [MARGIN_PX, innerWidth -
// MARGIN_PX] on both edges at every width.
const POPOVER_MARGIN_PX = 8;
const CONTAINMENT_WIDTHS = [320, 360, 390, 768, 820, 1024, 1280, 1440];

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

// Each popover-containment check is a SEQUENCE of small scripts, with a real
// settle delay between them (see the call sites below) rather than one
// cram-everything-into-one-script-evaluation. React's state updates (the
// phone disclosure opening, then the popover opening) are NOT guaranteed to
// have committed to the DOM by the next synchronous line in the SAME script
// — clicking the disclosure toggle and the "i" button back-to-back with no
// render in between left the popover never opening (and, worse, left the
// disclosure's `headerOpen` state stuck on for the NEXT width's
// measurement). A real user's two separate clicks always have an event-loop
// turn between them; this gives the harness the same thing.
const FIND_TOGGLE = `(() => {
  const toggle = [...document.querySelectorAll('button')]
    .find((b) => b.getAttribute('aria-label') === 'Toggle board controls');
  const visible = !!toggle && toggle.getClientRects().length > 0;
  if (visible) toggle.click();
  return visible;
})()`;
const CLICK_HELP = `(() => {
  const help = [...document.querySelectorAll('button')]
    .find((b) => b.getAttribute('aria-label') === 'What do the agent id and api token fields do?');
  if (!help) return false;
  help.click();
  return true;
})()`;
const READ_POPOVER = `(() => {
  const popover = document.querySelector('[role="dialog"][aria-label="Operator field reference"]');
  if (!popover) return { error: 'popover did not open' };
  const r = popover.getBoundingClientRect();
  const reportBtn = [...popover.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === 'Report a bug',
  );
  const reportBox = reportBtn ? reportBtn.getBoundingClientRect() : null;
  return {
    innerWidth: window.innerWidth,
    box: { x: r.x, y: r.y, width: r.width, height: r.height },
    hasReportButton: !!reportBtn,
    reportBox: reportBox ? { x: reportBox.x, width: reportBox.width, height: reportBox.height } : null,
  };
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
  // `mobile: false` ALWAYS — see the file header comment. This is a desktop
  // browser window being resized, not a device-type emulation switch.
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1024, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url: BASE });

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

  const heightOffenders = [];
  const containmentOffenders = [];
  const measuredHeights = {};
  const measuredBoxes = {};

  const allWidths = [...new Set([...Object.keys(EXPECTATIONS).map(Number), ...CONTAINMENT_WIDTHS])].sort((a, b) => a - b);

  for (const width of allWidths) {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await new Promise((r) => setTimeout(r, 150));

    if (Object.prototype.hasOwnProperty.call(EXPECTATIONS, width)) {
      const expected = EXPECTATIONS[width];
      const r = await send('Runtime.evaluate', { expression: HEADER_HEIGHT_PROBE, returnByValue: true });
      const h = r.result && r.result.value;
      measuredHeights[width] = h;
      if (typeof h !== 'number') {
        heightOffenders.push({ width, expected, actual: h, reason: 'header missing' });
      } else if (Math.abs(h - expected) > TOLERANCE_PX) {
        heightOffenders.push({
          width, expected, actual: h,
          reason: h > expected ? `+${h - expected}px over` : `-${expected - h}px under`,
        });
      }
    }

    if (CONTAINMENT_WIDTHS.includes(width)) {
      // Step 1: open the phone disclosure, IF it is what currently gates the
      // "i" button (a real settle delay before the next click — see the
      // probe comment above for why this cannot be one synchronous script).
      const toggleStep = await send('Runtime.evaluate', { expression: FIND_TOGGLE, returnByValue: true });
      const toggledOpen = Boolean(toggleStep.result && toggleStep.result.value);
      await new Promise((r) => setTimeout(r, 200));

      // Step 2: open the "i" popover itself.
      const helpStep = await send('Runtime.evaluate', { expression: CLICK_HELP, returnByValue: true });
      const helpClicked = Boolean(helpStep.result && helpStep.result.value);
      await new Promise((r) => setTimeout(r, 200));

      // Step 3: measure.
      const readStep = await send('Runtime.evaluate', { expression: READ_POPOVER, returnByValue: true });
      const v = readStep.result && readStep.result.value;
      measuredBoxes[width] = v;

      // Step 4: close everything back up, so the next width starts from the
      // same default-closed state a real first load would — a settle delay
      // each time, same reasoning as opening.
      if (helpClicked) {
        await send('Runtime.evaluate', { expression: CLICK_HELP, returnByValue: true });
        await new Promise((r) => setTimeout(r, 150));
      }
      if (toggledOpen) {
        await send('Runtime.evaluate', { expression: FIND_TOGGLE, returnByValue: true });
        await new Promise((r) => setTimeout(r, 150));
      }

      if (!helpClicked) {
        containmentOffenders.push({ width, reason: 'help button not found' });
      } else if (!v || v.error) {
        containmentOffenders.push({ width, reason: (v && v.error) || 'no result' });
      } else {
        const { box, innerWidth, hasReportButton, reportBox } = v;
        const leftEdge = box.x;
        const rightEdge = box.x + box.width;
        if (leftEdge < POPOVER_MARGIN_PX) {
          containmentOffenders.push({ width, reason: `left edge at ${Math.round(leftEdge)}px, clipped off-screen (margin ${POPOVER_MARGIN_PX}px)` });
        }
        if (rightEdge > innerWidth - POPOVER_MARGIN_PX) {
          containmentOffenders.push({ width, reason: `right edge at ${Math.round(rightEdge)}px exceeds viewport ${innerWidth}px (margin ${POPOVER_MARGIN_PX}px)` });
        }
        if (!hasReportButton) {
          containmentOffenders.push({ width, reason: 'Report a bug row not found in the popover (feature off, or markup regressed)' });
        } else if (reportBox && (reportBox.x < 0 || reportBox.x + reportBox.width > innerWidth)) {
          containmentOffenders.push({ width, reason: `Report a bug row itself clipped (x=${Math.round(reportBox.x)}, width=${Math.round(reportBox.width)}, viewport=${innerWidth})` });
        }
      }
    }
  }

  // Second pass: COARSE pointer (a real touch phone/tablet), a handful of
  // widths — see COARSE_EXPECTATIONS above for why these numbers legitimately
  // differ from the non-coarse pass. `setDeviceMetricsOverride`'s own
  // `mobile` flag does NOT reliably flip `pointer: coarse` in headless
  // Chrome; `setTouchEmulationEnabled` does (verified against this exact
  // build before being wired in — see CHANGELOG v2.16.0 "Fixed").
  const coarseOffenders = [];
  const measuredCoarseHeights = {};
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: true });
  for (const [widthStr, expected] of Object.entries(COARSE_EXPECTATIONS)) {
    const width = Number(widthStr);
    await send('Emulation.setDeviceMetricsOverride', {
      width, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await new Promise((r) => setTimeout(r, 150));
    const r = await send('Runtime.evaluate', { expression: HEADER_HEIGHT_PROBE, returnByValue: true });
    const h = r.result && r.result.value;
    measuredCoarseHeights[width] = h;
    if (typeof h !== 'number') {
      coarseOffenders.push({ width, expected, actual: h, reason: 'header missing' });
    } else if (Math.abs(h - expected) > TOLERANCE_PX) {
      coarseOffenders.push({
        width, expected, actual: h,
        reason: h > expected ? `+${h - expected}px over` : `-${expected - h}px under`,
      });
    }
  }
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  ws.close();

  console.log(`header layout guard (CDP :${usedPort})`);
  console.log(`  heights (non-coarse): ${JSON.stringify(measuredHeights)}`);
  console.log(`  heights (coarse):     ${JSON.stringify(measuredCoarseHeights)}`);
  console.log(`  popover boxes: ${JSON.stringify(measuredBoxes)}`);

  if (heightOffenders.length === 0 && containmentOffenders.length === 0 && coarseOffenders.length === 0) {
    console.log(`  OK — header height within ${TOLERANCE_PX}px of baseline (both pointer types), popover fully contained (>=${POPOVER_MARGIN_PX}px margin) at every tested width`);
    process.exit(0);
  }
  if (coarseOffenders.length) {
    console.error(`  FAIL — ${coarseOffenders.length} width(s) off the expected COARSE-pointer header height:`);
    for (const o of coarseOffenders) {
      console.error(`    ${o.width}px: expected ${o.expected}±${TOLERANCE_PX}, got ${o.actual}  (${o.reason})`);
    }
  }
  if (heightOffenders.length) {
    console.error(`  FAIL — ${heightOffenders.length} width(s) off the expected header height:`);
    for (const o of heightOffenders) {
      console.error(`    ${o.width}px: expected ${o.expected}±${TOLERANCE_PX}, got ${o.actual}  (${o.reason})`);
    }
  }
  if (containmentOffenders.length) {
    console.error(`  FAIL — ${containmentOffenders.length} popover containment violation(s):`);
    for (const o of containmentOffenders) {
      console.error(`    ${o.width}px: ${o.reason}`);
    }
  }
  process.exit(1);
}

main().catch((e) => { console.error('header layout guard error:', e.message); process.exit(2); });
