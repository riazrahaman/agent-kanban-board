#!/usr/bin/env node
/**
 * Header layout guard: (1) the header toolbar must not grow taller/wrap an
 * extra row at any of the widths below, whether the Report-a-bug header icon
 * is rendered or not, and (2) the "i" help popover must stay fully inside
 * the viewport with a safe margin at every width.
 *
 * WHY THIS EXISTS (v2.16.0 review rounds 2-4; entry point moved again in
 * v2.17.0). Round 2: a standalone, always-visible "Report a bug" header
 * button cost just enough width to wrap the toolbar onto an extra row at
 * several mid viewports. Round 4: the fix (moving the entry into
 * HeaderHelp's "i" popover) introduced its own defect — `absolute right-0
 * w-80` clips off the LEFT edge of the viewport whenever the anchor button
 * sits less than 320px from the left edge, measured at 320-390px (~44%
 * clipped) and again at 768-820px (the full header-controls row crowds the
 * button rightward). Neither defect is a className a unit test can see;
 * both are rendered-geometry outcomes, the same reasoning
 * scripts/check-card-layout.mjs gives for driving a real browser instead of
 * asserting a class string.
 *
 * v2.17.0 moved the entry point OUT of the popover (which cost zero header
 * width by construction — an `absolute` box) and into an actual icon button
 * living directly in the header's flex row, beside the theme toggle — the
 * ORIGINAL round-2 risk, reintroduced on purpose because a popover entry was
 * still a multi-tap discovery path on a phone. This guard is what proves the
 * EXPECTATIONS/COARSE_EXPECTATIONS baselines below — measured with the
 * feature flag ON (see ci.yml) — are identical to the feature-OFF numbers a
 * clean checkout would measure: the icon+theme button pair shares one
 * border and claws back its own slice of the row's gap (`App.tsx`,
 * `md:-ml-2`, applied only when the icon renders) specifically so adding it
 * costs net-zero toolbar height at every width in both pointer environments
 * — verified by hand against a feature-OFF build before these numbers were
 * committed; this script re-verifies the feature-ON side on every CI run.
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
 *     NOTE ON REAL TOUCH HARDWARE (GH #91): The coarse-pointer pass uses CDP
 *     touch emulation (Emulation.setTouchEmulationEnabled) to trigger
 *     `pointer: coarse` in headless Chromium. Real mobile devices (iOS Safari,
 *     WebKit, physical digitizers, dynamic address bars) still require hand
 *     verification for hardware-specific nuances (e.g. safe-area insets and
 *     keyboard viewport displacement).
 *
 * Both are two-sided on purpose (not just a ceiling): dropping BELOW
 * baseline can mean content silently went missing just as much as growing
 * above it can mean an extra wrapped row.
 *
 * THIRD PASS (v2.17.0 round 3): an independent tester caught a case none of
 * the above sees — Playwright WebKit, `pointer: coarse`, theme mode LIGHT,
 * viewport 1100px: 155px ON vs 101px OFF. AUTO/DARK and most widths were
 * fine; the first two passes above sample too coarse a width grid (12-84px
 * gaps) to land inside the bad band, and they never force a theme mode, so
 * a mode-dependent regression (the LIGHT label rendering a few px wider
 * than AUTO/DARK) was invisible to them even in Chromium, where the SAME
 * class of defect exists in different, equally narrow bands (confirmed by
 * a manual fine sweep during the fix — Chromium was never actually clean,
 * the coarse sample widths above just didn't happen to land on a bad one).
 * The third pass below closes both gaps: it forces each of the three theme
 * modes (`localStorage['theme']` + reload — see client/src/lib/theme.ts)
 * and sweeps every 8px across the known wrap thresholds, for both pointer
 * types. When a second, feature-OFF server URL is supplied (see Usage), it
 * diffs ON against OFF LIVE rather than against a hardcoded table, so it
 * cannot go stale the way a hand-verified comment can; without one it falls
 * back to FINE_EXPECTATIONS/FINE_COARSE_EXPECTATIONS, captured the same way
 * the first two passes' tables were.
 *
 * Dependency-free, same CDP-over-WebSocket approach as check-card-layout.mjs
 * and check-browser-smoke.mjs — no puppeteer/playwright.
 *
 * Usage:
 *   node scripts/check-header-layout.mjs <base-url> [cdp-port] [off-base-url]
 *
 * BOTH servers must hold the SAME seeded tasks, including one task assigned
 * to a very long agent id. Since the board filter row docks into the header
 * on desktop, the header's height depends on whether the board has tasks
 * (the filters only render then) — an empty OFF board against a seeded ON
 * board would diff a docked header against an undocked one and fail for a
 * reason that has nothing to do with the bug icon. The long assignee is what
 * lets this guard see a docked <select> growing with its options.
 *
 * <off-base-url> is optional: a second server with the bug-report feature
 * OFF, for a live ON-vs-OFF diff in the third pass (see ci.yml).
 *
 * NOTE ON CI FEATURE ENVIRONMENT (GH #91): In CI, the primary test server
 * must be run with the bug-report environment variables configured
 * (KANBAN_REPORT_GITHUB_TOKEN, KANBAN_REPORT_REPO, TURNSTILE_SECRET, TURNSTILE_SITE_KEY).
 * If the primary server were booted with the feature OFF, the test would merely diff
 * feature-off against feature-off and vacuously pass, defeating the purpose of
 * verifying that the rendered bug report button costs net-zero header height.
 *
 * Exit 0 = every width stays within tolerance on all three guards.
 * Exit 1 = a header-height, wrap-threshold, popover-containment, stable-row
 *          (tabs moved between Board and About) or docked-select-width
 *          regression.
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
//
// Re-baselined when the board filter row was DOCKED INTO THE HEADER on
// desktop and the header was regrouped (brand + tabs + project picker | the
// filters | count + identity + theme). Against a board that has tasks (both
// CI servers are seeded alike, see ci.yml) the desktop header is:
//   - row 1 (brand, tabs, picker, identity) + a filter row below 1880px;
//   - ONE row from 1880px (`min-[117.5rem]`), where the filters sit inline.
// That switch is a breakpoint, not a content-driven wrap. The only wrap
// point left is the identity group dropping under the brand row below 993px
// (three rows: brand row, identity row, filter row). Phone widths are
// unchanged (the filters stay in the board pane).
const EXPECTATIONS = {
  320: 84, 360: 84, 390: 84,
  768: 115, 820: 115, 824: 115, 900: 115,
  1024: 83, 1100: 83,
  1280: 83, 1440: 83, 1728: 83,
  1920: 49, 2048: 49,
};
// The same header with NO filters docked (the About view; a loading or empty
// board looks the same): just row 1, which must not depend on the filters.
const UNDOCKED_EXPECTATIONS = {
  768: 82, 900: 82,
  1024: 49, 1280: 49, 1440: 49, 1728: 49, 1920: 49, 2048: 49,
};
// Widths at which the Board/About tabs, the project picker, the task count
// and the theme toggle must sit at the SAME x/y on Board (filters docked) as
// on About (no filters): a reviewer measured the tabs jumping from (729,45)
// to (572,12) under the pointer at 1440px when the filters used to push them
// onto a second row.
const STABLE_ROW_WIDTHS = [768, 1024, 1280, 1440, 1728, 1920, 2048];
// A docked <select> may not grow with its longest option: one task claimed
// by a 70-character agent id once made the assignee select 496px wide and
// added a header row at every desktop width. Docked selects are capped at
// 10rem/12rem; the fixture (ci.yml) seeds such an assignee on both servers.
const DOCKED_SELECT_MAX_PX = 200;
const LONG_ASSIGNEE_MIN_CHARS = 40;
// width -> expected header height (px), COARSE pointer (real touch phone/
// tablet — `pointer-coarse:min-h-11` 44px targets grow several header
// controls). Same real-Chromium measurement, `Emulation.setTouchEmulationEnabled`
// forcing `pointer: coarse` to match. Checked at a subset of widths — the
// same ones CONTAINMENT_WIDTHS below already covers.
// Re-baselined with the docked filter row (see EXPECTATIONS). A coarse
// pointer under 1024px does NOT dock (DESKTOP_HEADER_QUERY in
// client/src/lib/uiSettings.ts), so 768px keeps the undocked header.
// Measured, coarse: 155 (768-789) -> 101 -> 67 (1011-1023, undocked) ->
// 117 (docked, from 1024) -> 67 (one row, from 1880).
const COARSE_EXPECTATIONS = {
  320: 113, 768: 155, 1100: 117, 1280: 117, 1920: 67, 2048: 67,
};

// Optional second server (feature OFF) for a live ON-vs-OFF diff in the
// third pass — see the file header comment and ci.yml.
const OFF_BASE = process.argv[4] || null;

// Every stored theme mode (client/src/lib/theme.ts `ThemeMode`) — the
// round-3 defect was mode-dependent, so the third pass below forces each
// one in turn rather than trusting whatever mode the browser happens to
// boot into.
const THEME_MODES = ['auto', 'light', 'dark'];

const range = (from, to, step) => {
  const out = [];
  for (let x = from; x <= to; x += step) out.push(x);
  return out;
};
// 8px steps across the two wrap thresholds the first two passes already
// know about (1024<->1100 and 1100<->1280 — see EXPECTATIONS) plus a margin
// either side, non-coarse and coarse pointer respectively. This is exactly
// the grid fine enough to have caught the round-3 defect (an 8-40px band)
// in Chromium, not just the WebKit repro it was first found in.
//
// Since the filter row docks into the header the sweep runs from 768px (the
// whole docked range used to start at 1000px) and also covers the 1880px
// breakpoint where the filters move into row 1: the right-hand group must be
// exactly as wide with the bug icon ON as OFF everywhere, or ON wraps a row
// earlier.
const FINE_WIDTHS = [...range(768, 1264, 8), ...range(1840, 1920, 8)];
const FINE_COARSE_WIDTHS = [...range(768, 1272, 8), ...range(1840, 1920, 8)];
// Fallback tables, used only when OFF_BASE is not supplied. Captured with a
// live ON-vs-OFF diff (both empty, i.e. equal, at the time this pass was
// written) against the same real-Chromium ground truth as EXPECTATIONS/
// COARSE_EXPECTATIONS above.
const fineNonCoarseExpected = (w) => (w < 993 ? 115 : w < 1880 ? 83 : 49);
const fineCoarseExpected = (w) => (w < 790 ? 155 : w < 1011 ? 101 : w < 1024 ? 67 : w < 1880 ? 117 : 67);
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
      logs.push({ file: f, path: full + '/' + f, mtime: statMtime(full + '/' + f) });
    }
  }
  logs.sort((a, b) => b.mtime - a.mtime);
  for (const log of logs.slice(0, 6)) {
    const txt = readSafe(log.path);
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
  return {
    innerWidth: window.innerWidth,
    box: { x: r.x, y: r.y, width: r.width, height: r.height },
  };
})()`;
// v2.17.0: the Report-a-bug entry point lives directly in the header now (an
// icon button beside the theme toggle), not inside this popover. Checked
// separately — it must stay fully on-screen AND immediately adjacent to the
// theme toggle (no gap wide enough to look like a different control) at
// every containment width.
const READ_BUG_ICON = `(() => {
  const icon = [...document.querySelectorAll('button')]
    .find((b) => b.getAttribute('aria-label') === 'Report a bug');
  const theme = [...document.querySelectorAll('button')]
    .find((b) => b.getAttribute('aria-label') === 'Toggle theme');
  if (!icon) return { present: false };
  if (!theme) return { present: true, error: 'theme toggle not found' };
  const i = icon.getBoundingClientRect();
  const t = theme.getBoundingClientRect();
  return {
    present: true,
    innerWidth: window.innerWidth,
    iconBox: { x: i.x, width: i.width, height: i.height },
    themeBox: { x: t.x, width: t.width },
    gapPx: Math.round(t.x - (i.x + i.width)),
  };
})()`;

// Row-1 geometry + the docked selects, read in one go. Rects are rounded so
// a sub-pixel difference is not reported as movement.
const ROW_PROBE = `(() => {
  const rect = (el) => {
    if (!el || !el.getClientRects().length) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width) };
  };
  const header = document.querySelector('header');
  if (!header) return null;
  const slot = header.querySelector('[data-testid="header-filter-slot"]');
  const selects = slot ? [...slot.querySelectorAll('select')].map((sel) => ({
    label: sel.getAttribute('aria-label'),
    width: Math.round(sel.getBoundingClientRect().width),
    longestOption: Math.max(0, ...[...sel.options].map((o) => o.textContent.length)),
  })) : [];
  return {
    height: Math.round(header.getBoundingClientRect().height),
    docked: !!slot && slot.childElementCount > 0,
    tabs: rect(header.querySelector('[role="group"][aria-label^="Switch between"]')),
    picker: rect(header.querySelector('[aria-haspopup="listbox"]')),
    count: rect([...header.querySelectorAll('span')].find((sp) => /tasks$/.test(sp.textContent.trim()))),
    theme: rect(header.querySelector('[aria-label="Toggle theme"]')),
    selects,
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
  };
})()`;
const clickTab = (name) => `(() => {
  const tab = [...document.querySelectorAll('header [role="group"][aria-label^="Switch between"] button')]
    .find((b) => b.textContent.trim().toLowerCase() === ${JSON.stringify(name)});
  if (!tab) return false;
  tab.click();
  return true;
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

      // Step 1b: if the bug icon is rendered (feature ON — see ci.yml), it
      // must stay fully on-screen and sit immediately beside the theme
      // toggle (v2.17.0). Skipped entirely when the feature is off (the icon
      // simply does not render) rather than treated as a failure.
      const iconStep = await send('Runtime.evaluate', { expression: READ_BUG_ICON, returnByValue: true });
      const iconInfo = iconStep.result && iconStep.result.value;
      if (iconInfo && iconInfo.present) {
        if (iconInfo.error) {
          containmentOffenders.push({ width, reason: `bug icon: ${iconInfo.error}` });
        } else {
          const { iconBox, innerWidth: iw, gapPx } = iconInfo;
          if (iconBox.x < 0 || iconBox.x + iconBox.width > iw) {
            containmentOffenders.push({ width, reason: `bug icon clipped (x=${Math.round(iconBox.x)}, width=${Math.round(iconBox.width)}, viewport=${iw})` });
          }
          // A handful of px covers the shared-border/no-gap construction
          // (App.tsx) — anything wider suggests another control slipped
          // between the two, or the group broke apart onto separate rows.
          if (gapPx < -1 || gapPx > 2) {
            containmentOffenders.push({ width, reason: `bug icon is not immediately beside the theme toggle (gap ${gapPx}px)` });
          }
        }
      }

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
        const { box, innerWidth } = v;
        const leftEdge = box.x;
        const rightEdge = box.x + box.width;
        if (leftEdge < POPOVER_MARGIN_PX) {
          containmentOffenders.push({ width, reason: `left edge at ${Math.round(leftEdge)}px, clipped off-screen (margin ${POPOVER_MARGIN_PX}px)` });
        }
        if (rightEdge > innerWidth - POPOVER_MARGIN_PX) {
          containmentOffenders.push({ width, reason: `right edge at ${Math.round(rightEdge)}px exceeds viewport ${innerWidth}px (margin ${POPOVER_MARGIN_PX}px)` });
        }
      }
    }
  }

  // Stable-row pass (docked filter row). At each width: measure row 1 on the
  // Board (filters docked), switch to About (no filters), measure again. The
  // tabs, the picker, the count and the theme toggle must not have moved, the
  // undocked header must match its own baseline, and no docked select may be
  // wider than its cap even though the fixture holds a very long assignee.
  const rowOffenders = [];
  const measuredUndocked = {};
  let sawLongAssignee = false;
  let sawDocked = false;
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const evalValue = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    return r.result && r.result.value;
  };
  const rowWidths = [...new Set([...STABLE_ROW_WIDTHS, ...Object.keys(UNDOCKED_EXPECTATIONS).map(Number)])].sort((a, b) => a - b);
  for (const width of rowWidths) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evalValue(clickTab('board'));
    await settle(250);
    const board = await evalValue(ROW_PROBE);
    const wentToAbout = await evalValue(clickTab('about'));
    await settle(250);
    const about = await evalValue(ROW_PROBE);
    await evalValue(clickTab('board'));
    await settle(200);
    if (!board || !about || !wentToAbout) {
      rowOffenders.push({ width, reason: 'could not switch between the Board and About views' });
      continue;
    }
    measuredUndocked[width] = about.height;
    if (board.docked) sawDocked = true;
    if (about.docked) rowOffenders.push({ width, reason: 'the filters are still docked on the About view' });
    if (board.pageOverflow > 0) rowOffenders.push({ width, reason: `the page overflows horizontally by ${board.pageOverflow}px with the filters docked` });
    if (STABLE_ROW_WIDTHS.includes(width)) {
      if (!board.docked) rowOffenders.push({ width, reason: 'the filters are not docked into the header on the Board view (is the board seeded?)' });
      for (const key of ['tabs', 'picker', 'count', 'theme']) {
        const b = board[key];
        const a = about[key];
        if (!b || !a) { rowOffenders.push({ width, reason: `${key} not found in the header` }); continue; }
        // The count's own width may differ by a digit; its left edge and row may not.
        const moved = Math.abs(b.x - a.x) > 1 || Math.abs(b.y - a.y) > 1 || (key !== 'count' && Math.abs(b.w - a.w) > 1);
        if (moved) rowOffenders.push({ width, reason: `${key} moved between Board (${b.x},${b.y} w${b.w}) and About (${a.x},${a.y} w${a.w})` });
      }
    }
    for (const sel of board.selects) {
      if (sel.label === 'Filter tasks by assignee' && sel.longestOption >= LONG_ASSIGNEE_MIN_CHARS) sawLongAssignee = true;
      if (sel.width > DOCKED_SELECT_MAX_PX) rowOffenders.push({ width, reason: `docked select "${sel.label}" is ${sel.width}px wide (cap ${DOCKED_SELECT_MAX_PX}px; longest option ${sel.longestOption} chars)` });
    }
    if (Object.prototype.hasOwnProperty.call(UNDOCKED_EXPECTATIONS, width)) {
      const expected = UNDOCKED_EXPECTATIONS[width];
      if (Math.abs(about.height - expected) > TOLERANCE_PX) {
        rowOffenders.push({ width, reason: `undocked (About) header is ${about.height}px, expected ${expected}±${TOLERANCE_PX}` });
      }
    }
  }
  if (!sawDocked) rowOffenders.push({ width: '-', reason: 'the filters never docked: the board has no tasks, so every docked check passed vacuously' });
  if (!sawLongAssignee) rowOffenders.push({ width: '-', reason: `no assignee of ${LONG_ASSIGNEE_MIN_CHARS}+ characters in the fixture: the select-width cap was not exercised (see the claim step in ci.yml)` });

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

  // Third pass (v2.17.0 round 3) — see the file header comment. Forces each
  // theme mode and sweeps 8px-step width grids across the known wrap
  // thresholds, non-coarse and coarse, diffing ON against OFF live when
  // OFF_BASE is given, else against the fallback tables above.
  async function navigateAndWaitForHeader(url) {
    await send('Page.navigate', { url });
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 300));
      const r = await send('Runtime.evaluate', { expression: HEADER_HEIGHT_PROBE, returnByValue: true });
      if (r.result && typeof r.result.value === 'number') return true;
    }
    return false;
  }
  async function setThemeModeAndReload(url, mode) {
    // Navigate first so localStorage is set on the RIGHT origin (ON and OFF
    // are different ports/origins with independent storage), then reload so
    // the pre-paint inline script (client/index.html) picks the mode up the
    // same way a real visitor's stored choice would be.
    const loaded = await navigateAndWaitForHeader(url);
    if (!loaded) return false;
    await send('Runtime.evaluate', { expression: `localStorage.setItem('theme', ${JSON.stringify(mode)})` });
    return navigateAndWaitForHeader(url);
  }
  async function measureHeightsAcrossWidths(widths) {
    const out = {};
    for (const width of widths) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await new Promise((r) => setTimeout(r, 150));
      const r = await send('Runtime.evaluate', { expression: HEADER_HEIGHT_PROBE, returnByValue: true });
      out[width] = r.result && typeof r.result.value === 'number' ? r.result.value : null;
    }
    return out;
  }

  const fineOffenders = [];
  const fineMode = OFF_BASE ? 'live ON-vs-OFF diff' : 'fallback table';
  for (const mode of THEME_MODES) {
    const onReady = await setThemeModeAndReload(BASE, mode);
    if (!onReady) { fineOffenders.push({ mode, reason: 'ON header never rendered after forcing theme + reload' }); continue; }
    const onNonCoarse = await measureHeightsAcrossWidths(FINE_WIDTHS);
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: true });
    const onCoarse = await measureHeightsAcrossWidths(FINE_COARSE_WIDTHS);
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });

    let offNonCoarse = null;
    let offCoarse = null;
    if (OFF_BASE) {
      const offReady = await setThemeModeAndReload(OFF_BASE, mode);
      if (!offReady) {
        fineOffenders.push({ mode, reason: 'OFF header never rendered after forcing theme + reload' });
      } else {
        offNonCoarse = await measureHeightsAcrossWidths(FINE_WIDTHS);
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
        await send('Emulation.setEmitTouchEventsForMouse', { enabled: true });
        offCoarse = await measureHeightsAcrossWidths(FINE_COARSE_WIDTHS);
        await send('Emulation.setTouchEmulationEnabled', { enabled: false });
      }
    }

    for (const width of FINE_WIDTHS) {
      const expected = offNonCoarse ? offNonCoarse[width] : fineNonCoarseExpected(width);
      const actual = onNonCoarse[width];
      if (typeof actual !== 'number' || typeof expected !== 'number' || Math.abs(actual - expected) > TOLERANCE_PX) {
        fineOffenders.push({ mode, coarse: false, width, expected, actual });
      }
    }
    for (const width of FINE_COARSE_WIDTHS) {
      const expected = offCoarse ? offCoarse[width] : fineCoarseExpected(width);
      const actual = onCoarse[width];
      if (typeof actual !== 'number' || typeof expected !== 'number' || Math.abs(actual - expected) > TOLERANCE_PX) {
        fineOffenders.push({ mode, coarse: true, width, expected, actual });
      }
    }
  }
  // Leave the session pointed back at BASE in its default mode so a reused
  // CDP target (unlikely, but cheap to guard) is not left mid-experiment.
  await setThemeModeAndReload(BASE, 'auto');

  ws.close();

  console.log(`header layout guard (CDP :${usedPort})`);
  console.log(`  heights (non-coarse): ${JSON.stringify(measuredHeights)}`);
  console.log(`  heights (coarse):     ${JSON.stringify(measuredCoarseHeights)}`);
  console.log(`  heights (undocked, About view): ${JSON.stringify(measuredUndocked)}`);
  console.log(`  stable row 1 + capped docked selects (Board vs About): ${rowOffenders.length === 0 ? 'OK' : `${rowOffenders.length} offender(s)`}`);
  console.log(`  popover boxes: ${JSON.stringify(measuredBoxes)}`);
  console.log(`  fine wrap-threshold sweep (${fineMode}, ${THEME_MODES.join('/')}): ${fineOffenders.length === 0 ? 'OK' : `${fineOffenders.length} offender(s)`}`);

  if (heightOffenders.length === 0 && containmentOffenders.length === 0 && coarseOffenders.length === 0 && fineOffenders.length === 0 && rowOffenders.length === 0) {
    console.log(`  OK — header height within ${TOLERANCE_PX}px of baseline (both pointer types, every theme mode, fine and coarse width grids), popover fully contained (>=${POPOVER_MARGIN_PX}px margin) at every tested width`);
    process.exit(0);
  }
  if (rowOffenders.length) {
    console.error(`  FAIL — ${rowOffenders.length} stable-row / docked-select violation(s):`);
    for (const o of rowOffenders) console.error(`    ${o.width}px: ${o.reason}`);
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
  if (fineOffenders.length) {
    console.error(`  FAIL — ${fineOffenders.length} fine wrap-threshold offender(s) (${fineMode}):`);
    for (const o of fineOffenders) {
      if (o.width === undefined) {
        console.error(`    mode=${o.mode}: ${o.reason}`);
      } else {
        console.error(`    mode=${o.mode} coarse=${o.coarse} ${o.width}px: expected ${o.expected}±${TOLERANCE_PX}, got ${o.actual}`);
      }
    }
  }
  process.exit(1);
}

main().catch((e) => { console.error('header layout guard error:', e.message); process.exit(2); });
