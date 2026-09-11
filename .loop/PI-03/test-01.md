# PI-03 Tester round 01

VERDICT: FAIL

Tester: tester-pi03-codex
Commit tested: `3f97fb9ce370c738affccc50e4eac4b3036ef118` on `task/PI-03`

## Scope and acceptance

- `git diff --stat main...task/PI-03` contains only the expected board source,
  tests, ADRs, README, and loop reports. No spec or gate file is in the diff.
- The spec-required forbidden-file check is clean: no `tests/gates/` or
  `AGENT_BUILD_SPEC.md` path is changed.
- `npm test`: PASS, 9/9 tests.
- `npm test` run a second time: PASS, 9/9 tests.
- Determinism: both runs left identical `git status --short` and identical
  commit history. Output differed only in test timing and the randomized name
  of the winning concurrent claimant; no extra commit or persisted YAML drift
  occurred.

## Adversarial probes

- Claim race: two concurrent `POST /api/tasks/race/claim` requests returned
  exactly one `200` and one `409`; the winner remained the assigned agent.
- PATCH claim bypass: direct `PATCH /api/tasks/race` with
  `{\"assigned_agent\":\"thief\"}` returned `200` but preserved the existing
  holder; no reassignment occurred.
- Role escalation: Builder→`DONE`, Tester→`BUILDING`, and unknown-role→status
  transition were refused (`403`/`409` as applicable). However, the unknown
  role was still able to create, claim, and append a log with a valid token;
  this is logged as ISS-PI03-08.
- State-machine abuse: `DONE`→`BUILDING` returned `409`; transition to
  `NOPE` returned `400`.
- Authentication: missing or garbage bearer tokens were refused on task POST,
  PATCH, claim, and logs (`401`; missing configured token also returns `503`).
- Required fields: empty id, empty status, empty/missing round, negative round,
  and non-integer round returned `400`. A duplicate task id did not: the second
  `POST /api/tasks` returned `201` and replaced the first task, logged as
  ISS-PI03-07.
- Git-backed failure: making `.git/index` unusable caused `git add` to fail.
  Direct storage returned an error and did not update in-memory state, but left
  the new YAML card uncommitted. Through `POST /api/tasks`, the rejected async
  route was unhandled and the Node process terminated instead of returning a
  controlled non-success response. This is logged as ISS-PI03-09.
- Missing task: GET, PATCH, claim, and logs for a nonexistent id returned `404`.

## Findings and exact reproductions

1. `ISS-PI03-07` — duplicate create overwrites an existing task.

   Reproduction: with a valid token, POST
   `{\"id\":\"dup\",\"title\":\"first\",\"status\":\"BACKLOG\",\"round\":1}`
   and then POST `{\"id\":\"dup\",\"title\":\"second\",\"status\":\"BACKLOG\",\"round\":1}`.
   Observed: first response `201`, second response `201`, and the returned
   task title changed to `second`. Expected: duplicate task creation refused
   with a client-conflict response (`409`) and the original task preserved.

2. `ISS-PI03-08` — unknown roles can mutate non-transition data and claim tasks.

   Reproduction: with `Authorization: Bearer pi03-adversarial-token` and
   `X-Agent-Role: unknown`, POST a valid task, POST `/api/tasks/dup/claim` with
   `{\"agent_id\":\"unknown-agent\"}`, and POST `/api/tasks/dup/logs` with
   `{\"agent_id\":\"unknown-agent\",\"message\":\"x\"}`.
   Observed: responses were `201`, `200`, and `200`; the task was claimed and
   the log was appended. Expected: an unknown role attempting any mutation is
   refused, per the PI-03 KB-02 adversarial requirement.

3. `ISS-PI03-09` — git-add failure crashes the HTTP server.

   Reproduction: initialize a local git-backed store, create `.git/index` as
   a directory so `git add` fails, then POST a valid task to the running
   server. Observed: direct storage raised `Git-backed persistence commit
   failed` and left memory unchanged, but the HTTP POST rejected without an
   HTTP response and the Node process exited with code `1` and the uncaught
   error from `GitYamlStorage._tryGitCommit`. The YAML card remained on disk
   uncommitted. Expected: mutation failure is surfaced as a controlled 5xx
   response, the process remains alive, and no successful mutation is reported.

## Bookkeeping

All findings were batched in this round. No source, test, fixture, spec, or
gate file was modified. No merge or push was performed.
