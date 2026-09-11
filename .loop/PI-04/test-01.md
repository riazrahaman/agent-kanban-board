# PI-04 Tester Report — Round T1

- Task: PI-04
- Commit tested: `84b8589` (includes reviewed fix `b957039`)
- Role: Tester
- Model: `gpt-5.6-sol`
- Spec: 3.10, §1.3 and §9.4.3 KB-06/07/10/11/12

## Results

- `npm test`: PASS, twice. Both runs reported 16 server tests passed and the client status test/build passed. The
  textual diff contained only timing and the nondeterministic concurrent-claim winner, not a pass/fail difference.
- PI-03 regression coverage: PASS inside `npm test`: role/state authorization, claim contention, atomic write
  failure behavior, and git-backed YAML commits were exercised.
- Malformed JSON-store status probe: FAIL for garbage status. Directly injected `null`, `""`, and
  `"not-a-loop-state"`. `normalizeStatus`/`statusStyle` returned UNKNOWN for null and blank, and those cards stayed
  visible (null in BACKLOG, blank in BACKLOG) with the UNKNOWN style. Garbage returned normalized
  `NOT-A-LOOP-STATE`, received neutral fallback classes but was grouped under a key not rendered by Board, so it was
  absent from visible card IDs. The board did not crash. This opens ISS-PI04-03.
- CORS runtime probe: PASS. `Origin: https://evil.example.com` had no allow-origin header. A configured
  `https://board.example.test` origin was reflected, while localhost and evil were not. Unset/empty configuration
  allows only the documented local `http://localhost:5173` origin and still rejects evil; it does not become wildcard.
- XSS runtime probe: PASS. Real `POST /api/tasks/xss-log/logs` with `<script>alert(1)</script>` and
  `<img src=x onerror=alert(1)>` returned escaped message and agent_id text. TaskSheet uses JSX text interpolation and
  no `dangerouslySetInnerHTML`; title, description, agent_id, and log-message paths were scanned.
- Drag-and-drop: PASS. `sortablejs` is absent from package/lockfiles; source has no application drag handlers; built
  `client/dist` has no `sortablejs`, `onDrag`, or `onDrop` application code. Generic React runtime event names were
  present in the bundle, not board handlers.
- KB-11/design: PASS for tested source/build contract: shared status helper is used by TaskCard and StatusBadge,
  mono/tabular-nums and status-in-form classes are present, and no Inter/Roboto was found in client components.
- KB-12: PASS for board repo checks: fresh no-env `node server/server.js` started on port 4000 and served `/api/tasks`;
  git-backed backend tests passed; README, LICENSE, both lockfiles, CI, and absolute-path hygiene checks passed.
- `make sec`: PASS in the board repo. Parent desk `make check` was attempted and failed on pre-existing formatter
  violations in 14 unrelated parent-repo files; no PI-04 board file was implicated.

## Verdict

One new major issue was found and logged in `.loop/PI-04/issues.md` with reproduction and observed/expected behavior.

VERDICT: FAIL
