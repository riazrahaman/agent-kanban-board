import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "/Users/riazrahaman/.claude/skills/anatomy/kit/iso-kit.mjs";
import { frameAlong, lathe, sphereOf } from "/Users/riazrahaman/.claude/skills/anatomy/kit/lathe.mjs";
import { kitScript } from "/Users/riazrahaman/.claude/skills/anatomy/scripts/inline-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const theme = process.argv.includes("--light") ? "light" : "dark";
const AZ = 38;

const FILLS = {
  mid: "var(--anatomy-mid)",
  text: "var(--anatomy-text)",
  red: "var(--anatomy-red)",
  green: "var(--anatomy-green)",
  orange: "#f6821c",
};
const faintWrap = (faint) => (faint ? ' style="opacity:.5"' : "");

// A per-plate bag of projection-aware helpers.
function mk(P) {
  const at = (p) => k.iso(p, P);
  const S = (paths, style) => k.solidSvg(paths, style);
  const L = (d, style) => k.lineSvg(d, style);
  const D = (pts, style) => k.dotsSvg(pts, style);
  const SEG = (worldPts) => k.pathOf(worldPts.map(at));
  const bev = (x, y, z) => [L([k.ring(x, y, 0.9, z, P, 12)], { tone: "lo" }), D([at([x, y, z])], { size: 0.42 })];
  const byDepth = (planPoints) =>
    [...planPoints].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));

  // Dotted-leader callout. lines = string or array; anchor "end" extends text left of the tip.
  const label = (target, lines, [ox, oy], anchor = "start", color = "text") => {
    const arr = Array.isArray(lines) ? lines : [lines];
    const [tx, ty] = at(target);
    const elbow = [tx + ox, ty + oy];
    const tip = [elbow[0] + (anchor === "end" ? -20 : 20), elbow[1]];
    const xText = tip[0] + (anchor === "end" ? -3.5 : 3.5);
    const fill = FILLS[color];
    const texts = arr
      .map(
        (lineText, i) =>
          `<text x="${xText.toFixed(1)}" y="${(tip[1] + 4 + i * 16.5).toFixed(1)}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="15.5" letter-spacing="0.3" fill="${fill}" text-anchor="${anchor}">${lineText}</text>`,
      )
      .join("");
    return (
      `<g class="iso-label">` +
      L(k.pathOf([[tx, ty], elbow, tip]), { tone: "lo", dotted: true }) +
      `<circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="1.6" fill="${fill}"/>` +
      `<circle cx="${tip[0].toFixed(1)}" cy="${tip[1].toFixed(1)}" r="1" fill="var(--anatomy-lo)"/>` +
      texts +
      `</g>`
    );
  };
  return { P, at, S, L, D, SEG, bev, byDepth, label };
}

// Colored end-dotted line helper; colored dots need a scoped --anatomy-dot override.
function colorLine(g, worldPts, color, opts = {}) {
  const css = color === "orange" ? "#f6821c" : `var(--anatomy-${color})`;
  return (
    `<g class="tf-strip" style="--anatomy-dot:${css}">` +
    g.L(g.SEG(worldPts), { tone: color === "orange" ? "hi" : color, ...opts }) +
    g.D(worldPts.filter((_, i) => i === 0 || i === worldPts.length - 1).map(g.at), { size: 0.55, tone: "hi" }) +
    `</g>`
  );
}

// ── shared parts ────────────────────────────────────────────────
function bench(g, BENCH, PLATE_H, FOOT_H) {
  const out = [`<path class="iso-halo" d="${k.haloOf(BENCH, -PLATE_H - FOOT_H, PLATE_H, g.P)}"/>`];
  for (const [x, y] of g.byDepth(k.corners(BENCH, 20))) {
    out.push(g.S(k.cylinder(x, y, 7, -PLATE_H - FOOT_H, 1.6, g.P, 28), { tone: "lo" }));
    out.push(g.S(k.cylinder(x, y, 5.4, -PLATE_H - FOOT_H + 1.6, FOOT_H - 1.6, g.P, 28), { tone: "mid" }));
  }
  out.push(g.S(k.slabOf(BENCH, -PLATE_H, PLATE_H, g.P, 8, 1.6), { tone: "mid" }));
  out.push(g.L(k.planOutline(k.insetPlan(BENCH, 5), 0, g.P), { tone: "lo" }));
  return out.join("");
}

// capsule glyph; rides with data-part for the live script, colored halo ties it to its lane
function capsuleSvg(g, x, y, z, accent = "green") {
  const out = [];
  const css = accent === "red" ? "var(--anatomy-red)" : accent === "orange" ? "#f6821c" : "var(--anatomy-green)";
  out.push(`<g style="--anatomy-dot:${css}">`);
  out.push(g.L([k.ring(x, y, 3.7, z + 0.05, g.P, 20)], { tone: accent === "red" ? "red" : accent === "green" ? "green" : "hi" }));
  out.push(`</g>`);
  out.push(g.S(k.cylinder(x, y, 2.9, z, 6, g.P, 28), { tone: "hi", lit: true }));
  out.push(g.L([k.ring(x, y, 1.2, z + 6, g.P, 14)], { tone: "mid" }));
  out.push(g.D([g.at([x, y, z + 6.3])], { size: 0.5, tone: "hi" }));
  return out.join("");
}

// faded dead capsule husk lying on its side
function ghostCapsule(g, origin, dir, len = 5, r = 2.4) {
  const F = frameAlong(origin, dir);
  const meridian = [[0, 0], [0.3, r], [len - 0.4, r], [len, 0]];
  return `<g style="opacity:.5">${g.S(lathe(meridian, F, g.P), { tone: "lo" })}</g>`;
}

// the Ollama engine bell (lathe) with cap + lamp dot
function bellSvg(g, cx, cy, z, { lamp = false, scale = 1 } = {}) {
  const out = [];
  const F = frameAlong([cx, cy, z], [0, 0, 1]);
  const meridian = [
    [0, 0], [0.6, 14.5], [1.2, 16.6], [2, 17.2],
    [4, 16.6], [8, 15.4], [12, 14.0], [16, 12.6], [19.4, 11.4],
  ].map(([a, b]) => [a * scale, b * scale]);
  out.push(g.S(lathe(meridian, F, g.P), { tone: "hi" }));
  for (const [s, r] of [[4.5, 16.85], [9, 15.15], [13.5, 12.85]]) {
    out.push(g.L([k.ring(cx, cy, r * scale, z + s * scale, g.P, 48)], { tone: "lo" }));
  }
  out.push(g.S(k.cylinder(cx, cy, 11.6 * scale, z + 19.4 * scale, 2 * scale, g.P, 40), { tone: "mid" }));
  out.push(g.L([k.ring(cx, cy, 10.4 * scale, z + 21.4 * scale, g.P, 40)], { tone: "faint" }));
  const lampDot = g.D([g.at([cx, cy, z + 21.8 * scale])], { size: 0.9, tone: "lit" });
  out.push(lamp ? `<g data-part="${lamp}">${lampDot}</g>` : lampDot);
  return out.join("");
}

// load gauge: pillar (rooted at zBase) + dial + ticks + live needle (frames injected by caller)
function gaugeSvg(g, gx, gy, zBase, { part = "needle", dialH = 10 } = {}) {
  const out = [];
  const z = zBase + dialH; // dial plane height
  out.push(g.S(k.cylinder(gx, gy, 0.2 * dialH, zBase, dialH, g.P, 20), { tone: "mid", crease: "none" }));
  out.push(g.S(k.cylinder(gx, gy, 0.65 * dialH, z - 0.18 * dialH, 0.18 * dialH, g.P, 40), { tone: "hi", crease: "lo" }));
  const ticks = k.radialTicks(gx, gy, 4.7 * (dialH / 10), 24, 5, z, [1.1 * (dialH / 10), 2.3 * (dialH / 10)], g.P);
  out.push(g.L(ticks.minor, { tone: "lo" }), g.L(ticks.major, { tone: "mid" }));
  out.push(g.L([k.ring(gx, gy, 5.6 * (dialH / 10), z, g.P, 40)], { tone: "mid" }));
  const needleAt = (load) => {
    const a = -Math.PI * 0.78 + load * Math.PI * 1.42;
    return k.pathOf([
      g.at([gx + Math.sin(a) * 1.3 * (dialH / 10), gy - Math.cos(a) * 1.3 * (dialH / 10), z + 0.1]),
      g.at([gx - Math.sin(a) * 4.3 * (dialH / 10), gy + Math.cos(a) * 4.3 * (dialH / 10), z + 0.1]),
    ]);
  };
  out.push(`<path data-part="${part}" class="iso-line" data-tone="mid" data-free="gauge" d="${needleAt(0.28)}" style="stroke-width:1"/>`);
  out.push(g.D([g.at([gx, gy, z + 0.1])], { size: 0.55 }));
  return { svg: out.join(""), frames: Array.from({ length: 41 }, (_, i) => needleAt(i / 40)) };
}

