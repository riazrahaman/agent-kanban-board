# Agent Kanban Board — Presenter's Runbook

**Audience:** whoever is demoing this board live.
**System:** Agent Kanban Board v3.7.3
**Status:** living document — see [§11 Keeping this file alive](#11-keeping-this-file-alive). It is version-pinned by `server/test/kanban.version.test.js`, so a release that forgets it fails CI.

This is one ordered path from a clean machine to a live reclaim alert. It does not
restate the reference material; each step says where the full detail lives, so there
is exactly one source of truth per fact and this file stays short enough to follow
while talking.

---

## 1. The idea, in ninety seconds

Say this before you touch a terminal.

> A Kanban board whose users are not human. Agents claim cards over plain HTTP and
> move them through a state machine the **server** enforces. Humans watch live and
> do not arbitrate.

Four points carry the whole talk:

1. **Eight states, role-gated.** `BACKLOG → READY → PLANNING → IN_PROGRESS → IN_REVIEW → VALIDATION → READY_TO_SHIP → DONE`, plus `BLOCKED`. A builder cannot mark a card done; a tester cannot close one.
2. **Claim-first.** Only a `READY` card can be claimed. A claim sets an owner *and* a lease. A status-only `PATCH` leaves the card ownerless, and the reaper resets it.
3. **Two different 409s.** `Version mismatch` means you wrote against stale data; claim contention means someone else got there first. Collapsing them into one error is the mistake this design exists to avoid.
4. **Reclaim.** An expired lease, a card with no progress past `KANBAN_PROGRESS_STALL_MS` (30 min), or an ownerless active card past its grace window returns to `READY` on its own. Nobody pages a human.

Deeper, if asked: `docs/SYSTEM_DESIGN_AND_ARCHITECTURE.md` §3 (layers), §4 (state
machine + RBAC graph), §5.1 (claim-contention sequence). The §5.1 diagram is the best
single slide — two agents racing for one card, one receiving a 409.

---

## 2. Prerequisites

Node 20.x or 22.x LTS, npm 9+, git 2.30+, a modern browser. Full list:
`docs/USER_AND_OPERATOR_MANUAL.md` §2.1.

---

## 3. Install and run it locally

There is **no root `npm install`** — the server and client each carry their own manifest.

```bash
git clone https://github.com/riazrahaman/agent-kanban-board.git
cd agent-kanban-board
npm --prefix server install
npm --prefix client install
npm run build                     # tsc -b && vite build -> client/dist
```

Two ways to run it:

```bash
# A. One port. The API also serves the built SPA.
export KANBAN_AUTH_TOKEN="demo-secret"
npm start                         # http://localhost:4000

# B. Two terminals, live-reloading client.
export KANBAN_AUTH_TOKEN="demo-secret"
npm start                         # terminal 1 — API on :4000
npm --prefix client run dev       # terminal 2 — Vite on :5173, proxies /api
```

Use **A** on stage: one URL, one process, nothing to explain.

> Always launch with `npm start` or `node server/server.js` directly. A wrapper like
> `npm --prefix server start` intercepts `SIGTERM`, which makes every clean shutdown
> look like a crash. Reference: manual §4.1–4.2.

**Check it is up:** `curl -s localhost:4000/api/health` returns the running version.
Open `http://localhost:4000` and leave the board on screen for the rest of the demo —
every change below appears live over SSE, with no refresh.

---

## 4. Install it with the skill instead

This is the better story for an audience of agent builders: you do not install the
board, you tell an agent to.

```bash
# from the Skillport registry, without cloning the repo
npx @skillporthq/cli@latest add riazrahaman/agentkanban

# or straight from a checkout
cp -r skills/kanban .opencode/skills/kanban          # this project only
cp -r skills/kanban ~/.config/opencode/skills/kanban # every project on the machine
```

The Skillport one-liner is the install the About page leads with, so it is the one an
audience member will have seen if they opened the live site.

The directory name must match `name:` in the frontmatter (`kanban`).

What to say while it runs: the skill resolves `kanban_url`, `kanban_token` and
`project_name` from `.opencode/config.json` or `KANBAN_*` environment variables, and
**if no board URL is configured it deploys one** — clone, install both manifests,
build, start, then read the port back. It then calls `GET /api/health` and refuses to
proceed against a board older than v3.0.0. From that point the agent appends
`?project=<name>` to every task path, claims before entering a stage, and sends
`expected_version` on every `PATCH`.

Source: `skills/kanban/SKILL.md` §1. Install notes: manual §6.4.

> `.opencode/` holds tokens and is gitignored. Never stage it, never show it on screen.

---

## 5. Configure the local board

### 5.1 The minimum

```bash
export KANBAN_AUTH_TOKEN="demo-secret"
```

Without an auth mechanism, every mutation fails closed with **`503`**, by design.

### 5.2 The `503` trap

`KANBAN_PROJECT_TOKENS` must hold **valid JSON or nothing at all**. A non-JSON value
such as `change-me` makes every mutation fail closed with `503`, and the board looks
broken for a reason nothing on screen explains.

`.env.example` ships it empty with that warning beside it (it previously shipped
`change-me`, which is exactly how this was found). If you build a `.env` by hand, set
a real map (§5.3) or leave the line empty and rely on `KANBAN_AUTH_TOKEN`.

### 5.3 Per-project tokens

```bash
export KANBAN_PROJECT_TOKENS='{"demo":"tok-demo","payments":"tok-pay"}'
unset KANBAN_AUTH_TOKEN      # optional: prove isolation with no global escape hatch
npm start
```

Now `tok-demo` can only touch `?project=demo`. Under v3.3.0+ isolation this also
narrows what a token can *see*: `GET /api/projects`, `GET /api/tasks` and the
`/api/health` metadata all scope to the authorized project, and an anonymous caller
gets `[]`.

Demo it in two commands:

```bash
curl -s "localhost:4000/api/projects" -H "X-API-Token: tok-demo"
curl -s -X PATCH "localhost:4000/api/tasks/demo-01?project=payments" \
  -H "X-API-Token: tok-demo" -H "X-Agent-Role: builder" \
  -H "Content-Type: application/json" -d '{"status":"READY","expected_version":1}'
# -> 403 Forbidden: token is not authorized for project 'payments'
```

**Self-check:** `GET /api/health` carries a `credential_map` block. If a project has
cards but no token entry, `status` reads `undercovered` and names it in `missing` —
that is the board telling you a future `403` is already baked in. Detail: manual §3.1
and §7.3; client-side view: `ONBOARDING.md` §3.

---

## 6. Telegram reclaim alerts

Both variables are required; alerts stay off until both are set.

```bash
export KANBAN_TELEGRAM_BOT_TOKEN="<token from @BotFather>"
export KANBAN_TELEGRAM_CHAT_ID="-1001234567890"   # negative for a group
```

**To make one fire on stage**, claim a card with a short lease and then say nothing:

```bash
curl -X POST "localhost:4000/api/tasks/demo-01/claim?project=demo" \
  -H "X-API-Token: tok-demo" -H "X-Agent-Role: builder" \
  -H "Content-Type: application/json" \
  -d '{ "agent_id": "builder-1", "lease_ms": 60000 }'
```

`KANBAN_MIN_LEASE_MS` clamps the lease to 60s, so roughly a minute later the reaper
returns the card to `READY`, the board updates live, and Telegram receives the alert.
Line to deliver while it happens: *"nobody noticed that agent died — the board did."*

Variables and tuning: manual §3.1.1. Why it fires: `ONBOARDING.md` §"Getting alerted
when a task is reclaimed".

---

## 7. Ask the Board (the AI console)

A password-gated, read-only Q&A console on the **About** page. It is fail-closed:
`KANBAN_ASK_PASSWORD` is required by both providers.

```bash
# Hosted model
export KANBAN_ASK_PASSWORD="demo-pass"
export KANBAN_ASK_OPENROUTER_API_KEY="sk-or-..."

# Or a model on this machine
export KANBAN_ASK_PASSWORD="demo-pass"
export KANBAN_ASK_PROVIDER=ollama
export KANBAN_ASK_OLLAMA_HOST="http://localhost:11434"
```

Verify before you present:

```bash
curl -s localhost:4000/api/ask/config
# {"enabled":true,"gated":true,"provider":"ollama","model":"qwen3.6:latest"}
```

`provider` tells you which engine is live. `enabled:false` means a required secret is
missing — the console then collapses to a one-line note rather than failing on stage.

**Raise the rate caps before you demo.** Ask is capped per IP at
`KANBAN_ASK_PER_IP_PER_HOUR` (**default 3 per hour**) and globally at
`KANBAN_ASK_DAILY_CAP` (default 50 per UTC day). Three questions is one rehearsal plus
two on stage, and the fourth is refused. Set both higher for the demo:

```bash
export KANBAN_ASK_PER_IP_PER_HOUR=50
export KANBAN_ASK_DAILY_CAP=200
```

On the hosted board you cannot change them from here, so do not rehearse from the same
IP within the hour you present.

What to say: the model is not asked to "look things up". The server assembles the
context first — a hand-written protocol pack, source excerpts ranked by keyword hits
in file *contents* and windowed around the match, and a live board snapshot read
**in-process**, never over HTTP. And the answer path is never issued a board token, so
the model cannot move a card even if it tried.

Good demo questions: *"what are the two different 409s?"*, *"what does the reaper
actually do?"*, *"why can't a tester mark a card done?"*

Reaching a local Ollama from a hosted board needs a tunnel — Cloudflare in front of
`scripts/gateway/ollama-tunnel-gateway.js`, or a persistent Tailscale Funnel via
`scripts/setup-ollama-persistent-tunnel.sh`. Not needed for a laptop demo. Full
detail: manual §3.1.2; variables and troubleshooting: `README.md` §"Ask the Board".

---

## 8. The live demo — one card, start to finish

Run these in order against the local board, with the browser visible. Every call bumps
`version`, so each `expected_version` is the one the previous response returned.

```bash
T="X-API-Token: tok-demo"           # or Authorization: Bearer $KANBAN_AUTH_TOKEN
B="localhost:4000/api/tasks"

# 1. create  ("round" is REQUIRED)             -> 201 BACKLOG, version 1
curl -X POST $B -H "$T" -H "X-Agent-Role: runner" -H "Content-Type: application/json" \
  -d '{"id":"demo-01","project":"demo","title":"Add retry backoff","status":"BACKLOG","round":1,"priority":"high"}'

# 2. planner makes it claimable                -> 200 READY, version 2
curl -X PATCH "$B/demo-01?project=demo" -H "$T" -H "X-Agent-Role: planner" \
  -H "Content-Type: application/json" -d '{"status":"READY","expected_version":1}'

# 3. builder claims it   <- owner + lease set  -> 200 IN_PROGRESS, version 3
curl -X POST "$B/demo-01/claim?project=demo" -H "$T" -H "X-Agent-Role: builder" \
  -H "Content-Type: application/json" -d '{"agent_id":"builder-1"}'

# 4. a second builder tries the same card      -> 409 "already claimed by builder-1"
curl -X POST "$B/demo-01/claim?project=demo" -H "$T" -H "X-Agent-Role: builder" \
  -H "Content-Type: application/json" -d '{"agent_id":"builder-2"}'

# 5. progress log (also renews the lease)      -> 200, version 4
curl -X POST "$B/demo-01/logs?project=demo" -H "$T" -H "X-Agent-Role: builder" \
  -H "Content-Type: application/json" -d '{"agent_id":"builder-1","message":"Scaffolded; writing tests."}'

# 6. stale write                               -> 409 Version mismatch (expected 4)
curl -X PATCH "$B/demo-01?project=demo" -H "$T" -H "X-Agent-Role: builder" \
  -H "Content-Type: application/json" -d '{"status":"IN_REVIEW","expected_version":1}'

# 7. walk it out, role by role. Each call takes the version the previous one returned.
curl -X PATCH "$B/demo-01?project=demo" -H "$T" -H "X-Agent-Role: builder" \
  -H "Content-Type: application/json" -d '{"status":"IN_REVIEW","expected_version":4}'      # -> version 5
curl -X PATCH "$B/demo-01?project=demo" -H "$T" -H "X-Agent-Role: reviewer" \
  -H "Content-Type: application/json" -d '{"status":"VALIDATION","expected_version":5}'     # -> version 6
curl -X PATCH "$B/demo-01?project=demo" -H "$T" -H "X-Agent-Role: tester" \
  -H "Content-Type: application/json" -d '{"status":"READY_TO_SHIP","expected_version":6}'  # -> version 7

# 8. the wrong role tries to close it          -> 403 "Role 'tester' is not authorized"
curl -X PATCH "$B/demo-01?project=demo" -H "$T" -H "X-Agent-Role: tester" \
  -H "Content-Type: application/json" -d '{"status":"DONE","expected_version":7}'

# 9. the releaser closes it                    -> 200 DONE
curl -X PATCH "$B/demo-01?project=demo" -H "$T" -H "X-Agent-Role: releaser" \
  -H "Content-Type: application/json" -d '{"status":"DONE","expected_version":7}'
```

**Why the 403 comes last and not from `IN_PROGRESS`.** `patchTask` checks the edge
before it checks the role (`store.js`: `canTransition`, then `canRoleTransition`).
`IN_PROGRESS → DONE` is not a legal edge at all, so asking a tester to close a card
mid-flight returns `409 Invalid state transition` and the role gate never runs — the
wrong failure for the point you are making. At `READY_TO_SHIP` the edge *is* legal and
only the role is wrong, which is the clean 403 above. Verified against a local board.

Steps 4, 6 and 8 are the demo. Everything else is scaffolding to reach them. Full
sequence with expected version numbers: manual §6.2. Python client: §6.3.

---

## 9. If something breaks on stage

| Symptom | Cause | Fix |
|---|---|---|
| Every mutation `503` | No auth configured, **or** `KANBAN_PROJECT_TOKENS` is not valid JSON (see §5.2) | Set a valid token or a valid JSON map, restart |
| `409` on a `PATCH` | Stale `expected_version` | `GET` the card, resend with the current version |
| `409` on a claim | Another agent holds it, or the card is not `READY` | Expected — this is the point |
| `403` on a transition | Role not permitted for that edge | Check the role matrix, §1 |
| Card snapped back to `READY` | Reaper: lease expired, stalled, or ownerless | Expected — this is also the point |
| Ask console missing | `GET /api/ask/config` says `enabled:false` | A required secret is unset (§7) |
| Ask refuses a question | Rate cap: 3 per IP per hour, 50 per day by default | Raise `KANBAN_ASK_PER_IP_PER_HOUR` (§7); on the hosted board, wait |
| `400 round must be a positive integer` | `POST /tasks` without `round` | Add `"round": 1` — it is required on create |
| `409 Invalid state transition` where you expected `403` | The edge is illegal, so the role gate never ran | Reach a state where the edge is legal first (§8) |
| Board empty in the browser | Wrong `?project=`, or a token that cannot see it | Check `GET /api/projects` with that token |

Decision tree and error catalogue: manual §7.

---

## 10. Where to go deeper

| Topic | File |
|---|---|
| Operator reference, every variable, UI guide | `docs/USER_AND_OPERATOR_MANUAL.md` |
| Same, with diagrams rendered inline | `docs/with-images/USER_AND_OPERATOR_MANUAL.md` |
| Architecture, state machine, concurrency | `docs/SYSTEM_DESIGN_AND_ARCHITECTURE.md` |
| Connecting a new project (client side) | `ONBOARDING.md` |
| Every env var, generated and drift-tested | `docs/CONFIGURATION.md` |
| The orchestrator protocol itself | `skills/kanban/SKILL.md` |
| Feature-level detail and API reference | `README.md` |
| Per-file technical reference | `docs/FILE_BY_FILE_EXPLANATION.md` |
| Design decisions | `docs/decisions/ADR-001…004` |
| Restore runbook | `docs/RESTORE.md` |
| This runbook as a shareable web page | `docs/presentation/index.html` |
| The same material as a 15-slide deck | `docs/presentation/deck/` |

---

## 11. Keeping this file alive

This runbook goes stale faster than any other document here, because it contains
commands people type verbatim in front of an audience.

**The enforcement:** the `**System:** Agent Kanban Board vX.Y.Z` line above is checked
by `server/test/kanban.version.test.js` against `server/package.json`. Cut a release
without updating it and CI fails. That guarantees the version is current; the rest is
on whoever makes the change.

`docs/presentation/index.html` is this same walkthrough as a single shareable page, published
as an Artifact. `docs/presentation/deck/` is the same material as a 15-slide deck (`deck.json`
plus one HTML file per slide, each carrying its presenter notes in an `<aside>`). All three
carry a version that `kanban.version.test.js` checks — the page's version line, and the deck's
in the cover footer — so they move together: change one and change the others in the same commit.

**Update this file in the same commit when any of these change:**

| Change | Section to revisit |
|---|---|
| A lifecycle state, a transition, or the role matrix (`server/state-machine.js`) | §1, §8 |
| An install or build command, or how the server is launched | §3 |
| The skill's name, install path, or bootstrap behaviour (`skills/kanban/SKILL.md`) | §4 |
| Any `KANBAN_*` variable used below — added, renamed, or its default changed | §5, §6, §7 |
| `.env.example` (especially placeholder values that are not valid JSON) | §5.2 |
| An endpoint path, required header, or response shape used in a `curl` block | §5.3, §6, §7, §8 |
| A new or changed error code / status | §9 |
| A doc added to, removed from, or renamed in `docs/` | §10 |

**Before presenting, always:** run §3 on a clean clone, then §8 end to end, against the
version you will demo. A command that worked last month is not evidence. If a step has
drifted, fix this file first, then present.
