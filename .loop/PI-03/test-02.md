# PI-03 Tester round 02

VERDICT: PASS

Tester: tester-pi03-codex
Commit tested: `b0094bf99123528873a6fbfc00d9a846c025f476` on `task/PI-03`

## Exit-condition checks

- ISS-PI03-07, ISS-PI03-08, and ISS-PI03-09 were re-run from their original
  reproductions and are now CLOSED in `issues.md` with `verified_in: T2`.
- This round opened zero new issues.
- The full adversarial probe list was executed, not only the three fixes.
- No merge or push was performed.
- The forbidden-file diff is clean: no `tests/gates/` or
  `AGENT_BUILD_SPEC.md` path is changed.

## Acceptance and determinism

- `npm test`: PASS, 12/12.
- `npm test` a second time: PASS, 12/12.
- Determinism: both runs left identical `git status --short` and identical
  commit history. The only output differences were expected test durations and
  the randomized winner name in the claim-race test; no persisted git state,
  extra commit, or YAML drift occurred.

## Original issue reproductions

- ISS-PI03-07: two valid `POST /api/tasks` requests with the same id returned
  `201` then `409`; `GET` confirmed the original title remained unchanged.
- ISS-PI03-08: valid-token requests with `X-Agent-Role: unknown` on create,
  PATCH, claim, and logs all returned `403`. Valid Builder, Reviewer, and
  Tester roles remained usable on their permitted mutations.
- ISS-PI03-09: a local git pre-commit hook forced `git commit` to fail through
  `POST /api/tasks`; the route returned controlled `500 Internal Server Error`,
  the task stayed absent from memory, and a subsequent `GET /api/tasks`
  returned `200`, proving the server remained alive.

## Full adversarial probe list

- Claim race: concurrent claims returned exactly one `200` and one `409`; the
  winning holder was retained.
- PATCH claim bypass: PATCH with `assigned_agent: thief` returned `200` while
  preserving the existing holder.
- Forbidden role transitions: Builder→`DONE` was refused (`409` from
  `BACKLOG`, `403` from `IN_TEST`); Tester→`BUILDING` after `DONE` was `409`;
  unknown-role mutations were `403`.
- State-machine abuse: valid loop transitions succeeded; `DONE` backwards was
  `409`; a nonexistent status was `400`.
- Authentication: missing or garbage bearer tokens were refused on task POST,
  PATCH, claim, and logs with `401`.
- Required fields: empty id, empty status, empty round, negative round, and
  non-integer round each returned `400`; duplicate id returned `409` and did
  not replace the original.
- Git-backed failure at a different point: a failing pre-commit hook caused a
  controlled `500` and the server remained responsive afterward. The existing
  `git add` failure path also passed the 12-test suite's live HTTP liveness
  test.
- Missing task id: GET, PATCH, claim, and logs all returned `404`.

All required probes passed and no new issue was found in this clean round.