// ═══════════════════════════════════════════════════════════════
// FIG 1 — “Two routes, one request”: the desk at the fork's apex; the
// tunnel lane runs away-up-right (green, unbroken) under the edge arch,
// through the token gate, docking at the machine room's lit socket; the
// funnel lane runs down-right (red, dying) past the DERP relay's mast,
// cracked and sagging into a dead end beside the dead tray.
// ═══════════════════════════════════════════════════════════════
const W1 = 1024, H1 = 600;
const B1A = { x: -202, y: -214, w: 166, d: 240, r: 10 }; // tunnel arm + desk + machine room (x -202..-36, y -214..26)
const B1B = { x: -202, y: 20, w: 324, d: 84, r: 10 };    // funnel arm + tray (x -202..122, y 20..104)
const PLATE_H = 12, FOOT_H = 5;
const LTX = -92;          // tunnel lane: constant x, runs -y (screen right-up)
const LFY = 64;           // funnel lane: constant y, runs +x (screen right-down)
const RAIL_TOP = 31;      // rail slab z 26..31
const DK1 = { x: -178, y: -4, w: 64, d: 56, r: 3 };
const PIVOT1 = [-104, 44, 34.5];
const MOUTH_T = [-98, 16, 31.7];   // where the tunnel mouth feeds the lane
const MOUTH_F = [-132, 58, 31.7];  // same for the funnel mouth
const CAB1 = { x: -132, y: -206, w: 76, d: 56, r: 3 };
const ENG1 = [-92, -180], ENG_Z1 = 41;
const DOME1 = [-92, -147, 30.6], DOME_R1 = 6.2;
const DOCK_Y = -137.3;    // capsule center when docked
const MAST1 = { base: { x: 22, y: 78, w: 8, d: 8, r: 2 }, post: { x: 23, y: 79, w: 6, d: 6, r: 1.5 }, arm: { x: 23, y: 56, w: 5.5, d: 26, r: 1 } };
const PULLEY1 = [26, 64, 47];
const TRAY1 = { x: 44, y: 70, w: 32, d: 26, r: 1 };
const REBIN1 = { x: -66, y: -102, w: 14, d: 12, r: 1.5 };

const fit1 = [
  ...k.boxCorners(B1A, -PLATE_H - FOOT_H, 0),
  ...k.boxCorners(B1B, -PLATE_H - FOOT_H, 0),
  [-92, -44, 70.6],                        // arch ribbon top
  [28.4, 85, 66.4],                        // red flag tip
  [-93, -96, 51.7],                        // beacon
  [-92, -180, 78],                         // bell cap + label room
  [-178, -4, 48],                          // desk top tier + label room
  [-178, 52, 41.5],
  [112, 64, 30],                           // broken stub end
];
const P1 = k.fitProjection(fit1, W1, H1, { pad: 26, azimuth: AZ });
const g1 = mk(P1);

// ── fig 1 pieces ────────────────────────────────────────────────
function f1Desk() {
  const { S, L, D, SEG, at } = g1;
  const out = [];
  const faceX = DK1.x + DK1.w; // east face x=-114 (visible)
  out.push(S(k.slabOf(DK1, 0, 36, P1, 6, 1), { tone: "mid" }));
  out.push(S(k.slabOf(k.insetPlan(DK1, 1), 36, 5, P1, 5, 0.8), { tone: "mid", lit: true }));
  out.push(L(k.planOutline(k.insetPlan(DK1, 1.6), 41, P1), { tone: "lo" }));
  for (const [x, y] of k.corners(DK1, 5)) out.push(...g1.bev(x, y, 41));
  for (const z of [8, 18, 28]) {
    out.push(L(SEG([[faceX + 0.1, 0, z], [faceX + 0.1, 48, z]]), { tone: "lo" }));
    out.push(D([at([faceX + 0.1, 0, z]), at([faceX + 0.1, 48, z])], { size: 0.55 }));
  }
  // dispatch knob
  out.push(S(k.cylinder(-146, 22, 4.8, 41, 4.6, P1, 28), { tone: "mid" }));
  out.push(L([k.ring(-146, 22, 4.8, 41.6, P1, 28), k.ring(-146, 22, 4.8, 45.3, P1, 28)], { tone: "lo" }));
  out.push(L(SEG([[-150.8, 22, 45.8], [-141.2, 22, 45.8]]), { tone: "hi" }));
  // hopper plate + two spare capsules
  out.push(S(k.slabOf({ x: -174, y: 34, w: 24, d: 15, r: 2 }, 41, 2.6, P1, 5, 0.5), { tone: "mid" }));
  for (const [cx, cy] of [[-168, 38.5], [-160.5, 42.5]]) {
    out.push(S(k.cylinder(cx, cy, 2.4, 43.6, 4.6, P1, 18), { tone: "hi" }));
    out.push(D([at([cx, cy, 48.5])], { size: 0.45 }));
  }
  // bridge mouths from the desk to each lane
  out.push(S(k.slabOf({ x: -116, y: 12, w: 24, d: 10, r: 1 }, 26, 5, P1, 3, 0.4), { tone: "mid", lit: true }));
  out.push(L(k.planOutline(k.insetPlan({ x: -116, y: 12, w: 24, d: 10, r: 1 }, 1.2), RAIL_TOP, P1), { tone: "faint" }));
  out.push(S(k.slabOf({ x: -140, y: 50, w: 16, d: 14, r: 1 }, 26, 5, P1, 3, 0.4), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan({ x: -140, y: 50, w: 16, d: 14, r: 1 }, 1.2), RAIL_TOP, P1), { tone: "faint" }));
  return out.join("");
}

function f1Semaphore() {
  const { S, L, D, at } = g1;
  const out = [];
  out.push(S(k.slabOf({ x: -107, y: 41, w: 6, d: 6, r: 2 }, 0, 3, P1, 4, 0.6), { tone: "mid" }));
  out.push(S(k.cylinder(-104, 44, 1.8, 3, 27, P1, 16), { tone: "mid" }));
  out.push(L([k.ring(-104, 44, 2.2, 30, P1, 14)], { tone: "lo" }));
  const [px, py] = at(PIVOT1);
  const armD = k.pathOf([[px, py], [px + 17, py]]);
  out.push(
    `<g data-part="switch-arm" transform="rotate(${SWITCH_ANGLES.tunnel.toFixed(1)} ${px.toFixed(1)} ${py.toFixed(1)})">` +
    `<path class="iso-line" data-tone="hi" data-free="switch" d="${armD}" style="stroke-width:1.2"/>` +
    `<circle cx="${(px + 17).toFixed(1)}" cy="${py.toFixed(1)}" r="1.7" fill="var(--anatomy-hi)"/>` +
    `</g>`,
  );
  out.push(D([at(PIVOT1)], { size: 0.7, tone: "hi" }));
  // lenses stacked on the post: green = tunnel, red = funnel
  out.push(`<g data-part="lens-tunnel" style="--anatomy-dot:var(--anatomy-green)">${D([at([-106.2, 41.8, 35.8])], { size: 0.85, tone: "hi" })}</g>`);
  out.push(`<g data-part="lens-funnel" style="--anatomy-dot:var(--anatomy-red)">${D([at([-101.8, 46.2, 35.8])], { size: 0.85, tone: "hi" })}</g>`);
  return out.join("");
}

function railPosts(g, pts, height) {
  const out = [];
  for (const [x, y] of pts) {
    out.push(g.S(k.slabOf({ x: x - 3.5, y: y - 3.5, w: 7, d: 7, r: 1 }, 0, height, g.P, 4, 0.5), { tone: "mid", crease: "none" }));
    out.push(g.S(k.cylinder(x, y, 2.4, height, 1.6, g.P, 20), { tone: "mid" }));
    out.push(...g.bev(x, y, height + 1.6));
    out.push(...g.bev(x + 2.6, y + 1.8, 0));
  }
  return out.join("");
}

function f1TunnelLane() {
  const { S, L } = g1;
  const out = [];
  out.push(railPosts(g1, [[-92, -2], [-92, -36], [-92, -72], [-92, -124]], 26));
  const rail = { x: LTX - 3, y: -148, w: 6, d: 168, r: 1 }; // y -148..20
  out.push(S(k.slabOf(rail, 26, 5, P1, 3, 0.4), { tone: "mid", lit: true }));
  out.push(L(k.planOutline(k.insetPlan(rail, 1.4), RAIL_TOP, P1), { tone: "faint" }));
  // green flow strip — the healthy route, flowing toward the machine room
  out.push(colorLine(g1, [[LTX, 14, RAIL_TOP + 0.15], [LTX, -140, RAIL_TOP + 0.15]], "green", { flow: true }));
  return out.join("");
}

