# CI-01 Reviewer Report — Round 1

- Task: CI-01
- Commit reviewed: `fdea980` (fix) + `fe274d5` (merge adopting PI-04's fixed-fixture regression test); local `main` == `origin/main` == `fe274d5`
- Role: Reviewer
- Model: `glm-5.2`
- Spec: CI-01 (no numbered desk spec; this is a blocker for a CI/test-infrastructure defect)
- Scope: `ISS-CI01-01` (Node-20 CI leg `ERR_UNKNOWN_FILE_EXTENSION`)

## Verdict

VERDICT: PASS

`ISS-CI01-01` is ADDRESSED. Verified by reading the `fdea980`/`fe274d5` diff and the
current source — not by trusting the build report or by running the test suite (per
protocol the reviewer does not run tests and does not approve on "tests pass").

## Finding under review

ISS-CI01-01 (blocker, CI): the "Run Server Tests" step on the Node-20.x leg of
`Test & Build` executed `node --test` over `client/src/lib/signalStats.test.ts` and
aborted with `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"`,
while the Node-22.x leg passed. The `.ts` regression test was added by `9d9ca13`
(the signalStats "tiles stuck at 0" fix) and was only ever validated on Node 26, so
the Node-20 matrix leg failed every run. The underlying signalStats fix was correct;
only its test could not load on a supported version — a regression-of-a-fix.

## Verification (5 required checks, all PASS)

1. (a) No `.ts` test remains that `node --test` could run. PASS.
    `git ls-files | grep -E '\.test\.(ts|mjs)$'` returns only
    `client/src/lib/signalStats.test.mjs`. The client test glob now targets `.mjs`:
    `client/package.json:10` is `"test": "node --test src/**/*.test.mjs"` (was
    `src/**/*.test.ts`). The old `.ts` entry is gone (rename `R071` in the net diff).

2. (b) The esbuild bundle harness is sound and does not leak. PASS.
    - `client/src/lib/signalStats.test.mjs:8` imports `build` from `esbuild`; esbuild
      is a real resolvable dependency — `client/node_modules/esbuild` exists at
      version `0.25.12`, matching the pinned `overrides` `esbuild: ^0.25.0`
      (`client/package.json:27-29`). It is a transitive-of-Vite dependency that is
      pinned, not newly introduced.
    - `build()` is called with `entryPoints:[join(__dirname,'signalStats.ts')]`,
      `bundle:true`, `write:false`, `format:'esm'`, `platform:'node'`, `target:'node20'`
      (signalStats.test.mjs:17-24). `write:false` means nothing is persisted from the
      bundle.
    - The in-memory bundle text is written only to a `mkdtemp` temp dir
      (signalStats.test.mjs:25-27: `tmpdir` + `mkdtemp('signalStats-test-')` +
      `writeFile(result.outputFiles[0].text)`), dynamically imported via
      `pathToFileURL(tmpFile).href` (:28), and the temp dir is removed with
      `rm(tmpDir, { recursive: true, force: true })` (:29). No artifact leaks into the
      source tree.
    - The 4 original subtests' assertions are preserved:
      active=4 (:55, over 4 BUILDING/IN_REVIEW/IN_TEST tasks),
      blocked=2 case-sensitive (:67, with a lowercase `blocked` task that must NOT be
      double-counted — `CANONICAL_STATUSES.BLOCKED='BLOCKED'`, `status.ts:13`, matched
      by `===` at `signalStats.ts:32`),
      doneToday>0 (:124, plus doneToday=1 at :94),
      and the regression subtest (:97-124).
    - The regression subtest in `fe274d5` uses a static in-code fixture
      (:103-116), not the live `server/tasks.json` — confirmed: `grep -nE
      'tasks.json|readFile|server/'` over the file matches only the explanatory comment
      at :98, not a read. This is a correctness improvement: asserting exact counts
      against a mutable dev-state file couples the test to whoever last ran the server
      rather than to the function's behavior; the fixed fixture removes that coupling.

3. (c) No forbidden paths touched by the fix itself. PASS.
    The CI-01 fix's own net delta is `git diff --name-status 42aca3c..fe274d5` →
    exactly `M client/package.json` and
    `R071 client/src/lib/signalStats.test.ts => client/src/lib/signalStats.test.mjs`
    (32 insertions / 8 deletions, `git diff --stat`). It touches no server
    state-machine/auth/storage, no `AGENT_BUILD_SPEC.md`, no `tests/gates/` — the
    latter two paths do not even exist in this repo (`absent: AGENT_BUILD_SPEC.md`,
    `absent: tests/gates`). Caveat: `git show fe274d5 --stat` alone lists 29 files
    (PI-04 content such as `server/store.js`, `server/middleware/cors.js` arriving via
    the merge's second parent `42aca3c`), but that is merge bookkeeping — content
    already on `main` before the CI-01 fix — not part of the fix's contribution.

4. (d) No security regression. PASS.
    `git grep dangerouslySetInnerHTML client/src/` returns empty (exit 1). The change
    is a test-harness/CI loading mechanism plus a static test fixture; it touches no LLM,
    no money, and no investment-decision path. `signalStats.ts` computes display-only
    counts (active/blocked/doneToday) for the Signal Overview tiles; the fix changes only
    how the test loads and its 4th input source.

5. (e) Root-cause correctness. PASS.
    Node 20 (`node:20.20.2`, current LTS 20) has no native `.ts` execution and aborts a
    `.ts` entrypoint with `ERR_UNKNOWN_FILE_EXTENSION`; native TS type-stripping exists
    only on Node 22.6+ (flagged before 23.6). The build report's PRE/POST-FIX evidence
    reproduces the exact error and shows 4/4 on both Node 20 and Node 22. Renaming to
    `.mjs` + esbuild-bundling the TS source at test time (target `node20`) is the correct,
    matrix-portable resolution: the same `.mjs` file runs unmodified on every Node version
    CI covers.

## Adversarial regression check

- No weakening of signalStats behavior: the 4 subtests assert the same computed values as
  before; only loading and the 4th subtest's input source changed.
- The fixed-fixture regression test still guards the original bug ("all tiles stuck at 0"):
  `doneToday > 0` against two same-day DONE tasks (signalStats.test.mjs:119-124), so a
  regression that re-stallst the tiles at 0 would still fail.
- esbuild is pinned (`^0.25.0`, resolved `0.25.12`) and pulled in via Vite, so the fix
  adds no new external dependency and no network access; the bundle is in-memory
  (`write:false`) into a temp dir that is removed on every path.

## Invariants

- I1 (no LLM in decision path): N/A — UI stat-tile counts, no model.
- I2 (as_of/known_at): N/A — not market facts; `agent_logs` timestamps are workflow data.
- I3 (corrections are new rows / append-only): N/A — no store/appender touched by the fix.
- I4 (one path, backtest≡live): N/A — no execution path.
- I5 (no fabricated values): N/A — the harness asserts real computed counts; the fixed
  fixture is a declared constant, not a fabricated runtime value.
- I6 (retain the dead): N/A — no instrument universe.
- I7 (no new dependency / no network in test): HOLDS — esbuild already present and pinned;
  bundle in-memory into a cleaned-up temp dir; no network.
- I8 (no silent float money rounding): N/A — no money arithmetic (integer counts only).

## Forbidden-file check

`git diff --stat 42aca3c..fe274d5` (the CI-01 fix's net contribution) touches only
`client/package.json` and `client/src/lib/signalStats.{test.ts→.mjs}`. No
`server/` state-machine/auth/storage change, no `AGENT_BUILD_SPEC.md` (absent in repo), no
`tests/gates/` (absent in repo). The broader `git show fe274d5 --stat` 29-file list is
merge bookkeeping from PI-04 via the second parent and is out of scope for the fix's
contribution. CLEAN.

## Result

ISS-CI01-01 → REVIEWED (fixed_in `fdea980`, merge `fe274d5`; recommended
`reviewed_in=fe274d5`, since `fe274d5` is the head of `main`/`origin/main` and adopts the
final fixed-fixture regression test; VERIFIED/TBD remains Tester-owned). No open findings,
no escalation. Do not edit `issues.md`; record `reviewed_in=fe274d5` when transitioning.
