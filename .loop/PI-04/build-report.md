# PI-04 Builder Report

## Result

Implemented and independently re-verified KB-06, KB-07, KB-10, KB-11, and KB-12 on `task/PI-04`.

Commits:

- `cc23bd8` — public-board hardening, client API/config corrections, design consistency, and PI-04 tests.
- `8219055` — refuse an absent status as `UNKNOWN` instead of silently displaying `BACKLOG`.

## Acceptance evidence

`npm test` passes: 16 server tests, followed by the TypeScript/Vite production build.

`make sec` passes. `git diff --check` passes. The tests cover the new behavior and assert that no forbidden files were changed.

## KB-06 — configured CORS origin

The existing implementation already rejected wildcard CORS and honored an environment override, but it allowed a broad built-in loopback allowlist. I fixed this so the default is exactly `http://localhost:5173`, while `KANBAN_ALLOWED_ORIGIN` selects one explicit origin. Empty and wildcard configuration throws at startup. Tests verify the default, rejection of `127.0.0.1:5173`, and custom-origin replacement.

## KB-07 — stored XSS in agent logs

The existing server already escaped task and log text, and the React client already used JSX text interpolation rather than `dangerouslySetInnerHTML`. I retained that defense-in-depth behavior and added an adversarial script/img payload test that verifies the API stores inert escaped text and that `TaskSheet` renders `{log.message}` as JSX text. No HTML injection API is present.

## KB-10 — no drag-and-drop

The existing client and README already omitted drag handlers and `sortablejs`. I independently verified both package manifests/lockfile and all board components, and added tests that fail if the dependency or drag event handlers return. No replacement human card-move interaction was added.

## KB-11 — DESIGN.md application

The existing token declarations, Tailwind token wiring, system font stacks, and absence of Inter/Roboto were substantially correct. I fixed consistency gaps across the task card, detail sheet, signal rail, and header: ids/timestamps/counts use mono/tabular numerals with readable ink color; status is represented by a shared text badge plus semantic left stripe; operational pills have square corners; the live indicator is square; and the user emoji markers were removed. The detail view now uses the same status badge as cards. Signal rollups now normalize canonical and legacy statuses.

The React/Vite/Tailwind stack remains in place as required by §9.4.2; no framework rewrite was attempted. The existing Tailwind palette maps to the DESIGN.md CSS variables, and tests enforce the key anti-pattern bans across the rendered component source.

## KB-12 — public standalone repository

README, MIT LICENSE, both committed npm lockfiles, CI, and `make sec` were already present. I corrected the public quickstart so the JSON backend is the default no-configuration backend, the optional git backend is explicit, and the client default API URL matches the documented server port (`4000`, not `4100`). The repository contains no personal absolute paths or secrets detected by `make sec`; the CI workflow runs `make sec`, server tests, and the client build. The server remains read-ready with no configuration; mutations continue to fail closed unless an auth token is deliberately configured.

## Invariants

- I1: N/A. This board carries workflow records only; no LLM output or investment decision values are introduced.
- I2/I3/I4/I6/I8: N/A to this task. No point-in-time facts, correction ledger, backtest/live split, universe, or monetary arithmetic is changed. Existing append/persistence behavior was not weakened.
- I5: Relevant. CORS has a safe explicit local default, rejects empty/wildcard configuration, and does not turn an invalid status into `BACKLOG`; the client displays `UNKNOWN`. Existing required fields and auth fail-closed behavior remain covered by PI-03 tests. Escaping never substitutes a missing log message.
- I7: Relevant to tests. The new tests use local in-process HTTP and filesystem fixtures only; no network dependency is introduced.

## Deliberately not done / uncertainty

I did not redesign the inherited API, alter PI-03 state-machine/auth/storage behavior, add dependencies, change `AGENT_BUILD_SPEC.md`, or touch `tests/gates/`. I did not add a browser automation test; the client build plus source-level assertions verify the security/rendering and design contracts, while a real Reviewer and Tester should perform the independent UI and adversarial pass.