function f1FunnelLane() {
  const { S, L } = g1;
  const out = [];
  out.push(railPosts(g1, [[-120, 64], [-80, 64], [-40, 64], [16, 64]], 26));
  const rail = { x: -152, y: LFY - 3, w: 192, d: 6, r: 1 }; // x -152..40
  out.push(`<g style="opacity:.72">`);
  out.push(S(k.slabOf(rail, 26, 5, P1, 3, 0.4), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(rail, 1.4), RAIL_TOP, P1), { tone: "lo" }));
  out.push(`</g>`);
  // red dashes die before the grab — the road gives up
  out.push(colorLine(g1, [[-144, LFY, RAIL_TOP + 0.15], [14, LFY, RAIL_TOP + 0.15]], "red", { dashed: true }));
  // jagged break across the rail top, past the mast
  out.push(colorLine(g1, [[40, LFY - 2.8, RAIL_TOP + 0.2], [44, LFY + 2.8, RAIL_TOP + 0.28], [48, LFY - 2.4, RAIL_TOP + 0.2]], "red"));
  // sagged stub beyond the break
  const stub = { x: 52, y: LFY - 3, w: 58, d: 6, r: 1 };
  out.push(`<g style="opacity:.65">`);
  out.push(S(k.slabOf(stub, 21.6, 5, P1, 3, 0.4), { tone: "mid" }));
  out.push(`</g>`);
  out.push(L(k.planOutline(k.insetPlan(stub, 1), 26.75, P1), { tone: "red" }));
  out.push(railPosts(g1, [[80, 64]], 21.6));
  // X painted on the broken end face (+x face is visible): road closed
  out.push(colorLine(g1, [[110.2, LFY - 2.2, 26.2], [110.2, LFY + 2.2, 22]], "red"));
  out.push(colorLine(g1, [[110.2, LFY + 2.2, 26.2], [110.2, LFY - 2.2, 22]], "red"));
  return out.join("");
}

function f1ArchFar() {
  const { S } = g1;
  const out = [];
  // west leg (far side from the viewer)
  out.push(S(k.slabOf({ x: -115, y: -57, w: 11, d: 11, r: 2 }, 0, 3, P1, 4, 0.6), { tone: "mid" }));
  out.push(S(k.slabOf({ x: -114, y: -56, w: 9, d: 9, r: 1.6 }, 3, 47, P1, 4, 0.5), { tone: "mid" }));
  out.push(...g1.bev(-109.5, -51.5, 50));
  return out.join("");
}
function f1ArchHeader() {
  const { S, L } = g1;
  const out = [];
  const h = { x: -118, y: -56, w: 52, d: 11, r: 2.6 };
  out.push(S(k.slabOf(h, 50, 12, P1, 6, 1), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(h, 1.4), 62, P1), { tone: "lo" }));
  // hostname ribbon — wide along x so the hostname reads as an engraving
  const ribbon = { x: -112, y: -47, w: 44, d: 3, r: 1 };
  out.push(S(k.slabOf(ribbon, 62, 8, P1, 3, 0.4), { tone: "hi", lit: true }));
  out.push(k.faceTextSvg(
    k.sideMatrix([-111, -43.95], 66.7, P1, "left"),
    "ollama.riazrahaman.com",
    { size: 2.2, tone: "mid", anchor: "start" },
  ));
  // record ports on the header's south face: two grey-clouded, one proxied (orange)
  for (const [x, proxied] of [[-106, false], [-96, false], [-86, true]]) {
    out.push(proxied ? `<g>` : `<g style="opacity:.5">`);
    out.push(S(k.cylinder(x, -44.4, 2, 54.6, 1.5, P1, 20), { tone: proxied ? "hi" : "lo" }));
    out.push(L([k.ring(x, -44.4, 1.15, 56.2, P1, 16)], { tone: proxied ? "hi" : "lo" }));
    out.push(
      proxied
        ? `<g style="--anatomy-dot:#f6821c">${g1.D([g1.at([x, -44.4, 56.5])], { size: 0.75, tone: "hi" })}</g>`
        : g1.D([g1.at([x, -44.4, 56.5])], { size: 0.55 }),
    );
    out.push(`</g>`);
  }
  return out.join("");
}
function f1ArchNear() {
  const { S } = g1;
  const out = [];
  // east leg (near the viewer)
  out.push(S(k.slabOf({ x: -80, y: -57, w: 11, d: 11, r: 2 }, 0, 3, P1, 4, 0.6), { tone: "mid" }));
  out.push(S(k.slabOf({ x: -79, y: -56, w: 9, d: 9, r: 1.6 }, 3, 47, P1, 4, 0.5), { tone: "mid" }));
  out.push(...g1.bev(-74.5, -51.5, 50));
  return out.join("");
}

function f1Gate() {
  const { S, L, D, at } = g1;
  const out = [];
  for (const x of [-114, -80]) {
    out.push(S(k.slabOf({ x, y: -99, w: 8, d: 7, r: 1.5 }, 0, 44, P1, 4, 0.6), { tone: "mid" }));
    out.push(...g1.bev(x + 4, -95.5, 44));
  }
  out.push(S(k.slabOf({ x: -114, y: -99.4, w: 42, d: 7, r: 1 }, 44, 3.5, P1, 3, 0.4), { tone: "mid", lit: true }));
  // scanner strip on the bar's south face (faces the incoming capsule)
  out.push(colorLine(g1, [[-110, -92.35, 45.8], [-76, -92.35, 45.8]], "green"));
  // beacon on the bar top
  out.push(S(k.cylinder(-93, -96, 1.8, 47.5, 3.4, P1, 16), { tone: "mid" }));
  out.push(`<g style="--anatomy-dot:var(--anatomy-green)">${L([k.ring(-93, -96, 2, 50.9, P1, 16)], { tone: "green" })}</g>`);
  out.push(`<g data-part="beacon1">${D([at([-93, -96, 51.4])], { size: 1.05, tone: "lit" })}</g>`);
  // "401" engraved on the west post's south face — faced by the incoming capsule
  out.push(k.faceTextSvg(k.sideMatrix([-112.6, -91.95], 26, P1, "left"), "401", { size: 2.6, tone: "lo" }));
  return out.join("");
}

function f1RejectBin() {
  const { S, L, D, at } = g1;
  const out = [];
  out.push(S(k.slabOf(REBIN1, 0, 4, P1, 4, 0.6), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(REBIN1, 1.4), 4, P1), { tone: "faint" }));
  out.push(D([at([-62, -98, 4.7]), at([-56, -94, 4.7])], { size: 0.5 }));
  out.push(ghostCapsule(g1, [-63, -97.5, 6.6], [1, 0.2, 0], 4.8, 2.2));
  return out.join("");
}

function f1MachineRoom() {
  const { S, L, D, SEG, at } = g1;
  const out = [];
  out.push(S(k.slabOf(CAB1, 0, 36, P1, 6, 1), { tone: "mid" }));
  out.push(S(k.slabOf(k.insetPlan(CAB1, 1), 36, 5, P1, 6, 0.8), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(CAB1, 1.6), 41, P1), { tone: "lo" }));
  for (const [x, y] of k.corners(CAB1, 5)) out.push(...g1.bev(x, y, 41));
  // drawer seams on the east face (visible)
  for (const z of [10, 22]) {
    out.push(L(SEG([[-55.9, -202, z], [-55.9, -154, z]]), { tone: "lo" }));
    out.push(D([at([-55.9, -202, z]), at([-55.9, -154, z])], { size: 0.55 }));
  }
  // doorway recess on the south face where the lane enters
  for (const px of [-100, -87]) {
    out.push(S(k.slabOf({ x: px, y: -151, w: 3, d: 1.6, r: 0.5 }, 0, 38, P1, 3, 0.4), { tone: "mid" }));
  }
  out.push(S(k.slabOf({ x: -100, y: -151, w: 16, d: 1.6, r: 0.5 }, 38, 3.5, P1, 3, 0.4), { tone: "mid" }));
  // intake porthole — vertical green rim on the wall around the glowing dome bulge
  out.push(`<g style="--anatomy-dot:var(--anatomy-green)">`);
  out.push(L([k.sideRing([DOME1[0], -149.4, DOME1[2]], DOME_R1 + 1.4, "y", P1, 28)], { tone: "green" }));
  out.push(`</g>`);
  out.push(S(sphereOf(DOME1, DOME_R1, P1), { tone: "hi" }));
  out.push(`<g style="--anatomy-dot:var(--anatomy-green)">${D([at([DOME1[0] + 2.6, DOME1[1] + DOME_R1 * 0.62, DOME1[2] + 2.6])], { size: 0.55, tone: "hi" })}</g>`);
  // engine bell + lamp
  out.push(bellSvg(g1, ENG1[0], ENG1[1], ENG_Z1, { lamp: "engine-lamp1" }));
  out.push(...g1.bev(ENG1[0] - 8.6, ENG1[1] + 7.6, ENG_Z1 + 0.001));
  // load gauge
  const gauge = gaugeSvg(g1, -60, -156, 41, { part: "needle1" });
  f1NEEDLE = gauge.frames;
  out.push(gauge.svg);
  return out.join("");
}

