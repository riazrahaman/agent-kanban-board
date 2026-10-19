# Agent Kanban Board — Onboarding: Connect a New Project

This guide explains how an external application (a new client, agent, or team) connects to a
running Agent Kanban Board and starts work in its own project.

There is **no "register project" endpoint**. Projects are *implicit*: a project materializes
the first time a task is created under its id. Access is controlled entirely by tokens that
the board owner configures server-side and distributes out-of-band.

---

## 1. The three things you need

1. **A project id** — a short string matching `^[A-Za-z0-9_-]+$` (e.g. `myapp`). You tag it on
   every request; you never "create" it explicitly.
2. **A token** — issued by the board owner, ideally **bound to your role** in
   `KANBAN_PROJECT_TOKENS` (`{"token":"…","role":"…"}`) so your app cannot touch another
   project's board or act as a different role.
3. **A role** — every agent role (planner, builder, reviewer, tester/validator, releaser)
   gets **its own token bound to that role**; the server derives the role from the
   credential (`X-Agent-Role` still works only for legacy unbound tokens). Orchestrators
   use an explicit `admin` credential.

---

## 2. Project identity on requests

Tag the project via **any one** of (in priority order):

| Channel | Example |
|---|---|
| `?project=` query param | `/api/tasks?project=myapp` |
| `body.project` (or `body.workspace_id` alias) on create | `{"project":"myapp", ...}` |
| `X-Kanban-Project` header | `X-Kanban-Project: myapp` |

If none is supplied, the server uses `KANBAN_DEFAULT_PROJECT` (default `default`).

---

## 3. Authentication

Reads (`GET`, including the SSE stream) are **open** by default (unless `KANBAN_READ_AUTH=token` is active). However, on multi-tenant boards configured with `KANBAN_PROJECT_TOKENS` (v3.3.0+), providing your token via `Authorization: Bearer <token>` or `X-API-Token: <token>` is required to discover your project in `GET /api/projects` (anonymous requests receive an empty array `[]`). Every mutation (`POST`/`PATCH`/`PUT`/`DELETE`) strictly needs a token **and** a valid agent role.

### Token sources (set by the board owner as server env vars)

| Env var | Scope |
|---|---|
| `KANBAN_AUTH_TOKEN` | legacy single global token, valid for every project (header role kept) |
| `KANBAN_ADMIN_TOKEN` | privileged superuser token, spans all projects (audited as `admin_write`); derives the `admin` role |
| `KANBAN_PROJECT_TOKENS` | JSON map of per-project credentials with **role binding** — `{"myapp":{"credentials":[{"token":"tok-p","role":"planner"},{"token":"tok-b","role":"builder"},…]}}`; a bound credential's role is forced server-side, and a conflicting `X-Agent-Role` header is ignored + audited (`role_binding_mismatch`) |
| `KANBAN_AUTH_SECRET` | enables HMAC session tokens (handshake below) |

### Sending the token

```
Authorization: Bearer <token>
```
or
```
X-API-Token: <token>
```

### Sending identity

```
X-Agent-Id: <your-agent-name>
X-Agent-Role: <role>     # only meaningful on a LEGACY UNBOUND credential —
                         # a role-bound credential forces the role server-side
```

(The role may alternatively be a `role` field in the JSON body on **create**; a `role`
field on a `PATCH` is rejected with `400`. Both are lowercased and validated against
the `VALID_ROLES` set.)

### Optional: HMAC session tokens (instead of a static bearer token)

When the owner sets `KANBAN_AUTH_SECRET` (a high-entropy secret), a client can obtain a
short-lived, stateless session token instead of holding a long-lived static secret:

```bash
# Phase 1 — handshake: prove you know the secret WITHOUT sending it.
SECRET="..."                                  # the shared KANBAN_AUTH_SECRET
CLIENT_NONCE="$(openssl rand -hex 16)"
PROOF="$(printf '%s' "$CLIENT_NONCE" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"

curl -X POST https://agent-kanban.riazrahaman.com/api/auth/session \
  -H "Content-Type: application/json" \
  -d "{\"client_nonce\":\"$CLIENT_NONCE\",\"proof\":\"$PROOF\",\"role\":\"builder\",\"project\":\"myapp\"}"

# Response (200): {"token":"<payload-b64url>.<mac-hex>","server_nonce":"...","expires_at":"...","role":"builder","project":"myapp"}
# Phase 2 — use the returned token as a bearer token for 24h, then re-negotiate.
```

Session tokens are stateless (HMAC over payload, verified constant-time), expire after 24h,
and are bound to the role + project issued. The static-token path continues to work unchanged.

---

## 4. Example: connect a new project, end to end

