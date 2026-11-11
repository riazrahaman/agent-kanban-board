# HANDOVER — "The tunnel fix" figure

Read NOTES.md first (design contract), then this file. Work happens ONLY in this
directory (`docs/figures/tunnel-fix/`). The repo root is `.`.

## Mission
Improve the anatomy-style interactive illustration that explains the Cloudflare
tunnel fix (moving `ollama.riazrahaman.com` DNS to Cloudflare to stop the
Tailscale Funnel relay resetting TLS). The user wants it to look and read
better. Concretely:
1. **Storytelling** — make the healthy lane (Cloudflare tunnel) vs the broken
   lane (DERP relay) contrast obvious at a glance.
2. **Visual hierarchy** — clear zones (desk / lanes / machine room), machine
   filling the frame, no dead space.
3. **Label legibility** — callouts that never collide, readable at 390 px
   phone width, correct in BOTH dark and light themes.

## Current state (after the restructure pass)
- `build.mjs` (~53 KB) regenerates `tunnel-fix.html` (dark) +
  `tunnel-fix-light.html` (light), ~428 KB each — self-contained two-plate page:
  prose header → **Fig 1 "Two routes, one request"** (the fork) → "What actually
  changed" card → **Fig 2 "The fixed path"** (five-station chain).
- Technical checks are green: `lines.mjs` prints "line ends: 0" on both themes;
  `capture.mjs` reports "console: clean" (desktop, phone 390 px, reduced stills).
- Both animations work: Fig 1 runs the tunnel route first, then alternates on
  idle; Fig 2 tours the five stations with per-station pulses and narrated
  readouts.
- The old single-plate twin-rail layout was REPLACED because the parallel lanes
  stacked visually and the desk-right/machine-left reading order fought the
  story. The desk now sits at the apex of two perpendicular lanes; Fig 2 owns
  the truth-list detail (DNS/launchd/401/ports) that used to crowd one plate.
- **ALL WORK IS UNCOMMITTED** on the working tree.

## Build + verify loop (exact commands)
```bash
cd docs/figures/tunnel-fix
node build.mjs && node build.mjs --light
node ~/.claude/skills/anatomy/scripts/lines.mjs tunnel-fix.html        # want: line ends: 0
node ~/.claude/skills/anatomy/scripts/lines.mjs tunnel-fix-light.html  # want: line ends: 0
node ~/.claude/skills/anatomy/scripts/capture.mjs tunnel-fix.html --out shots/<name>.png --scale 2 --wait 4500   # want: console: clean
```
- Phone check: `capture.mjs ... --width 390 --height 844`
- Reduced-motion stills (deterministic): `--reduced`, add `--key Space` for the
  funnel mode. Focus ring on the card is expected in keyed shots.
- Close-ups: `--zoom x,y,w,h` (CSS px inside the plate) + `--zoom-scale 8`.
- Verify close-ups for painter-order breakage after any DOM reorder.

## Local preview
A python http.server is ALREADY RUNNING: **127.0.0.1:8931**, served from this
directory (shell `sh_183a350c1001h7pDGqemja2DFY`). **DO NOT KILL IT.**
View: http://127.0.0.1:8931/tunnel-fix.html (dark) and
http://127.0.0.1:8931/tunnel-fix-light.html (light). If you need your own
server, use a different port.

## Anatomy kit essentials
- The skill lives at `~/.claude/skills/anatomy/`
  (`kit/iso-kit.mjs`, `kit/lathe.mjs`, `scripts/inline-kit.mjs` → `kitScript()`).
- `build.mjs` imports them by absolute path; the inline kit exposes the helpers
  as bare globals at runtime (`iso`, `pathOf`, `lineSvg`, `ring`, …).
- Key APIs: `fitProjection`, `boxCorners`, `slabOf`, `cylinder`, `ring`,
  `knurl`, `sideRing(center, r, "y", P, steps)` (ring in the xz-plane),
  `topMatrix` / `sideMatrix(at, z, P, "left"|"right")` + `faceTextSvg`,
  `wireSvg`, `haloOf`, `figureSvg`, `plateHtml`, `pageHtml`;
  `lathe.mjs`: `frameAlong`, `lathe(meridian, F, P)`, `sphereOf`.
- Line/solid tones: `hi mid lo faint lit red green blue`.
- Label idiom: hand-rolled dotted leader + target dot + tip dot + monospace
  14 px text (see `label()` inside `build.mjs`).
- Every geometry change goes into `build.mjs` and BOTH themes are regenerated —
  never hand-edit the HTML.

## World-coordinate map (current geometry)
Each figure has its own projection: `g1 = mk(P1)`, `g2 = mk(P2)` — helper bags
with `at/S/L/D/SEG/bev/label`. Shared part builders: `bench`, `railPosts`,
`capsuleSvg(accent)`, `ghostCapsule` (lathe, horizontal), `bellSvg( scale )`,
`gaugeSvg(zBase, dialH)` (returns `{svg, frames}` — 41 needle d-strings),
`colorLine` (accent line + end dots), `plinth`, `stDot`. Labels: `g.label(target,
lines[], [ox,oy], anchor, color)` — dotted leader + colored target dot + 15.5 px
monospace multi-line text; phone bumps to 23 px via page-level media query.
`TF_DEBUG=1 node build.mjs` dumps key viewBox coordinates.