function f1Mast() {
  const { S, L, D, SEG, at } = g1;
  const out = [];
  out.push(S(k.slabOf(MAST1.base, 0, 3, P1, 4, 0.6), { tone: "mid" }));
  out.push(S(k.slabOf(MAST1.post, 3, 55, P1, 4, 0.5), { tone: "mid" }));
  out.push(S(k.cylinder(26, 82, 3.4, 56, 2.6, P1, 28), { tone: "mid" }));
  out.push(L([k.ring(26, 82, 3.4, 58.6, P1, 28)], { tone: "lo" }));
  out.push(...g1.bev(28.3, 84, 58.6));
  // arm reaching north over the lane
  out.push(S(k.slabOf(MAST1.arm, 50, 4, P1, 4, 0.5), { tone: "mid", crease: "none" }));
  out.push(...g1.bev(25.5, 58, 54));
  // pulley + crack
  out.push(L(SEG([[26, 64, 50.4], [26, 64, 49.1]]), { tone: "mid" }));
  out.push(L([k.sideRing([PULLEY1[0], PULLEY1[1], PULLEY1[2]], 4.2, "y", P1, 24)], { tone: "mid" }));
  out.push(L(SEG([[26, 64, 44.2], [26, 64, 43.1]]), { tone: "hi" }));
  out.push(D([at([26, 64, 42.9])], { size: 0.6 }));
  out.push(colorLine(g1, [[24.4, 64.6, 49.6], [26.1, 64.6, 47.6], [25, 64.6, 45.4], [27.2, 64.6, 43.6]], "red"));
  // snapped cord, terminal red dots
  out.push(`<g style="--anatomy-dot:var(--anatomy-red)">${k.wireSvg(at([26, 64, 42]), at([24.5, 65.5, 17]), { tone: "red", size: 1.2 })}</g>`);
  // red flag
  out.push(S(k.slabOf({ x: 27, y: 84, w: 2, d: 2, r: 0.5 }, 58, 8, P1, 3, 0.4), { tone: "mid", crease: "none" }));
  out.push(colorLine(g1, [[28.2, 84.8, 66], [24.6, 84.8, 63.8], [28.2, 84.8, 61.6]], "red"));
  return out.join("");
}

function f1Tray() {
  const { S, L } = g1;
  const out = [];
  out.push(S(k.slabOf(TRAY1, 4, 3, P1, 3, 0.5), { tone: "mid", crease: "none" })); // floor
  for (const wy of [70, 93]) {
    out.push(S(k.slabOf({ x: 44, y: wy, w: 32, d: 3, r: 1 }, 4, 12, P1, 3, 0.5), { tone: "mid" }));
    out.push(colorLine(g1, [[44.2, wy + 1.5, 16.15], [75.8, wy + 1.5, 16.15]], "red"));
  }
  out.push(...g1.bev(45.2, 71.5, 16));
  out.push(...g1.bev(74.8, 94.5, 16));
  out.push(ghostCapsule(g1, [57, 86, 9.6], [1, -0.25, 0.06], 5, 2.4));
  return out.join("");
}

// semaphore arm angles (screen-space rotation about the pivot)
const SWITCH_ANGLES = (() => {
  const [px, py] = g1.at(PIVOT1);
  const angleTo = (world) => {
    const [tx, ty] = g1.at(world);
    return (Math.atan2(ty - py, tx - px) * 180) / Math.PI;
  };
  return { tunnel: angleTo(MOUTH_T), funnel: angleTo(MOUTH_F) };
})();

let f1NEEDLE = [];
const SCR1 = {
  tunnel: [[-104, 18, 31.7], [LTX, 10, 31.7], [LTX, -40, 31.7], [LTX, DOCK_Y, 31.7]].map(g1.at),
  funnel: [[-140, LFY, 31.7], [-128, LFY, 31.7], [26, LFY, 31.7]].map(g1.at),
  dropTo: g1.at([50, 74, 8.6]),
};

const fig1Labels = () => [
  g1.label([-178, -4, 41.5], ["Railway", "the deployed board"], [-28, -28], "end"),
  g1.label([-168, 38.5, 48.6], "spare capsules", [-45, 0], "end"),
  g1.label([-104, 44, 36], "route switch", [-30, 36], "end"),
  g1.label([-90, -44, 70.4], ["Cloudflare edge", "ollama.riazrahaman.com", "proxied (orange cloud)"], [-15, -90], "end"),
  g1.label([-93, -96, 51.6], ["token gate", "401 without a seal"], [-25, -36], "end"),
  g1.label([-59, -96, 4.8], "401 rejects", [28, 18], "start"),
  g1.label([-92, -180, 61], ["Ollama · :11434", "the local model"], [55, 15], "start"),
  g1.label([-66, -164, 51.2], "tunnel load", [55, 45], "start"),
  g1.label([26, 82, 61], ["DERP relay", "resets the handshake"], [32, -24], "start", "red"),
  g1.label([76, 93, 16.3], ["dead tray", "ECONNRESET"], [32, 20], "start", "red"),
].join("");

const fig1Html = `
<div class="tf-arch-wrap">
  <div class="tf-arch-bar">
    <div class="tf-arch-controls">
      <button class="tf-arch-btn active" id="tf-btn-both" type="button">Compare Both</button>
      <button class="tf-arch-btn" id="tf-btn-cf" type="button">Cloudflare Tunnel (Active)</button>
      <button class="tf-arch-btn" id="tf-btn-ts" type="button">Tailscale Funnel (Retired)</button>
    </div>
  </div>

  <div class="tf-arch-grid">
    <!-- Zone 1: Cloud Source (Railway) -->
    <div class="tf-zone tf-zone-cloud">
      <div class="tf-zone-label">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg>
        Cloud Source
      </div>
      <div class="tf-node-box tf-node-railway">
        <div class="tf-node-head">
          <span class="tf-node-title">Railway App</span>
          <span class="tf-badge">Docker</span>
        </div>
        <p class="tf-node-sub">Production deployment of <code>agent-kanban-board</code>. Generates client LLM queries.</p>
      </div>
      <div class="tf-snippet-box">
        <div class="tf-snippet-title">HTTP Request</div>
        <div class="tf-code">POST /api/generate</div>
        <div class="tf-code-hl">Host: ollama.riazrahaman.com</div>
        <div class="tf-code">Authorization: Bearer &lt;token&gt;</div>
      </div>
    </div>

    <!-- Zone 2: Network / Routing Fork -->
    <div class="tf-zone-routes">
      <!-- Route A: Cloudflare Tunnel (Success) -->
      <div class="tf-route-card tf-route-cf" id="tf-lane-cf">
        <div class="tf-route-head">
          <div class="tf-route-title">
            <span class="tf-icon-check">✔</span>
            <b>Cloudflare Tunnel Route (Fixed)</b>
          </div>
          <span class="tf-status-pill tf-pill-success">HTTP 200 OK</span>
        </div>
        <div class="tf-route-desc">
          Proxied DNS (<b style="color:#f6821c;">Orange Cloud</b>) Anycast Edge → Outbound QUIC/TLS 1.3 Tunnel to Mac
        </div>
        <div class="tf-track-wrap">
          <svg class="tf-track-svg" viewBox="0 0 340 32">
            <line x1="8" y1="16" x2="332" y2="16" stroke="var(--anatomy-green)" stroke-width="2.5" stroke-dasharray="6 4" opacity="0.6"/>
            <circle cx="12" cy="16" r="5" fill="var(--anatomy-green)" class="tf-packet-cf">
              <animate attributeName="cx" values="12;328" dur="2.4s" repeatCount="indefinite" />
            </circle>
          </svg>
        </div>
        <div class="tf-route-foot">
          <span>Anycast Edge DNS</span>
          <span>Zero Open Inbound Ports</span>
          <span>Stable QUIC Multiplex</span>
        </div>
      </div>

      <!-- Route B: Tailscale Funnel (Failure) -->
      <div class="tf-route-card tf-route-ts" id="tf-lane-ts">
        <div class="tf-route-head">
          <div class="tf-route-title">
            <span class="tf-icon-cross">✖</span>
            <b>Tailscale Funnel Route (Retired)</b>
          </div>
          <span class="tf-status-pill tf-pill-fail">502 ECONNRESET</span>
        </div>
        <div class="tf-route-desc">
          Public Funnel Relay (<b style="color:var(--anatomy-red);">DERP Server</b>) terminates TLS → abruptly drops/resets handshake
        </div>
        <div class="tf-track-wrap">
          <svg class="tf-track-svg" viewBox="0 0 340 32">
            <line x1="8" y1="16" x2="190" y2="16" stroke="var(--anatomy-red)" stroke-width="2.5" stroke-dasharray="4 4" opacity="0.7"/>
            <line x1="192" y1="10" x2="204" y2="22" stroke="var(--anatomy-red)" stroke-width="2.5"/>
            <line x1="204" y1="10" x2="192" y2="22" stroke="var(--anatomy-red)" stroke-width="2.5"/>
            <line x1="210" y1="16" x2="332" y2="16" stroke="var(--anatomy-lo)" stroke-width="1.5" stroke-dasharray="2 4"/>
            <circle cx="12" cy="16" r="5" fill="var(--anatomy-red)" class="tf-packet-ts">
              <animate attributeName="cx" values="12;198" dur="1.8s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="1;1;0" dur="1.8s" repeatCount="indefinite" />
            </circle>
          </svg>
        </div>
        <div class="tf-route-foot">
          <span>MagicDNS</span>
          <span style="color:var(--anatomy-red);">DERP TLS Handshake Reset</span>
          <span>Connection Severed</span>
        </div>
      </div>
    </div>

    <!-- Zone 3: Local macOS Workstation -->
    <div class="tf-zone tf-zone-mac">
      <div class="tf-zone-label">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
        Local macOS Workstation
      </div>

      <div class="tf-node-box tf-node-mac-service" style="border-left: 3px solid var(--anatomy-green);">
        <div class="tf-node-head">
          <span class="tf-node-title">cloudflared</span>
          <span class="tf-badge">launchd KeepAlive</span>
        </div>
        <p class="tf-node-sub">Local daemon running at boot. Maintains active outbound tunnel to Cloudflare Edge.</p>
      </div>

      <div class="tf-node-box tf-node-mac-service" style="border-left: 3px solid var(--anatomy-blue);">
        <div class="tf-node-head">
          <span class="tf-node-title">Token Gateway</span>
          <span class="tf-badge" style="color:var(--anatomy-blue); font-weight:600;">:11435</span>
        </div>
        <p class="tf-node-sub">Enforces <code>Authorization: Bearer</code>. Rejects tokenless probes with <code>401 Unauthorized</code>.</p>
      </div>

      <div class="tf-node-box tf-node-mac-service" style="border-left: 3px solid var(--anatomy-green);">
        <div class="tf-node-head">
          <span class="tf-node-title">Ollama Engine</span>
          <span class="tf-badge" style="color:var(--anatomy-green); font-weight:600;">:11434</span>
        </div>
        <p class="tf-node-sub">Local inference engine. Serves model completions with <code>HTTP 200 OK</code>.</p>
      </div>
    </div>
  </div>
</div>
`;

