# Agents Kanban — `kanban-orchestrator`

Turns your coding agent into a **strict orchestrator** for an [agent-kanban-board](https://github.com/riazrahaman/agent-kanban-board). The orchestrator never writes code. It owns the card, dispatches **builder → reviewer → tester** workers, and moves the card only when it has evidence: command output, test results, or a commit hash.

- **Skill source:** [github.com/riazrahaman/kanban-orchestrator](https://github.com/riazrahaman/kanban-orchestrator)
- **Board:** [github.com/riazrahaman/agent-kanban-board](https://github.com/riazrahaman/agent-kanban-board) · live at [agent-kanban.riazrahaman.com](https://agent-kanban.riazrahaman.com)
- **License:** MIT

---

## When to use it

- You hand a feature or fix to sub-agents and want **one auditable record** of who holds it, what stage it's in, and why it moved.
- You run **several agents on one repo** and need claims and leases so two agents never build the same card.
- You want **crash recovery**: if an agent dies mid-build, the card goes back to `BACKLOG` on its own instead of showing "in progress" forever.

**Not a fit:** quick one-off edits, where a board adds process and no benefit.

---

## The model in 30 seconds

```
BACKLOG ──claim──▶ BUILDING ──▶ IN_REVIEW ──▶ IN_TEST ──▶ DONE
   ▲                  ▲              │             │
   │                  └── findings ──┘             │
   └────────── test fail · lease expired ──────────┘
```

- **The board is the state machine.** The server checks every move. An illegal move returns `409`, and a wrong role returns `403`.
- **Claim to own, PATCH to move.** To enter an active stage, the agent calls `POST /tasks/:id/claim`, which sets an owner and a lease. A PATCH that only changes status leaves the card with no owner, and the reaper sends it back to `BACKLOG`.
- **Leases beat crashes.** The holder sends heartbeats to keep the card. If the holder goes silent, the card is released for another agent.
- **Every write is versioned.** Each `PATCH` carries `expected_version`, so a stale write gets a `409` and can't overwrite a newer one.

---

## Install

### From SkillPort (verified package)

```bash
# one-time: sign in on SkillPort, create a free API key, then
npx @skillporthq/cli@latest login

# from your project root
npx @skillporthq/cli@latest add riazrahaman/agentkanban
```

- The skill lands in `.claude/skills/riazrahaman__agentkanban/`, the default Claude Code target.
- `--target generic` installs to `./skills/riazrahaman__agentkanban/` instead.
- Before extracting, the CLI checks the package's sha256 against the published hash. It records the exact version in `skillport.lock`.
- In CI, set `SKILLPORT_API_KEY` instead of running `login`.

### For opencode

opencode requires the skill's folder name to match the `name:` in its frontmatter, which is `kanban-orchestrator`. After the SkillPort install, copy it into place:

```bash
mkdir -p .opencode/skill
cp -r .claude/skills/riazrahaman__agentkanban .opencode/skill/kanban-orchestrator

# or globally
cp -r .claude/skills/riazrahaman__agentkanban ~/.config/opencode/skill/kanban-orchestrator
```

---

## Configure

The skill needs three values. It reads `.opencode/config.json` first, then falls back to environment variables.

```
config key     env var              what it is
─────────────  ───────────────────  ────────────────────────────────────────────
kanban_url     KANBAN_URL           API base, including /api
                                    e.g. http://localhost:4000/api
kanban_token   KANBAN_TOKEN         token the board accepts for writes
project_name   KANBAN_PROJECT       board project (a project is created by its first card)
admin_token    KANBAN_ADMIN_TOKEN   optional: the board's cross-project admin token
```

```json
{
  "kanban_url": "http://localhost:4000/api",
  "kanban_token": "<your token>",
  "project_name": "my-app"
}
```

> **Include `/api` in `kanban_url`.** The skill writes paths as `/tasks` and `/projects`, but every board route lives under `/api`. Without it, `GET /projects` returns the board's HTML page with a `200`. The call looks successful but returns no data.

> **`.opencode/` holds tokens.** Add it to `.gitignore` before you write the file. The skill never stages it.

If you're not on opencode, set the env vars and skip the file.

---

## No board yet? Start one locally

If no `kanban_url` is found, the skill clones and starts a board itself. To do it by hand:

```bash
git clone https://github.com/riazrahaman/agent-kanban-board.git
cd agent-kanban-board
npm --prefix server install
npm --prefix client install
npm run build

# the board refuses writes (503) until it has a token
export KANBAN_AUTH_TOKEN="$(openssl rand -hex 24)"
npm start
```

- The API is at `http://localhost:4000/api`, and the live board UI is at `http://localhost:4000`. The UI updates over Server-Sent Events with no refresh.
- Use the same value for the skill: `export KANBAN_TOKEN="$KANBAN_AUTH_TOKEN"`.
- The server doesn't load `.env` files, so export the variables in the shell that runs `npm start`.

---

## Smoke test before you delegate

`GET /projects` is open to anyone by default, so it proves the URL works but not the token. The real check is a write:

```bash
curl -s -X POST "$KANBAN_URL/tasks" \
  -H "x-api-token: $KANBAN_TOKEN" \
  -H "x-agent-id: orchestrator" \
  -H "x-agent-role: admin" \
  -H "content-type: application/json" \
  -d "{\"id\":\"smoke-1\",\"project\":\"$KANBAN_PROJECT\",\"title\":\"smoke test\",\"status\":\"BACKLOG\",\"round\":1}"
```

A `201` with the card JSON means the URL, token and project are all correct. Any other response is covered under **Troubleshooting** below.

---

## What the agent does, stage by stage

**A · Setup**
1. Find or open a GitHub issue `#N`.
2. Branch `feat/<slug>` or `fix/<slug>` from `main`.
3. Register the card with `POST /tasks`. Pass `id`, `title`, `"status": "BACKLOG"`, `"round": 1`, `project`, the exact branch name from `git rev-parse --abbrev-ref HEAD`, and `"issues": ["#N"]`.
4. Record the card's `id` and `version`.

**B · Build → Review → Test**
1. **Build:** claim the card as `builder`, which moves it `BACKLOG → BUILDING`. Log, start heartbeats, and dispatch the builder. The builder never claims.
2. **Review:** PATCH to `IN_REVIEW` as `admin` with `expected_version`. Don't claim again. If the reviewer reports findings, the agent logs them, moves the card back to `BUILDING`, and dispatches the builder again.
3. **Test:** PATCH to `IN_TEST`. If a test fails, the agent resets the card to `BACKLOG` and starts again at Build.

**C · Close** (only after tests pass)
1. Update docs and bump the version in lockstep.
2. `git merge --no-ff` into `main`, then tag `v<version>` and push.
3. PATCH the card to `DONE` and close the issue.
4. Check the deployment and report the commit hash and test output.

**Hard stop:** if Build → Review → Test runs 3 times without a pass, the agent stops and reports what's blocking it.

---

## What this skill will do on your machine

SkillPort vets skills for hidden or dangerous behavior. This section lists what this one actually does, so you can decide before installing:

- **Board API:** HTTP calls go only to your `kanban_url`.
- **Git:** creates `feat/*` and `fix/*` branches. At close it **merges into `main`, creates an annotated tag, and pushes `main` and tags to `origin`**. If `main` is protected, or you want to merge yourself, tell your agent to stop after tagging.
- **GitHub CLI:** runs `gh issue create` and `gh issue close` on the current repo.
- **Local board** (only if no `kanban_url`): clones agent-kanban-board, runs `npm install` for the server and client, builds, and starts a server on port 4000.
- **Deploy check:** runs `railway status` and `GET /api/health`. Change or skip this step if you don't deploy on Railway.
- **Files:** reads `.opencode/config.json` and never commits it.
- **Code:** the orchestrator writes no application code itself. The workers it dispatches do.

---

## API cheat-sheet

Every path that targets a single task needs `?project=`. Only `POST /tasks` takes the project in the JSON body instead.

```
POST   /tasks                            create · project in body
                                         requires id, title, status BACKLOG, round 1
POST   /tasks/:id/claim?project=X        take ownership + lease (BACKLOG → BUILDING)
POST   /tasks/:id/heartbeat?project=X    renew the lease
POST   /tasks/:id/logs?project=X         append a log (holder logs also renew the lease)
PATCH  /tasks/:id?project=X              move / update · always send expected_version
GET    /tasks/:id?project=X              read one card
GET    /tasks?project=X                  list cards in a project
GET    /projects                         list projects (no scoping needed)
```

Every request carries `x-agent-id`, `x-agent-role` and `x-api-token`.

**Leases**
- The default lease is `KANBAN_CLAIM_TTL_MS` = 600000 ms (10 min). Send a heartbeat at least every 2 minutes.
- To ask for a different lease on a claim, send `{"lease_ms": n}`. The server clamps it between 60000 ms and 7200000 ms.
- **Optional alerts:** set `KANBAN_TELEGRAM_BOT_TOKEN` and `KANBAN_TELEGRAM_CHAT_ID` on the board server, and it messages you on Telegram whenever the reaper resets a card.

---

## Troubleshooting

**`403 Forbidden: token is not authorized for project 'default'`**
The request has no `?project=`, so the server used the default project. Add `?project=<name>` to every path that targets a task.

**`404` on `GET /tasks/:id`**
Same cause: the path has no `?project=`.

**`GET /projects` returns HTML**
`kanban_url` is missing `/api`.

**`400 id and title are required` on create**
The board doesn't generate ids, so the caller must supply one. Use a stable slug, such as `"id": "feat-login-rate-limit"`.

**`400 Invalid status: undefined` or `400 round must be a positive integer`**
Create the card with `"status": "BACKLOG"` and `"round": 1`. Both fields are required.

**`400 Invalid task id`**
Ids may only contain letters, digits, `_` and `-`. A `/` copied from the branch name is the usual cause, so use `feat-login-rate-limit`, not `feat/login-rate-limit`.

**`409 Task <project>/<id> already exists`**
A card with that id already exists in the project. Resume it if it's the same work, otherwise pick a new id.

**`503 Mutating API is unavailable until an auth token is configured`**
The board server was started without a token. Restart it with `KANBAN_AUTH_TOKEN` exported.

**`401 Unauthorized: valid token required for mutating operations`**
`KANBAN_TOKEN` doesn't match the server's token. `GET /projects` still works in this case, because reads are open by default.

**`409 Invalid state transition from BACKLOG to <X>`**
The lease expired and the reaper reset the card. Run `git status` and `git log` on the branch first, because uncommitted work may still be on disk. Then claim the card again and repeat the stages.

**`409 Version mismatch`**
Something wrote to the card first. `GET` the card and retry with the current `version`.

**Card goes back to `BACKLOG` about 5 minutes after a PATCH**
The card entered an active stage through a PATCH that only changed its status, so it had no owner. The reaper resets cards with no owner after `KANBAN_ORPHAN_GRACE_MS`, which defaults to 5 min. Use `POST /claim` to enter an active stage.

---

## Compatibility

- **Versions:** from 2.14.3 on, the skill's version matches this SkillPort listing. 2.14.5 adds the required create fields (`id`, `status`, `round`), the `/api` base URL and a separate token check to the protocol.
- **Board:** tested against agent-kanban-board v2.14.0 through v2.15.3+.
- **Agents:** written for opencode. The protocol is plain HTTP and the config can come from env vars, so it also works with Claude Code, which is SkillPort's default install target. From 2.14.5 the frontmatter also passes claude.ai's skill upload check.
- **Changelog:** [CHANGELOG.md](https://github.com/riazrahaman/kanban-orchestrator/blob/main/CHANGELOG.md)