Fig 1 (1024×600, az 38): bench is an L of two slabs `B1A`/`B1B`. Desk
`DK1 {x:-178,y:-4,w:64,d:56}` z 0..41 with knob, hopper (2 spares) and two
bridge mouths. Route switch: post at `PIVOT1 [-104,44,34.5]`, arm rotated
between precomputed `SWITCH_ANGLES.tunnel/funnel`, green/red lenses. Tunnel
lane: rail `{x:-95,y:-148,w:6,d:168}` z 26..31 (`lit`), green flow strip to the
machine-room porthole; posts at x=-92. Arch legs y≈-56, header
`{x:-118,y:-56,w:52,d:11}` z 50..62, ribbon `{x:-112,y:-47,w:44,d:3}` z 62..70
with hostname engraving (size 2.2), three record studs on the south face (proxied
one carries `--anatomy-dot:#f6821c`). Gate posts x -114/-80 at y≈-96, bar z
44..47.5 with green scanner strip, beacon `[-93,-96,51.4]`, `401` engraving on
the west post. Machine room `{x:-132,y:-206,w:76,d:56}` z 0..41: doorway recess
on the south face, intake porthole (vertical green `sideRing` + dome sphere
`DOME1 [-92,-147,30.6] r 6.2`), bell `ENG1 [-92,-180]` z 41, gauge z-base 41 at
(-60,-156). Capsule docks at `DOCK_Y=-137.3`. Funnel lane: dim rail
x -152..40 at y=64 (opacity .72), red dashes die at the mast, crack at x 40..48,
sagged stub x 52..110 (z 21.6..26.6) with red X on its end face; mast
`MAST1`/`PULLEY1 [26,64,47]` with red crack zigzag + snapped cord; dead tray
`TRAY1 {x:44,y:70,w:32,d:26}` red rims + ghost husk; drop target (50,74,8.6).
Painter order: bench → machineRoom → gate → archFar → archHeader → tunnelLane →
cap-tunnel → archNear → funnelLane → tray → cap-funnel → mast → rejectBin →
desk → semaphore → labels.

Fig 2 (1024×560, az 38): bench `B2 {x:-216,y:-56,w:436,d:118}`; rail z 22..27
(`lit`) with green flow strip; plinth stations at `STX=[-168,-84,0,84,168]`
(top z 18) each with a pulse dot `data-part="st-N"`: DNS rack (3 clouds, third
orange-dotted), edge mini-arch (lamp ribbon + record dots), cloudflared box with
governor wheel on its south face + chain + counterweight, gateway bar z 40..44
(green rim + scanner + beacon as its st-3 dot, `401` engraved on the near post,
reject bin + husk), Ollama bell (scale .8) + gauge (dialH 7.2, `needle2`); end
wall `{x:206}` with porthole ring + dome `[205.4,2,28] r 5.4`; capsule docks at
x 203.5. `ST2_T` thresholds pulse stations as the capsule crosses; `NOTES[]`
narrates each hop in the readout.

Live scripts: `live1` — phases parked|launch|run|grab|drop|rest, SPEED 92,
first auto-send runs the tunnel route then alternates, click/space toggles;
`live2` — parked|run|rest with station pulses, click re-runs. Both:
`IntersectionObserver` gates rAF, reduced motion = deterministic stills,
needle/beacon/lamp envelopes decay per tick.

## Truth list (do NOT break the story)
- Ports: gateway `:11435` → Ollama `:11434`.
- `401` at the token gate without a seal (reject tray).
- `ECONNRESET` / TLS reset at the DERP relay (funnel lane failure).
- One proxied (orange) DNS record among grey-clouded ones.
- `launchd` KeepAlive keeps the cloudflared connector running.
- Hostname `ollama.riazrahaman.com`.

## Hard rules
- NOTHING is committed, merged, pushed, or shipped. The figure ships only via
  the standing release flow (bump both package.json manifests → CHANGELOG →
  doc version strings → tests 727 server / 303 client → check-version-bump.sh
  → merge --no-ff → tag → GitHub Release) after explicit user confirmation.
- No WebSockets, no new npm dependencies, no `dangerouslySetInnerHTML`.
- Keep the interactive script working (route toggle via click/space, reduced
  motion stills, IntersectionObserver pause).
- Both themes must stay in sync.

## Coordination protocol
- The user is relaying between this OpenCode coordinator session and you
  (Antigravity); you were explicitly authorized by the user for this task.
- Before heavy surgery: `cp build.mjs build.mjs.prev-worker` so the result can
  be diffed/rolled back.
- When done (or at any natural checkpoint), report back THROUGH THE USER:
  what changed, which captures you made, and whether lines.mjs/capture checks
  are green. The coordinator will independently re-verify and then show the
  user for a verdict.
- Avoid concurrent edits with any other worker; one worker at a time.