// ═══════════════════════════════════════════════════════════════
// FIG 2 — “The fixed path”: five stations on one green rail —
// DNS (one proxied record) → edge → cloudflared (launchd) →
// token gateway :11435 → Ollama :11434.
// ═══════════════════════════════════════════════════════════════
const W2 = 1024, H2 = 560;
const B2 = { x: -216, y: -56, w: 436, d: 118, r: 10 };
const STX = [-168, -84, 0, 84, 168];
const R2_TOP = 27; // rail z 22..27
const LANE2 = 2;

const fit2 = [
  ...k.boxCorners(B2, -PLATE_H - FOOT_H, 0),
  [-84 - 8, -27.5, 55],     // edge-arch ribbon top
  [168 + 9, -12, 26],       // mini gauge
  [84 - 1.4, -21.5, 48.5],  // gate beacon
  [168 - 2, -24, 36.2],     // engine bell top
  [3, -15.4, 33],           // governor wheel
  [-168, -22, 31], [220, 60, 4],
];
const P2 = k.fitProjection(fit2, W2, H2, { pad: 26, azimuth: AZ });
const g2 = mk(P2);

function f2Rail() {
  const out = [];
  out.push(railPosts(g2, [-204, -162, -120, -78, -36, 6, 48, 90, 132].map((x) => [x, LANE2]), 22));
  const rail = { x: -208, y: LANE2 - 3, w: 420, d: 6, r: 1 };
  out.push(g2.S(k.slabOf(rail, 22, 5, g2.P, 3, 0.4), { tone: "mid", lit: true }));
  out.push(g2.L(k.planOutline(k.insetPlan(rail, 1.4), R2_TOP, g2.P), { tone: "faint" }));
  out.push(colorLine(g2, [[-202, LANE2, R2_TOP + 0.15], [196, LANE2, R2_TOP + 0.15]], "green", { flow: true }));
  return out.join("");
}

function plinth(sx) {
  const out = [];
  const plan = { x: sx - 16, y: -38, w: 32, d: 30, r: 2 };
  out.push(g2.S(k.slabOf(plan, 0, 18, g2.P, 5, 0.8), { tone: "mid" }));
  out.push(g2.L(k.planOutline(k.insetPlan(plan, 1.4), 18, g2.P), { tone: "lo" }));
  for (const [x, y] of k.corners(plan, 4.5)) out.push(...g2.bev(x, y, 18));
  return out.join("");
}
const stDot = (i, world) => `<g data-part="st-${i}">${g2.D([g2.at(world)], { size: 0.85, tone: "lit" })}</g>`;