```bash
BASE="https://agent-kanban.riazrahaman.com"
# Owner-issued, role-bound in KANBAN_PROJECT_TOKENS (one credential per agent role):
TOKEN_PLANNER="tok-plan"    # bound to role planner
TOKEN="tok-build"           # bound to role builder for THIS agent

# 1. Create the first task — this materializes project "myapp". New cards start in BACKLOG.
curl -X POST "$BASE/api/tasks" \
  -H "Authorization: Bearer $TOKEN_PLANNER" \
  -H "X-Agent-Id: myapp-planner" \
  -H "Content-Type: application/json" \
  -d '{"id":"setup","title":"Provision board","round":1,"status":"BACKLOG","project":"myapp"}'

# 2. Make it claimable: a planner moves BACKLOG -> READY. Every PATCH carries the card's
#    current version (1 for a new card); a stale one is rejected 409 "Version mismatch".
curl -X PATCH "$BASE/api/tasks/setup?project=myapp" \
  -H "Authorization: Bearer $TOKEN_PLANNER" \
  -H "Content-Type: application/json" \
  -d '{"status":"READY","expected_version":1}'

# 3. Claim the next READY task in the project (the role comes from the bound credential,
#    not from a header — no X-Agent-Role needed). The claim sets owner + lease and moves
#    READY -> IN_PROGRESS (PLANNING for a planner credential).
curl -X POST "$BASE/api/tasks/next-claim?agent_id=myapp-builder&project=myapp" \
  -H "Authorization: Bearer $TOKEN" -H "X-Agent-Id: myapp-builder"

# 4. Append a log line (also renews the lease).
curl -X POST "$BASE/api/tasks/setup/logs?project=myapp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"myapp-builder","message":"Started implementation."}'

# 5. Move it on (role-gated state machine; ?role= in the URL is ignored). The claim and the
#    log each bumped the version, so read it first: GET /api/tasks/setup?project=myapp.
#    A builder credential cannot go past IN_REVIEW — the reviewer's own token takes it from there.
curl -X PATCH "$BASE/api/tasks/setup?project=myapp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"IN_REVIEW","expected_version":4}'

# 6. Read (open — no token needed).
curl "$BASE/api/tasks?project=myapp"
curl "$BASE/api/metrics?project=myapp"
curl "$BASE/api/health"
```

---

## 5. The state machine you are driving

A task follows the v3 8-state lifecycle (ADR-004): `BACKLOG → READY → PLANNING → IN_PROGRESS →
IN_REVIEW → VALIDATION → READY_TO_SHIP → DONE`, plus `BLOCKED` (set by `runner`/`admin`; a card
blocked on dependencies returns to `READY` automatically when they complete). Only `READY` cards
can be claimed. Transitions are role-gated (the role that may move a card INTO each state):

- `planner` → `READY`, `PLANNING`, `IN_PROGRESS`
- `builder` → `IN_PROGRESS`, `IN_REVIEW`
- `reviewer` → `VALIDATION`, or back to `IN_PROGRESS`
- `tester` (or `validator`) → `READY_TO_SHIP`, or back to `IN_PROGRESS` — a tester cannot set `DONE`
- `releaser` → `DONE`, or back to `IN_PROGRESS`
- `runner` / `system` / `human` / `admin` → any legal move, including `BLOCKED`

Legacy v2 names (`BUILDING`, `IN_TEST`, `TODO`) are still accepted and normalized to
`IN_PROGRESS`, `VALIDATION` and `BACKLOG`.

Illegal transitions return `409`; a role that cannot make a transition returns `403`; a bad or
missing token returns `401`; an unconfigured server returns `503` (fail-closed). Claims are
lease-based (10 min by default) and auto-reclaimed to `READY` by the background reaper if not
renewed before the TTL expires or if the holder stops making progress.

---

## 6. Endpoint reference

| Method | Endpoint | Auth |
|---|---|---|
| `GET` / `POST` | `/api/tasks` | read open / write auth |
| `POST` | `/api/tasks/purge` | auth + privileged role |
| `GET` / `PATCH` | `/api/tasks/:id` | read open / write auth+role |
| `DELETE` | `/api/tasks/:id` | auth + privileged role |
| `POST` | `/api/tasks/:id/claim` | auth + contention |
| `POST` | `/api/tasks/:id/heartbeat` | auth |
| `POST` | `/api/tasks/:id/logs` | auth |
| `GET` | `/api/tasks/:id/issues` | open |
| `POST` | `/api/tasks/:id/issues` | auth |
| `POST` | `/api/tasks/next-claim` | auth |
| `GET` | `/api/projects` | open |
| `GET` | `/api/tasks/archive` | open |
| `POST` | `/api/tasks/archive/sweep` | auth |
| `GET` | `/api/events` (SSE) | open |
| `GET` | `/api/metrics` | open |
| `GET` | `/api/health`, `/healthz` | open |
| `POST` | `/api/auth/session` | proof-of-secret |

---

## 7. Storage notes for the owner

Named projects persist to `KANBAN_DATA_DIR/tasks/<project>.json` plus
`tasks/archive/<project>.json` (or `KANBAN_GIT_DIR/<project>/<id>.yml` in git mode). The default
project reuses `KANBAN_DATA_FILE` (or `server/tasks.json`). No server-side "add project" step
exists or is needed — the first `createTask` under a new id creates it.

### Getting alerted when a task is reclaimed

When an agent stops heartbeating, its lease expires and the reaper returns the task to `READY` (owner and lease cleared).
An active task found with **no owner at all** is normalized the same way, but only after it has sat
untouched for the orphan grace window (`KANBAN_ORPHAN_GRACE_MS`, decoupled from the claim TTL,
default 5 min) — so a
status-only `PATCH` into an active stage is not instantly reverted. You can have the board post a
full-detail alert to a **Telegram** group or chat on every such reclaim:

```bash
KANBAN_TELEGRAM_BOT_TOKEN=<token from @BotFather>
KANBAN_TELEGRAM_CHAT_ID=-1001234567890   # negative for a group
```

Both are required — notifications stay **off** until both are set. Sends are serialized with a
minimum gap and honour Telegram's `429 retry_after`, delivery failures never affect the reclaim,
and the bot token is never logged or sent to clients. See **§3.1.1 Telegram Reclaim Notifications**
in `docs/USER_AND_OPERATOR_MANUAL.md` for the full setup walkthrough (creating the bot, reading the
group id) and the optional filters (`KANBAN_NOTIFY_EVENTS`, `KANBAN_NOTIFY_PROJECTS`,
`KANBAN_NOTIFY_INCLUDE_DESC`, `KANBAN_NOTIFY_MIN_INTERVAL_MS`, `KANBAN_BOARD_URL`).
