# Fig — "The tunnel fix" (anatomy explainer page)

**Concept.** A self-contained page (dark + light builds) explaining the move from
the Tailscale funnel route to the Cloudflare tunnel route, in three beats: prose
header (what broke / what fixed it), **Fig 1 "Two routes, one request"**, a "What
actually changed" note, then **Fig 2 "The fixed path"**. Geometry over words; both
figures are live machines with request capsules.

**Fig 1 — the fork (live A/B routing).** The Railway desk sits at the apex of an
L-shaped bench; a route-switch semaphore picks one of two perpendicular lanes:

- *Tunnel lane* (world −y, screen right-up; green, `lit` rail): green flow strip →
  Cloudflare edge arch (hostname ribbon engraved `ollama.riazrahaman.com`, three
  record studs on the header's south face: two grey-clouded, one proxied = the
  orange dot `#f6821c`) → token gate portal (scanner strip, beacon, `401` engraved
  on the west post, reject bin with a tokenless husk beside) → machine room:
  doorway recess, glowing intake porthole (green rim + dome), Ollama engine bell
  with lamp, load gauge with live needle. Capsule docks → beacon flash, engine
  lamp pulse, needle kicks: `HTTP 200 · edge → gateway :11435 → ollama :11434`.
- *Funnel lane* (world +x, screen right-down; red): red dashes die mid-lane, the
  rail cracks and a sagged stub ends in a red X ("road closed" face); the DERP
  relay mast's arm hangs over the lane with a cracked pulley and snapped red cord;
  the capsule is grabbed, wobbles, and drops into the dead tray (red rims, ghost
  husk): `ECONNRESET · the relay reset the TLS handshake`.

Capsules carry a lane-colored ground halo (green/red). Idle tour runs the tunnel
route first, then alternates; click/space switches the route; reduced motion =
deterministic stills per route.

**Fig 2 — the chain (live traverse).** Five plinth stations along one green rail,
left to right: DNS records (rack, 3 clouds, third orange/proxied) → Cloudflare
edge mini-arch → cloudflared box with the launchd governor (wheel, chain,
counterweight = RunAtLoad + KeepAlive) → token gateway :11435 (beacon, `401`
engraved on the near post, reject bin) → Ollama :11434 (bell, gauge, needle). The
capsule tours them; each station pulses as it passes and the readout narrates
(`dns · …`, `edge · …`, `cloudflared · …`, `gateway :11435 · seal accepted — 401
without it`), docking at the end-wall socket: `HTTP 200 …`. Click re-runs.

**Truth list (do not break).** `ollama.riazrahaman.com` is the one proxied
(orange-cloud) record; the rest stay grey-clouded (DNS only). Gateway listens on
:11435 and demands a token → 401 without a seal; proxies to Ollama on :11434.
The funnel route failed with 502/ECONNRESET: the DERP relay reset the TLS
handshake. cloudflared runs under launchd with RunAtLoad + KeepAlive.

**Build/verify.** `node build.mjs` → tunnel-fix.html (dark), `--light` →
tunnel-fix-light.html. Checks: `lines.mjs` must print 0 line-end floats on both;
`capture.mjs` must print `console: clean` (desktop, `--reduced` stills, and
`--width 390` phone). `TF_DEBUG=1 node build.mjs` dumps key viewBox coordinates
for label placement. Phone label sizing: page-level media query bumps
`.iso-label text` to ~23px under 560px; keep label lines ≤ ~20 chars.