function f2Stations() {
  const out = [];
  // ── S0 DNS records ──
  {
    const sx = STX[0];
    out.push(plinth(sx));
    out.push(g2.S(k.slabOf({ x: sx - 12, y: -33, w: 24, d: 22, r: 1.4 }, 18, 6, g2.P, 4, 0.5), { tone: "mid" }));
    out.push(k.faceTextSvg(k.sideMatrix([sx - 11, -10.9], 21.6, P2, "left"), "DNS", { size: 2.2, tone: "lo" }));
    for (const [dx, proxied] of [[-8, false], [0, false], [8, true]]) {
      out.push(proxied ? `<g>` : `<g style="opacity:.55">`);
      out.push(g2.S(k.cylinder(sx + dx, -22, 3.8, 24, 5.5, g2.P, 20), { tone: proxied ? "hi" : "lo" }));
      out.push(g2.S(k.cylinder(sx + dx, -22, 2.3, 29.5, 2, g2.P, 16), { tone: proxied ? "hi" : "lo" }));
      out.push(
        proxied
          ? `<g style="--anatomy-dot:#f6821c">${g2.D([g2.at([sx + dx, -22, 31.8])], { size: 0.8, tone: "hi" })}</g>`
          : g2.D([g2.at([sx + dx, -22, 31.8])], { size: 0.5, tone: "lo" }),
      );
      out.push(`</g>`);
    }
    out.push(stDot(0, [sx, -7.4, 19]));
  }
  // ── S1 Cloudflare edge ──
  {
    const sx = STX[1];
    out.push(plinth(sx));
    for (const dx of [-11, 6.5]) {
      out.push(g2.S(k.slabOf({ x: sx + dx, y: -33, w: 4.5, d: 6, r: 1 }, 18, 24, g2.P, 4, 0.4), { tone: "mid" }));
    }
    out.push(g2.S(k.slabOf({ x: sx - 13, y: -36, w: 30, d: 11, r: 1.8 }, 42, 7.5, g2.P, 4, 0.5), { tone: "mid", lit: true }));
    const rib = { x: sx - 8, y: -27.5, w: 16, d: 2.4, r: 0.8 };
    out.push(g2.S(k.slabOf(rib, 49.5, 5, g2.P, 3, 0.3), { tone: "hi", lit: true }));
    out.push(k.faceTextSvg(k.sideMatrix([sx - 7, -25.05], 52.1, P2, "left"), "edge", { size: 2, tone: "mid" }));
    // the record story, tiny: grey grey orange
    for (const [dx, proxied] of [[-4, false], [0, false], [4, true]]) {
      out.push(
        proxied
          ? `<g style="--anatomy-dot:#f6821c">${g2.D([g2.at([sx + dx, -24.6, 42.6])], { size: 0.6, tone: "hi" })}</g>`
          : g2.D([g2.at([sx + dx, -24.6, 42.6])], { size: 0.45, tone: "lo" }),
      );
    }
    out.push(stDot(1, [sx, -7.4, 19]));
  }
  // ── S2 cloudflared + launchd governor ──
  {
    const sx = STX[2];
    out.push(plinth(sx));
    out.push(g2.S(k.slabOf({ x: sx - 9, y: -32, w: 18, d: 16, r: 1.6 }, 18, 18, g2.P, 4, 0.6), { tone: "mid" }));
    out.push(g2.S(k.slabOf(k.insetPlan({ x: sx - 9, y: -32, w: 18, d: 16, r: 1.6 }, 0.9), 36, 2.5, g2.P, 4, 0.4), { tone: "mid", lit: true }));
    // governor wheel on the box's south face (xz plane, facing the camera) + chain + counterweight
    const c = [sx + 3, -15.4, 28.5];
    out.push(g2.L([k.sideRing(c, 4.2, "y", g2.P, 24)], { tone: "mid" }));
    const spokes = [];
    for (const a of [0.4, 1.97, 3.54, 5.11]) {
      spokes.push(g2.at(c), g2.at([c[0] + Math.cos(a) * 3.4, c[1], c[2] + Math.sin(a) * 3.4]));
    }
    out.push(g2.L(k.pathOf(spokes), { tone: "lo" }));
    out.push(g2.D([g2.at(c)], { size: 0.55 }));
    out.push(k.wireSvg(g2.at([c[0], c[1], c[2] - 4.1]), g2.at([c[0] + 1.2, c[1], 21.8]), { tone: "lo", size: 0.9 }));
    out.push(g2.S(k.cylinder(c[0] + 1.2, c[1] + 1, 1.5, 18.6, 3, g2.P, 14), { tone: "mid" }));
    out.push(g2.D([g2.at([c[0] + 1.2, c[1] + 1, 21.8])], { size: 0.45 }));
    out.push(stDot(2, [sx, -7.4, 19]));
  }
  // ── S3 token gateway :11435 ──
  {
    const sx = STX[3];
    out.push(plinth(sx));
    for (const y of [-33, -15]) {
      out.push(g2.S(k.slabOf({ x: sx - 3, y, w: 5, d: 5.5, r: 1.2 }, 18, 22, g2.P, 4, 0.4), { tone: "mid" }));
    }
    out.push(g2.S(k.slabOf({ x: sx - 4.6, y: -33, w: 6.4, d: 23.5, r: 1 }, 40, 4, g2.P, 3, 0.4), { tone: "mid", lit: true }));
    out.push(`<g style="--anatomy-dot:var(--anatomy-green)">${g2.L(k.planOutline(k.insetPlan({ x: sx - 4.6, y: -33, w: 6.4, d: 23.5, r: 1 }, 1.2), 44.15, g2.P), { tone: "green" })}</g>`);
    out.push(colorLine(g2, [[sx - 3.4, -9.45, 42.2], [sx + 1.9, -9.45, 42.2]], "green"));
    out.push(g2.S(k.cylinder(sx - 1.4, -21.5, 1.6, 44, 3, g2.P, 16), { tone: "mid" }));
    out.push(`<g style="--anatomy-dot:var(--anatomy-green)">${g2.L([k.ring(sx - 1.4, -21.5, 1.8, 47, g2.P, 16)], { tone: "green" })}</g>`);
    out.push(`<g data-part="st-3">${g2.D([g2.at([sx - 1.4, -21.5, 47.3])], { size: 0.95, tone: "lit" })}</g>`);
    // "401" engraved on the near post's south face
    out.push(k.faceTextSvg(k.sideMatrix([sx - 2.6, -9.4], 34, P2, "left"), "401", { size: 2, tone: "lo" }));
    // reject bin + tokenless husk
    out.push(g2.S(k.slabOf({ x: sx + 7, y: -14, w: 9, d: 8, r: 1 }, 18, 3, g2.P, 3, 0.4), { tone: "mid" }));
    out.push(ghostCapsule(g2, [sx + 8.6, -10.6, 22.8], [1, 0.2, 0], 4, 1.8));
  }
  // ── S4 Ollama engine :11434 ──
  {
    const sx = STX[4];
    out.push(plinth(sx));
    out.push(bellSvg(g2, sx - 2, -24, 18, { lamp: "engine-lamp2", scale: 0.8 }));
    const gauge = gaugeSvg(g2, sx + 9, -12, 18, { part: "needle2", dialH: 7.2 });
    f2NEEDLE = gauge.frames;
    out.push(gauge.svg);
    out.push(stDot(4, [sx, -7.4, 19]));
  }
  return out.join("");
}

function f2Dock() {
  const out = [];
  // end wall + intake socket; the capsule docks nose-first here
  out.push(g2.S(k.slabOf({ x: 206, y: -8, w: 6, d: 20, r: 1 }, 0, 40, g2.P, 4, 0.5), { tone: "mid" }));
  out.push(`<g style="--anatomy-dot:var(--anatomy-green)">`);
  out.push(g2.L([k.ring(205.4, LANE2, 6.6, 28, g2.P, 24)], { tone: "green" }));
  out.push(g2.D([g2.at([205.4, LANE2 + 6.6, 28])], { size: 0.5, tone: "hi" }));
  out.push(`</g>`);
  out.push(g2.S(sphereOf([205.4, LANE2, 28], 5.4, g2.P), { tone: "hi" }));
  out.push(g2.D([g2.at([203.2, LANE2 + 3, 31.2])], { size: 0.45 }));
  return out.join("");
}

let f2NEEDLE = [];
const SCR2 = {
  path: [[-202, LANE2, 27.7], [-196, LANE2, 27.7], [96, LANE2, 27.7], [203.5, LANE2, 27.7]].map(g2.at),
};
// arc-length thresholds (world-x crossings) at which each station pulses
const ST2_T = STX.map((sx) => [sx, g2.at([sx, LANE2, 27.7])]);

const fig2Labels = () => [
  g2.label([-168, -7.4, 19], ["DNS records", "one proxied · orange", "rest grey-clouded"], [8, 88], "end"),
  g2.label([-84, -27.5, 55], ["Cloudflare edge", "TLS terminates here"], [10, -46], "start"),
  g2.label([3, -14.6, 31], ["cloudflared connector", "launchd · RunAtLoad", "+ KeepAlive"], [-50, 62], "end"),
  g2.label([84 - 1.4, -21.5, 48], ["gateway :11435", "401 without a token"], [18, -52], "start"),
  g2.label([84 + 9, -10.5, 22.8], "tokenless → 401 bin", [40, -34], "start"),
  g2.label([166, -24, 30.2], ["Ollama · :11434", "the local model"], [30, 50], "start"),
].join("");

const fig2Svg = k.figureSvg({
  width: W2,
  height: H2,
  label:
    "The fixed path as five stations along one green rail. A request capsule tours them in order: DNS records where only the tunnel hostname is proxied (orange) while the rest stay grey-clouded; the Cloudflare edge where TLS terminates; the cloudflared connector box with the launchd governor that keeps it alive; the token gateway on :11435 with its 401 reject bin; and the Ollama engine on :11434 where the capsule docks and the load needle kicks.",
  body: [
    bench(g2, B2, PLATE_H, FOOT_H),
    f2Rail(),
    `<g data-part="cap2">${capsuleSvg(g2, -196, LANE2, 27)}</g>`,
    f2Stations(),
    f2Dock(),
    fig2Labels(),
  ],
});

// ═══════════════════════════════════════════════════════════════
// live scripts
// ═══════════════════════════════════════════════════════════════
const live1 = `
(() => {
const stage = document.getElementById("tf-routes");
if (!stage) return;
const btnBoth = document.getElementById("tf-btn-both");
const btnCf = document.getElementById("tf-btn-cf");
const btnTs = document.getElementById("tf-btn-ts");
const laneCf = document.getElementById("tf-lane-cf");
const laneTs = document.getElementById("tf-lane-ts");
const readout = stage.closest(".iso-plate").querySelector("[data-readout]");
const still = matchMedia("(prefers-reduced-motion: reduce)");

const setMode = (mode) => {
  btnBoth.classList.toggle("active", mode === "both");
  btnCf.classList.toggle("active", mode === "cf");
  btnTs.classList.toggle("active", mode === "ts");
  if (mode === "both") {
    laneCf.style.display = "block";
    laneTs.style.display = "block";
    if (readout) readout.textContent = "comparing both routes · Cloudflare tunnel (200) vs Tailscale funnel (502)";
  } else if (mode === "cf") {
    laneCf.style.display = "block";
    laneTs.style.display = "none";
    if (readout) readout.textContent = "HTTP 200 · edge → gateway :11435 → ollama :11434";
  } else {
    laneCf.style.display = "none";
    laneTs.style.display = "block";
    if (readout) readout.textContent = "502 ECONNRESET · DERP relay reset TLS handshake";
  }
};

if (btnBoth) btnBoth.addEventListener("click", () => setMode("both"));
if (btnCf) btnCf.addEventListener("click", () => setMode("cf"));
if (btnTs) btnTs.addEventListener("click", () => setMode("ts"));

// Narrative auto-looping readout when comparing both routes
const READOUTS = [
  "Cloudflare tunnel · Anycast edge terminates TLS 1.3",
  "Token gateway :11435 · Bearer seal verified (200 OK)",
  "Ollama engine :11434 · streaming model response",
  "Tailscale funnel · traffic routed to shared DERP relay",
  "502 ECONNRESET · DERP relay reset TLS handshake in transit",
];
let rIdx = 0;
if (!still.matches) {
  setInterval(() => {
    rIdx = (rIdx + 1) % READOUTS.length;
    if (readout && btnBoth && btnBoth.classList.contains("active")) {
      readout.textContent = READOUTS[rIdx];
    }
  }, 3200);
}
})();
`;

