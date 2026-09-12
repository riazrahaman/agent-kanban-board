# CI-01 Builder Report

## Result

The code fix is already merged. Local `main` is fast-forward-synced to `origin/main` at `fe274d5`
(fast-forward from `42aca3c`, clean, no conflicts); the working tree is clean. This builder round
records and verifies that resolution and authors no new production or test code. The only net-new
content this round is these two files (`.loop/CI-01/issues.md` and
`.loop/CI-01/build-report.md`).

The resolution is two commits:

- `fdea980` — `fix(ci): signalStats test failed on Node 20.x (no native .ts execution)`. Renames
  `client/src/lib/signalStats.test.ts` to `signalStats.test.mjs`, rewrites it as plain ESM that
  esbuild-bundles the TS source at test time, and updates the client test glob.
- `fe274d5` — `Merge origin/main: keep the esbuild/.mjs Node-20 fix, adopt PI-04's fixed-fixture
  regression test`. Reconciles `fdea980` with PI-04's fixed-fixture 4th subtest.

## Root cause

GitHub Actions run `34601821103`, job "Test & Build (Node 20.x)", step "Run Server Tests" failed
while the Node 22.x leg passed. Node's native TypeScript execution exists only on Node 22.6+
(behind a flag until 23.6+); Node 20 cannot load a `.ts` entrypoint and aborts with
`TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"`. The `.ts` regression test
was introduced by `9d9ca13` (the signalStats "tiles stuck at 0" fix) and was only ever validated
on Node 26, so the Node-20 leg of the matrix failed every run. The underlying signalStats fix was
correct; only its test could not run on a supported version — a regression-of-a-fix, not a runtime
defect.

## Resolution

`signalStats.test.ts` was renamed to `signalStats.test.mjs` and rewritten as plain ESM. At test
time it invokes esbuild's `build()` with `entryPoints=[signalStats.ts]`, `bundle:true`,
`write:false`, `format:'esm'`, `platform:'node'`, `target:'node20'`; it writes the in-memory
bundle to a temp dir via `mkdtemp`, dynamically imports it to get `computeSignalStats`, asserts the
4 original subtests, then removes the temp dir with `rm`. The client test glob moved from
`node --test src/**/*.test.ts` to `node --test src/**/*.test.mjs` (`client/package.json:10`,
already `fe274d5`).

This approach is sound because: esbuild is already present (a client devDependency via Vite; pinned
`^0.25.0` under `client/package.json` `overrides`), so no new external dependency is introduced;
`target:'node20'` emits code the whole supported matrix can run; nothing is written into the source
tree (`write:false` plus a temp dir that is cleaned up on every path); and the test file is now
plain ESM that runs unmodified on every Node version CI covers (Node 20 and Node 22). `fe274d5`
also swaps the 4th subtest's input from the live `server/tasks.json` (mutable local/dev state,
whatever the board's own runtime last wrote) to a static in-code fixture, which removes a hidden
coupling to that runtime state — a correctness improvement.

## Acceptance evidence

Ground-truth results, performed by the orchestrator:

- PRE-FIX reproduced on Node 20 (`node:20.20.2`): running the old `.ts` test yields
  `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"` — the exact CI failure.
- POST-FIX on Node 20 (`node:20.20.2`, fresh `npm --prefix server ci` + `npm --prefix client ci`,
  then `npm test`): server 16/16 pass, client status helper 1/1 pass, client signalStats `.mjs`
  4/4 pass, client Vite build OK, exit 0.
- POST-FIX on Node 22 (`node:22.x`, same chain): identical pass results — 16/16, 1/1, 4/4, build
  OK.
- `make sec` PASS in the post-fix tree.

## Invariants

- I7: Relevant to the test harness. The `.mjs` test uses esbuild, which is already in
  `client/package.json` devDependencies (pinned `^0.25.0` via `overrides`); it introduces no new
  external dependency and no network access. The bundle is built in-memory (`write:false`) into a
  temp dir that is cleaned up, so no persistent artifact is left behind.
- PI-03 / PI-04: Not weakened. The fix changes only how the test is loaded and the 4th subtest's
  input source; the asserted signalStats behavior (the 4 subtests) is unchanged, and PI-04's status
  normalization / board-rendering invariants are untouched by these two commits.
- Coupling removed: switching the 4th subtest from reading the live, mutable `server/tasks.json` to
  a fixed in-code fixture (`fe274d5`) removes a hidden coupling to mutable dev state — the test now
  asserts the function's behavior rather than whoever last ran the server. This is a correctness
  improvement, not a relaxation.

## Deliberately not done / uncertainty

No competing fix was authored: the upstream resolution (`fdea980`/`fe274d5`) was adopted as-is to
avoid divergence from the canonical, CI-verified one. The only net-new content this round is these
two docs. One environment caveat, not a defect: when esbuild's native binary is copied from a
darwin host into a linux container without reinstalling, esbuild throws "You installed esbuild for
another platform...". This is an artifact of host-mounting `node_modules`, not a regression; CI
runs `npm ci` inside the container (as required) and the binary is rebuilt for the target platform,
so the failure never occurs in a correctly-run CI leg.
