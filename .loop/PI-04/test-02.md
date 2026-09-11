# PI-04 Tester Report — Round T2

- Task: PI-04
- Commit tested: `f00b99f` (fix `15dd137`, reviewer bookkeeping `59b143c`)
- Role: Tester
- Model: `gpt-5.6-sol`
- Spec: 3.10, §1.3, §2.4, §9.4.3 KB-06/07/10/11/12

## Full re-verification

- ISS-PI04-03 exact regression: PASS. Injected the same JSON-store records with `null`, empty-string, and
  `not-a-loop-state` statuses. The real `normalizeStatus` and `statusStyle` returned `UNKNOWN` for all three;
  `groupTasks` placed all three IDs in `grouped.UNKNOWN`; the rendered column set included all three under the new
  `UNKNOWN` column. No board-wide crash or silent drop.
- CORS: PASS. `https://evil.example.com` received no allow-origin header; configured
  `https://board.example.test` was reflected; localhost was rejected when another origin was configured. Empty/unset
  configuration remained restricted to the documented localhost origin and rejected evil, never wildcard.
- XSS: PASS. Real API log submission with `<script>alert(1)</script>` and `<img src=x onerror=alert(1)>` returned
  escaped `message` and `agent_id`; TaskSheet, TaskCard, SignalRail, and metadata/title/description render paths use
  JSX/text interpolation with no `dangerouslySetInnerHTML`.
- Drag-and-drop: PASS. `sortablejs` is absent from package manifests and lockfiles. Source and built `client/dist`
  scans found no `onDrag`, `onDrop`, or `sortablejs` application code. Generic React runtime event-name tables are
  not board handlers.
- KB-11/design: PASS. TaskCard, StatusBadge, Board, and SignalRail use the shared status/board model; the UNKNOWN
  column is visible; mono/tabular-nums and status-in-form styling remain present; no Inter/Roboto usage found.
- KB-12 zero-config: PASS. With an empty environment, `node server/server.js` started on port 4000 and served
  `/api/tasks`. Git-backed storage and public-repo hygiene checks remained green.
- PI-03 regressions: PASS. `npm test` exercised role authorization/state transitions, concurrent claim contention,
  atomic persistence failure handling, issue register behavior, and git-backed YAML commits.
- Determinism: PASS. `npm test` ran twice; both runs reported 16 server tests passed, 1 client status test passed,
  zero failures, and successful client builds. After normalizing timing and the concurrent claim winner, outputs were
  identical.
- Security/full checks: board `make sec` passed. Parent desk `make check` was rerun and still fails only on 14
  pre-existing formatter violations outside this board repository; no PI-04 file is implicated.
- Forbidden paths: `git diff --stat origin/main...HEAD -- tests/gates/ AGENT_BUILD_SPEC.md` was empty.

All three existing issues were independently verified and transitioned `REVIEWED → VERIFIED → CLOSED` in this round.

VERDICT: PASS