const live2 = `
(() => {
const stage = document.getElementById("tf-chain");
const svg = stage.querySelector("svg");
const cap = svg.querySelector('[data-part="cap2"]');
const needle = svg.querySelector('[data-part="needle2"]');
const engineLamp = svg.querySelector('[data-part="engine-lamp2"]');
const stations = [0, 1, 2, 3, 4].map((i) => svg.querySelector('[data-part="st-' + i + '"]'));
const readout = stage.closest(".iso-plate").querySelector("[data-readout]");
const still = matchMedia("(prefers-reduced-motion: reduce)");

const SCR = ${JSON.stringify(SCR2)};
const REST = SCR.path[1];
const NEEDLE = ${JSON.stringify(f2NEEDLE)};
const SPEED = 88, IDLE_GAP = 6;

// station pulse thresholds as arc-length along the path (skip the rest jump)
const len2 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const base = len2(SCR.path[0], SCR.path[1]);
const STS = ${JSON.stringify(ST2_T.map(([sx, spt]) => Math.hypot(spt[0] - SCR2.path[1][0], spt[1] - SCR2.path[1][1])))};
const NOTES = [
  "dns · only the tunnel hostname is proxied",
  "edge · the hostname's TLS terminates here",
  "cloudflared · connector kept alive by launchd",
  "gateway :11435 · seal accepted — 401 without it",
];

let phase = "parked";
let t = 0, last = 0, idle = 2;
let visible = false, frame = 0;
let needleV = 0.28, lampV = 0;
let nextSt = 0;
const env = [0, 0, 0, 0, 0];

function sample(pts, s) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = len2(pts[i - 1], pts[i]);
    if (total + l >= s) {
      const f = l ? (s - total) / l : 0;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
    }
    total += l;
  }
  return pts[pts.length - 1];
}
const LEN = ${JSON.stringify(
    (() => {
      const p = SCR2.path;
      let total = 0;
      for (let i = 1; i < p.length; i++) total += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      return total;
    })(),
  )};
const setP = (p) => cap.setAttribute("transform", "translate(" + (p[0] - REST[0]).toFixed(2) + "," + (p[1] - REST[1]).toFixed(2) + ")");
const show = (el, on) => { el.style.opacity = on ? "1" : "0"; };
const setText = (text) => { if (readout.textContent !== text) readout.textContent = text; };

function park() {
  phase = "parked";
  show(cap, false);
  setText("the fixed path · idle — click to run a request");
}
function send() {
  idle = 0;
  show(cap, true);
  phase = "run"; t = 0; nextSt = 0;
  setText("sending a request down the fixed path…");
}
function stillStill() {
  show(cap, true);
  setP(SCR.path[3]);
  needleV = 1; lampV = 0.5;
  for (let i = 0; i < 5; i++) env[i] = 0.5;
  drawEnvelope();
  needle.setAttribute("d", NEEDLE[40]);
  engineLamp.style.opacity = "0.7";
  setText("HTTP 200 · edge → gateway :11435 → ollama :11434");
  phase = "parked";
}
function drawEnvelope() {
  for (let i = 0; i < stations.length; i++) stations[i].style.opacity = String(0.25 + env[i] * 0.75);
}

function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  t += dt;

  if (phase === "parked") {
    idle += dt;
    if (idle > IDLE_GAP) send();
  } else if (phase === "run") {
    const s = Math.min(LEN, t * SPEED + base);
    setP(sample(SCR.path, s));
    while (nextSt < 4 && s >= base + STS[nextSt]) {
      env[nextSt] = 1;
      setText(NOTES[nextSt]);
      nextSt++;
    }
    if (s >= LEN) {
      env[4] = 1; lampV = 1; needleV = 1;
      show(cap, true);
      setText("HTTP 200 · edge → gateway :11435 → ollama :11434");
      phase = "rest"; t = 0;
    }
  } else if (phase === "rest") {
    if (t > 1.6) show(cap, false);
    if (t > 2.2) park();
  }

  needleV += (0.28 - needleV) * (1 - Math.exp(-dt / 0.9));
  needle.setAttribute("d", NEEDLE[Math.max(1, Math.min(40, Math.round(needleV * 40)))]);
  lampV = Math.max(0, lampV - dt * 1.9);
  engineLamp.style.opacity = String(0.4 + lampV * 0.6);
  for (let i = 0; i < 5; i++) env[i] = Math.max(0, env[i] - dt * 1.4);
  drawEnvelope();
  stage.setAttribute("aria-valuetext", readout.textContent);

  if (visible && !still.matches) frame = requestAnimationFrame(tick);
  else frame = 0;
}
const run = () => { if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); } };
new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; if (visible) run(); }, { rootMargin: "120px 0px" }).observe(stage);
stage.addEventListener("pointerdown", () => { send(); run(); });
stage.addEventListener("keydown", (e) => {
  if ([" ", "Enter"].includes(e.key)) { e.preventDefault(); send(); run(); }
});

if (still.matches) stillStill(); else { park(); run(); }
})();
`;

// ═══════════════════════════════════════════════════════════════
// page
// ═══════════════════════════════════════════════════════════════
const fig1 = k.plateHtml({
  fig: "Fig 1",
  title: "Two routes, one request",
  hint: "",
  readout: "Cloudflare tunnel · Anycast edge → gateway :11435 → ollama :11434",
  keys: [
    { mark: "green", label: "The fixed route — Cloudflare Anycast edge, token gate :11435, Ollama :11434 (200 OK)" },
    { mark: "red", label: "The old funnel route — shared DERP relay reset, connection severed (502 ECONNRESET)" },
  ],
  caption:
    "Same request, two architectures. On the left, the deployed Agent Kanban Board on Railway initiates an LLM completion. In the center, two routes: (1) The fixed Cloudflare Tunnel route terminates TLS at Cloudflare's Anycast edge with proxied DNS (ollama.riazrahaman.com) and proxies through an outbound QUIC tunnel into the Mac; (2) The old Tailscale Funnel route routed through a public DERP relay that reset TLS handshakes mid-transit (502/ECONNRESET). On the right, the local macOS workstation runs cloudflared (launchd KeepAlive), the token gate (:11435, 401 without valid bearer seal), and the Ollama model engine (:11434, HTTP 200).",
  body: `<div class="iso-stage" id="tf-routes" tabindex="0" role="region" aria-label="Architecture flow: Railway to local Ollama via Cloudflare tunnel vs Tailscale funnel">${fig1Html}</div>`,
});

const fig2 = k.plateHtml({
  fig: "Fig 2",
  title: "The fixed path",
  hint: "click to re-run the request",
  readout: "the fixed path · idle — click to run a request",
  keys: [
    { mark: "lit", label: "The request capsule; a station pulses as it passes" },
    { mark: "green", label: "The live path the capsule rides" },
    { mark: "dim", label: "Grey-clouded DNS records; the orange dot is the one proxied record" },
  ],
  caption:
    "The change, station by station. DNS: ollama.riazrahaman.com is proxied through Cloudflare (orange) while the other records stay grey-clouded, so only the tunnel hostname rides the edge. Edge: anycast TLS termination next to the users. Connector: cloudflared on the Mac, run as a launchd agent (RunAtLoad + KeepAlive — the governor wheel never stops). Gateway :11435: no seal, 401 into the reject bin. Finally Ollama on :11434 answers the request: HTTP 200.",
  body: `<div class="iso-stage" id="tf-chain" tabindex="0" role="button" aria-label="The fixed path: press space or click to send a request down the chain">${fig2Svg}</div>`,
});

const head = `
<header class="tf-head">
  <p class="tf-kicker">what broke, and what fixed it</p>
  <h1>The tunnel fix</h1>
  <p class="tf-lede">The board on Railway needs the model running on this Mac. The old route — Tailscale's funnel — handed the connection to a DERP relay that reset every TLS handshake, so requests died in transit (<code>ECONNRESET</code>). The fix gives the model its own lane: the hostname <code>ollama.riazrahaman.com</code> is proxied at the Cloudflare edge, a <code>cloudflared</code> connector (kept alive by launchd) carries traffic home, and a token-guarded gateway on <code>:11435</code> proxies straight into Ollama on <code>:11434</code>.</p>
</header>`;

