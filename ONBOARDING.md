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
2. **A token** — issued by the board owner. Ideally scoped per-project via
   `KANBAN_PROJECT_TOKENS` so your app cannot touch another project's board.
3. **A role** — one of `builder`, `reviewer`, `tester`, `runner`, `system`, `human`, `admin`,
   sent on every mutating request. It must match your agent's phase in the loop.

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

Reads (`GET`, including the SSE stream) are **open**. Every mutation
(`POST`/`PATCH`/`PUT`/`DELETE`) needs a token **and** a role.

### Token sources (set by the board owner as server env vars)

| Env var | Scope |
|---|---|
| `KANBAN_AUTH_TOKEN` | one global token, valid for every project |
| `KANBAN_ADMIN_TOKEN` | superuser token, spans all projects (audited as `admin_write`) |
| `KANBAN_PROJECT_TOKENS` | JSON map `{"myapp":"tok-123", ...}` — **per-project isolation** |
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
X-Agent-Role: <role>
```

(The role may alternatively be a `role` field in the JSON body. Both are lowercased and
validated against the `VALID_ROLES` set.)

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
TOKEN="tok-123"            # owner-issued, scoped to "myapp" via KANBAN_PROJECT_TOKENS

# 1. Create the first task — this materializes project "myapp".
curl -X POST "$BASE/api/tasks" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Agent-Id: myapp-builder" -H "X-Agent-Role: builder" \
  -H "Content-Type: application/json" \
  -d '{"id":"setup","title":"Provision board","round":1,"status":"BACKLOG","project":"myapp"}'

# 2. Claim the next available task in the project (role comes from the header, not the URL).
curl -X POST "$BASE/api/tasks/next-claim?agent_id=myapp-builder&project=myapp" \
  -H "Authorization: Bearer $TOKEN" -H "X-Agent-Role: builder"

# 3. Move a task (role-gated state machine; ?role= in the URL is ignored).
curl -X PATCH "$BASE/api/tasks/setup" \
  -H "Authorization: Bearer $TOKEN" -H "X-Agent-Role: builder" \
  -H "Content-Type: application/json" \
  -d '{"status":"BUILDING"}'

# 4. Append a log line.
curl -X POST "$BASE/api/tasks/setup/logs" \
  -H "Authorization: Bearer $TOKEN" -H "X-Agent-Role: builder" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"myapp-builder","message":"Started implementation."}'

# 5. Read (open — no token needed).
curl "$BASE/api/tasks?project=myapp"
curl "$BASE/api/metrics?project=myapp"
curl "$BASE/api/health"
```

---

## 5. The state machine you are driving

A task follows `BACKLOG → BUILDING → IN_REVIEW → IN_TEST → DONE` (plus `BLOCKED`, settable
from any active state). Transitions are role-gated:

- `builder` → `BUILDING`, `IN_REVIEW`
- `reviewer` → `IN_TEST`, `BUILDING`
- `tester` → `DONE`, `BUILDING`

Illegal transitions return `409`; a role that cannot make a transition returns `403`; a bad or
missing token returns `401`; an unconfigured server returns `503` (fail-closed). Claims are
lease-based and auto-reclaimed by the background reaper if not renewed before the TTL expires.

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

When an agent stops heartbeating, its lease expires and the reaper returns the task to `BACKLOG`.
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
