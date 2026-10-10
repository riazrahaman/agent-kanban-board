# kanban-orchestrator

**Agents Kanban** — a strict, Kanban-first orchestrator skill for coding agents.

Version `v3.2.0` · MIT · Verified on [SkillPort](https://skills.syed-hasan.com/skills/riazrahaman/agentkanban)

The skill turns your coding agent into the **admin of a delegated build**. It stops writing code itself. Instead it owns the board, holds the lease on each card, dispatches builder / reviewer / tester workers, and only moves a card forward when there is evidence: command output, test results, commit hashes.

The board is [agent-kanban-board](https://github.com/riazrahaman/agent-kanban-board), a local-first Kanban server for agent swarms. It is the single source of truth: stage transitions are role-gated and validated server-side, so an agent cannot declare progress it hasn't earned.

The full protocol lives in [`SKILL.md`](SKILL.md). This README is the human-facing overview.

## How it works (AgentOS 8-State Workflow)

```
                 [GitHub issue #N] ── linked ──┐
                                               ↓
[Orchestrator / admin] ── POST /tasks ──→ [BACKLOG card]
        │                                      │
        │  PATCH {status: "READY"}             ↓
        ├────────────────────────────────→ [READY]
        │                                      │
        │  POST /claim (owner + lease)         ↓
        ├────────────────────────────────→ [IN_PROGRESS] ←───────┐
        │    dispatch BUILDER                  │                 │ blocking findings
        │                                      ↓                 │
        ├── PATCH (expected_version) ──→ [IN_REVIEW] ────────────┘
        │    dispatch REVIEWER                 │ approve
        │                                      ↓
        ├── PATCH (expected_version) ──→ [VALIDATION] ── fail ──→ [IN_PROGRESS / READY]
        │    dispatch TESTER / VALIDATOR       │ pass
        │                                      ↓
        ├── PATCH (expected_version) ──→ [READY_TO_SHIP]
        │                                      │
        └── docs + version bump → merge --no-ff → tag v<version> → [DONE]
                                               ↓
                              close issue #N → verify deployment → report

  Heartbeats keep the lease alive. Lease lost or progress stalled → the reaper returns the card to BACKLOG.
```

## When to use it

- You want an agent to run a feature or fix end-to-end without skipping review or tests.
- You run several agents and need one place that shows who owns what, in which stage.
- You want crash-safe delegation: if a worker dies mid-build or stalls, the card returns to the queue instead of rotting in active work.

It is not a code generator and it does not replace your CI. It is a protocol that makes an agent behave like a disciplined tech lead.

## Requirements

- An agent runtime that loads `SKILL.md` skills. Primary target: [opencode](https://opencode.ai).
- A running agent-kanban-board v3.0.0 or later (v3.1.0+ recommended for boot-time credential map checks); v3 also accepts legacy v2 statuses. No board yet? The skill can deploy one locally (Node.js + npm).
- `git` and the GitHub CLI (`gh`) for the issue, branch, merge and tag steps.

## Install

opencode requires the skill folder to be named `kanban-orchestrator`, matching the `name:` field in `SKILL.md`.

**From SkillPort** (scanned, human-reviewed, checksum-verified, pinned in `skillport.lock`):

```bash
npx @skillporthq/cli@latest add riazrahaman/agentkanban
```

If the CLI places it somewhere other than your opencode skill path (for example `./skills/agentkanban/`), move and rename it to one of the paths below.

**From GitHub:**

```bash
# project-local
git clone https://github.com/riazrahaman/kanban-orchestrator.git .opencode/skills/kanban-orchestrator

# or global
git clone https://github.com/riazrahaman/kanban-orchestrator.git ~/.config/opencode/skills/kanban-orchestrator
```

## Configure

Three fields are mandatory: `kanban_url`, `kanban_token`, `project_name`. The skill resolves them in this order:

1. `.opencode/config.json` → `kanban_url`, `kanban_token`, `project_name`, optional `admin_token`
2. Environment → `KANBAN_URL`, `KANBAN_TOKEN`, `KANBAN_PROJECT`, `KANBAN_ADMIN_TOKEN`

```json
{
  "kanban_url": "http://localhost:4000",
  "kanban_token": "<your-board-token>",
  "project_name": "my-project",
  "admin_token": "<optional-admin-token>"
}
```

`.opencode/` holds tokens. Add it to `.gitignore` before writing the file, and never stage it.

On start, the orchestrator calls `GET /projects` to verify connectivity and that the project exists, and `GET /api/health` to confirm the board is `v3.0.0` or later and inspects `credential_map` (v3.1.0+) to verify project token coverage. If `project_name` or `kanban_token` can't be determined, it halts and asks you instead of guessing.

**No board yet?** If `kanban_url` is missing, the skill deploys one locally:

```bash
git clone https://github.com/riazrahaman/agent-kanban-board.git
cd agent-kanban-board
npm --prefix server install
npm --prefix client install
npm run build
npm start          # serves API + UI on http://localhost:4000 by default
```

## The lifecycle

**Stage A: Setup**
- Find or create the GitHub issue (`#N`).
- Branch from `main` as `feat/<slug>` or `fix/<slug>`.
- `POST /tasks` with caller-supplied `id`, `project`, `title`, `description`, `round: 1`, `status: "BACKLOG"`, the exact branch name (from `git rev-parse --abbrev-ref HEAD`), and `"issues": ["#N"]`, so the card mirrors into the ISSUES swimlane. Creating directly into work states requires privileged credentials.
- Promote to `READY` via `PATCH { "status": "READY" }` (role: `planner` or `admin`). Only `READY` cards can be claimed.
- Record the task `id` and initial `version`.

**Stage B: Build → Review → Test**
- **IN_PROGRESS:** claim the card from `READY` (`POST /tasks/:id/claim`), start heartbeats, dispatch the builder. Workers PATCH status and append logs; they never claim.
- **IN_REVIEW:** PATCH to `IN_REVIEW` (no re-claim), dispatch the reviewer with the diff or commit range. Blocking findings are logged and the card goes back to `IN_PROGRESS`.
- **VALIDATION:** PATCH to `VALIDATION`, dispatch the tester/validator. A fail resets the card to `IN_PROGRESS` (or `READY`) and the cycle restarts.
- **READY_TO_SHIP:** PATCH to `READY_TO_SHIP` once tests pass.

**Stage C: Closure** (from `READY_TO_SHIP`)
- Update README / docs / CHANGELOG and bump versions in lockstep.
- `git merge --no-ff`, `git tag -a v<version>`, push with tags.
- PATCH to `DONE` (role: `releaser` or `admin`) with completion metadata, close the issue with `gh issue close`.
- Verify the live deployment, then report commit hash, test output and status.

A Build → Review → Test cycle that repeats **3 times** halts and reports blockers instead of looping forever.

## Rules the orchestrator follows

- **Roles:** orchestrator = `admin`; workers = `planner`, `builder`, `reviewer`, `tester`/`validator`, `releaser`.
- **Headers on every request:** `x-agent-id`, `x-agent-role`, `x-api-token`.
- **Claim to own, PATCH to move.** Enter active stages by claiming from `READY`. A status-only PATCH into an active stage without claim produces an ownerless card, which the reaper resets to `BACKLOG`.
- **Optimistic locking:** every PATCH sends the fresh current `expected_version` (re-read before each PATCH; intermediate claims, logs, and heartbeats increment card version). Distinguish `409 Version mismatch` (retry with fresh version) from `409 Invalid state transition` (reaper reset after lease loss; re-claim). Stale writes get `409`.
- **Leases & Progress:** default claim TTL is 10 min (`KANBAN_CLAIM_TTL_MS` = 600,000). Heartbeat at least every 2 minutes while holding a card; logs from the holder also extend the lease. Progress stall timeout (`KANBAN_PROGRESS_STALL_MS`, default 30 min) reaps abandoned claims even if heartbeated. A claim can request its own window with `{"lease_ms": <ms>}`, clamped between 60,000 and 7,200,000.
- **Evidence or it didn't happen:** no stage transition without command output, test results or a commit hash.

## Project scoping (the #1 gotcha)

Every path that addresses a specific task must carry `?project=<project_name>`: `/tasks/:id`, `/:id/claim`, `/:id/heartbeat`, `/:id/logs`, and `GET /tasks`. Only `POST /tasks` takes the project in the JSON body. `GET /projects` and `GET /api/health` need no scoping.

Without it, calls silently resolve against the `default` project.

## Troubleshooting

- **`403 ... not authorized for project 'default'`** → missing `?project=` on a task path.
- **`404` on `GET /tasks/:id`** → same cause, missing `?project=`.
- **`409 Invalid state transition from BACKLOG to <X>`** → the lease expired and the reaper reset the card. Re-claim and re-walk the stages. Check `git status` / `git log` on the task branch first: uncommitted work may still be on disk, but it was never committed.
- **`409` on PATCH with a version mismatch** → someone else wrote first. Re-read the card and retry with the current `version`.
- **Card keeps bouncing back to `BACKLOG`** → it was moved into an active stage by PATCH instead of claimed, or heartbeats/progress stopped.

## Optional: Telegram reclaim alerts

When the reaper resets a card (`lease_expired`, `progress_stalled`, or `orphan_normalized`), the board can ping you on Telegram. Off unless both are set:

```bash
KANBAN_TELEGRAM_BOT_TOKEN=...
KANBAN_TELEGRAM_CHAT_ID=...
```

Optional filters: `KANBAN_NOTIFY_PROJECTS`, `KANBAN_NOTIFY_EVENTS`, `KANBAN_BOARD_URL`. The notifier only listens; it never changes the board. Treat an alert as a prompt to inspect and re-claim.

## Data notes

- Branch values are normalized on write: blank, whitespace-only or non-string values become `null`; real refs like `feat/x` are kept verbatim.
- `branch` is patchable: `PATCH {"branch": "<real-branch>"}` or `{"branch": null}`.
- Legacy cards with `branch` = `task/<id>` can be cleaned with `PATCH {"branch": null}`.

## What this skill touches

- **Network:** your configured `kanban_url`, GitHub (via `git` / `gh`, including the board clone for local deploy), and your deployment's status / health check.
- **Files:** your repo's working tree and branches, plus `.opencode/config.json` if you store config there.
- **Tokens:** read from config or environment; `.opencode/` is kept out of git and never staged.

## Versioning & releases

From `2.14.3` on, the skill version in `SKILL.md` matches the [SkillPort listing](https://skills.syed-hasan.com/skills/riazrahaman/agentkanban). Earlier GitHub releases (`v1.0.0`–`v1.2.0`) map to SkillPort versions as recorded in [CHANGELOG.md](CHANGELOG.md).

Skill versions are independent of agent-kanban-board versions. Board compatibility is listed in each changelog entry.

Release tags: [GitHub Releases](https://github.com/riazrahaman/kanban-orchestrator/releases).

## License

MIT — see [LICENSE](LICENSE).