const note = `
<section class="tf-note">
  <h2>What actually changed</h2>
  <ol>
    <li><b>DNS</b> — <code>ollama.riazrahaman.com</code> became the one proxied (orange-cloud) record; the rest stay grey-clouded (DNS only).</li>
    <li><b>Connector</b> — <code>cloudflared</code> runs as a launchd agent with <code>RunAtLoad</code> + <code>KeepAlive</code>: the tunnel is up at boot and restarts if it dies.</li>
    <li><b>Path</b> — Cloudflare edge → gateway on <code>:11435</code> that demands a token (<code>401</code> without one) → Ollama on <code>:11434</code>. No mesh relay in between.</li>
    <li><b>Retired</b> — the Tailscale funnel route, whose DERP relay kept resetting the handshake.</li>
  </ol>
</section>`;

const styles = `
<style>
.tf-head{margin:0 0 8px}
.tf-kicker{margin:0 0 6px;font-family:var(--anatomy-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--anatomy-muted)}
.tf-head h1{margin:0 0 10px;font-size:30px;line-height:1.15;font-weight:650;letter-spacing:-.01em;color:var(--anatomy-strong)}
.tf-lede{margin:0;max-width:62ch;color:var(--anatomy-text)}
.tf-note{margin:44px 0 8px;padding:18px 20px;border-radius:10px;background:var(--anatomy-card);box-shadow:0 0 0 1px var(--anatomy-faint)}
.tf-note h2{margin:0 0 8px;font-size:12.5px;font-family:var(--anatomy-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--anatomy-muted);font-weight:600}
.tf-note ol{margin:0;padding-left:20px;color:var(--anatomy-text)}
.tf-note li{margin:6px 0;line-height:1.55}
.tf-note b{color:var(--anatomy-strong)}
code{font-family:var(--anatomy-mono);font-size:.92em;color:var(--anatomy-strong)}
.iso-label text{font-size:15.5px}
.tf-strip{--anatomy-weight:1.25px}
.iso-stage:focus{outline:none}
.iso-stage:focus-visible{outline:1.5px dashed var(--anatomy-mid);outline-offset:8px;border-radius:4px}

/* Option 1 Architecture Diagram Styles */
.tf-arch-wrap { padding: 4px 0 8px; }
.tf-arch-bar { display: flex; justify-content: flex-end; margin-bottom: 16px; }
.tf-arch-controls { display: inline-flex; gap: 4px; background: var(--anatomy-card); padding: 3px; border: 1px solid var(--anatomy-faint); border-radius: 6px; }
.tf-arch-btn { background: transparent; border: 1px solid transparent; color: var(--anatomy-muted); font-family: var(--anatomy-mono); font-size: 11px; padding: 5px 12px; border-radius: 4px; cursor: pointer; transition: all .15s; }
.tf-arch-btn:hover { color: var(--anatomy-strong); }
.tf-arch-btn.active { background: var(--anatomy-face); border-color: var(--anatomy-mid); color: var(--anatomy-strong); font-weight: 600; }
.tf-arch-grid { display: grid; grid-template-columns: 240px 1fr 320px; gap: 20px; align-items: stretch; }
@media (max-width: 900px) { .tf-arch-grid { grid-template-columns: 1fr; gap: 16px; } }
.tf-zone { background: var(--anatomy-face); border: 1px solid var(--anatomy-faint); border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.tf-zone-label { font-family: var(--anatomy-mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--anatomy-muted); display: flex; align-items: center; gap: 6px; }
.tf-node-box { background: var(--anatomy-card); border: 1px solid var(--anatomy-faint); border-radius: 6px; padding: 12px; }
.tf-node-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.tf-node-title { font-weight: 600; font-size: 13.5px; color: var(--anatomy-strong); }
.tf-badge { font-family: var(--anatomy-mono); font-size: 10px; padding: 2px 7px; border-radius: 4px; background: var(--anatomy-page); border: 1px solid var(--anatomy-faint); color: var(--anatomy-muted); }
.tf-node-sub { font-size: 12px; line-height: 1.45; color: var(--anatomy-muted); margin: 0; }
.tf-snippet-box { margin-top: auto; padding: 10px 12px; border-radius: 6px; background: var(--anatomy-card); border: 1px solid var(--anatomy-faint); font-family: var(--anatomy-mono); font-size: 11px; line-height: 1.5; color: var(--anatomy-muted); }
.tf-snippet-title { font-size: 9.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--anatomy-mid); margin-bottom: 6px; font-weight: 600; }
.tf-code { color: var(--anatomy-strong); }
.tf-code-hl { color: var(--anatomy-green); font-weight: 600; }
.tf-zone-routes { display: flex; flex-direction: column; gap: 16px; justify-content: center; }
.tf-route-card { background: var(--anatomy-face); border: 1px solid var(--anatomy-faint); border-radius: 8px; padding: 16px; transition: all .2s; }
.tf-route-cf { border-left: 4px solid var(--anatomy-green); }
.tf-route-ts { border-left: 4px solid var(--anatomy-red); }
.tf-route-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.tf-route-title { font-size: 14px; display: flex; align-items: center; gap: 8px; color: var(--anatomy-strong); font-weight: 600; }
.tf-icon-check { color: var(--anatomy-green); font-weight: bold; }
.tf-icon-cross { color: var(--anatomy-red); font-weight: bold; }
.tf-status-pill { font-family: var(--anatomy-mono); font-size: 11px; font-weight: 600; padding: 2.5px 8px; border-radius: 4px; }
.tf-pill-success { background: rgba(46,160,67,0.15); color: var(--anatomy-green); border: 1px solid var(--anatomy-green); }
.tf-pill-fail { background: rgba(248,81,73,0.15); color: var(--anatomy-red); border: 1px solid var(--anatomy-red); }
.tf-route-desc { font-size: 12.5px; color: var(--anatomy-muted); margin-bottom: 8px; line-height: 1.45; }
.tf-track-wrap { margin: 8px 0; }
.tf-track-svg { width: 100%; height: 32px; display: block; }
.tf-route-foot { display: flex; justify-content: space-between; font-size: 10.5px; font-family: var(--anatomy-mono); color: var(--anatomy-muted); }

/* Plate and Corner adjustments */
.iso-plate-corner[data-corner="readout"] {
  max-width: calc(100% - 40px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width:560px){
  .tf-head h1{font-size:24px}
  .tf-arch-bar { justify-content: flex-start; overflow-x: auto; }
  .tf-route-foot { flex-wrap: wrap; gap: 4px 10px; }
  .iso-plate-corner[data-corner="readout"] { font-size: 9.5px; }
}
</style>`;

writeFileSync(join(HERE, theme === "light" ? "tunnel-fix-light.html" : "tunnel-fix.html"), k.pageHtml({
  title: "The tunnel fix",
  theme,
  width: 1040,
  body: styles + head + fig1 + note + fig2,
  script: kitScript() + live1 + live2,
}));
console.log("wrote", theme === "light" ? "tunnel-fix-light.html" : "tunnel-fix.html");

if (process.env.TF_DEBUG) {
  const probe = {
    f1: {
      deskTopW: [-178, -4, 41.5], pivot: PIVOT1, ribbonTop: [-90, -44, 70.4], beacon: [-93, -96, 51.6],
      rebin: [-59, -96, 4.8], bell: [-92, -180, 61], gauge: [-66, -164, 51.2], mast: [26, 82, 61],
      tray: [76, 93, 16.3], hopper: [-168, 38.5, 48.6], dome: [-92, -140, 36], stubX: [110, 64, 27],
      archLegE: [-76, -52, 52], gatePostE: [-74, -96, 44],
    },
    f2: Object.fromEntries(
      [["s0Top", [-168, -22, 31.8]], ["s0Dot", [-168, -7.4, 19]], ["s1Top", [-84, -27.5, 55]], ["s1Dot", [-84, -7.4, 19]],
       ["s2Wheel", [3, -14.6, 31]], ["s2Dot", [0, -7.4, 19]], ["s3Beacon", [82.6, -21.5, 48]], ["s3Bin", [93, -10.5, 22.8]],
       ["s3Dot", [84, -7.4, 19]], ["s4Bell", [166, -24, 30.2]], ["s4Dot", [168, -7.4, 19]], ["dock", [205.4, 2, 33.5]]]
    ),
  };
  for (const [fig, pts] of Object.entries(probe)) {
    const g = fig === "f1" ? g1 : g2;
    for (const [n, p] of Object.entries(pts)) console.log(`${fig}.${n}`, g.at(p).map((v) => v.toFixed(1)).join(","));
  }
}
