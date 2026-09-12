# CI-01 Tester Report — Round T1

- Task: CI-01
- Commit tested: `fe274d5` (local `main` == `origin/main` == `fe274d5`, includes fix `fdea980`)
- Role: Tester
- Model: `ollama/qwen3.8:27b-mlx`
- Spec: 3.10, §9.4.3 KB-12 CI-matrix portability

## Results

- No-`.ts`-test check: PASS. `git ls-files | grep -E '\.test\.(ts|mjs)$'` returns only
  `client/src/lib/signalStats.test.mjs`; no `.ts` test is tracked (`git ls-files | grep
  '\.test\.ts$'` → empty). The client test glob is `client/package.json:10` =
  `"test": "node --test src/**/*.test.mjs"`. No `.ts` entrypoint can be picked up by `node --test`.
- Node 20 chain (the originally failing leg; `node:20.20.2`, fresh `npm ci` in a `node:20`
  container): PASS. `npm --prefix server ci` exit 0, `npm --prefix client ci` exit 0, then the
  full `npm test` chain and `make sec`. TAP summaries in order: server `# tests 16 / # pass 16 /
  # fail 0`; client status helper `# tests 1 / # pass 1 / # fail 0`; client signalStats `.mjs`
  `# tests 4 / # pass 4 / # fail 0`. Client Vite build: `✓ built in 708ms`, exit 0. No
  `ERR_UNKNOWN_FILE_EXTENSION` anywhere. `npm test` exit 0, `build` exit 0.
- Node 22 parity (`node:22.23.2`, fresh `npm ci` in a `node:22` container): PASS, identical
  counts — server `16/16`, client status helper `1/1`, signalStats `.mjs` `4/4`, build
  `✓ built in 715ms`, all exit 0.
- Local chain (`node v26.8.1`, main repo, no container): PASS. `npm test` exit 0; v26 reporter
  confirms server `16/16`, client status helper `1/1`, signalStats `.mjs` `4/4`, then Vite build
  `✓ built in 500ms`. `make sec` exit 0, "All security checks passed."
- `make sec`: PASS in the main repo (real git worktree): "Running security checks... / All
  security checks passed.", exit 0. (No personal absolute home paths; no
  `dangerouslySetInnerHTML` in `client/src/`.)
- Adversarial regression of the original failure mode: CONFIRMED gone, and confirmed it is gone
  only because the fix routes around it, not because Node 20 learned `.ts`. Running
  `node --test` on a plain `.ts` entrypoint still fails on `node:20.20.2` with
  `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"` (exit 1); the same `.ts`
  loads fine on local `node v26`. The fix's `.mjs`+esbuild-bundle path is what runs on every Node
  version, and it is version-portable: the unmodified `signalStats.test.mjs` produced `4/4` on
  Node 20, Node 22, and Node 26 alike.
- Cleanup: PASS. Temp worktree `/tmp/ci01-postfix` removed (`git worktree remove --force` +
  prune); scratch dirs removed. `git status --short` in the main repo shows only `?? .loop/CI-01/`
  (the round's own docs), matching the pre-run state; no tester-generated files, no `dist/`, no
  stray `.log` left in the tree.
- Environment caveat (not a regression): when a host `darwin-arm64` `client/node_modules` is mounted
  into a Linux container, esbuild throws "You installed esbuild for another platform than the one
  you're currently using". This is an artifact of host-mounting, not the fix; running `npm ci`
  inside the container rebuilds the linux binary and the run is green, as above. In the in-container
  `make sec`, the detached worktree's `.git` resolves to an unmounted host path, so the two
  `git grep` checks print "fatal: not a git repository"; the `@!` (negated) recipe still exits 0,
  so the container `make sec` is a false-green — I therefore relied on the real `make sec` run in
  the main repo (PASS) as the authoritative security result.

## Adversarial regression check

- The original ISS-CI01-01 failure mode (`node:20` + a `.ts` test → `ERR_UNKNOWN_FILE_EXTENSION`)
  is gone from the actual suite: no `.ts` test is tracked and the glob targets `.mjs`, so the
  failing command no longer exists. A direct `.ts` entrypoint on `node:20.20.2` still throws the
  exact error, confirming the fix resolves the issue by changing the loading mechanism, not by
  relying on Node 20 gaining native `.ts` (which it does not).
- The `.mjs` path is version-portable: the identical, unmodified `signalStats.test.mjs` produced
  `4/4` on Node 20, Node 22, and Node 26, so the same file satisfies the whole `20.x`/`22.x` CI
  matrix. No signalStats behavior was weakened — the 4 subtests assert the same computed values
  (active=4, blocked=2 case-sensitive, doneToday=1, and the fixed-fixture regression
  `doneToday > 0`), guarding the original "tiles stuck at 0" bug.
- No security regression: `make sec` is green in the main repo.

## Verdict

VERDICT: PASS

All suites and `make sec` are green on Node 20 (`20.20.2`), Node 22 (`22.23.2`), and local
(Node `26.8.1`): server 16/16, client status helper 1/1, signalStats `.mjs` 4/4, Vite build OK on
every runtime; the original `ERR_UNKNOWN_FILE_EXTENSION` is no longer reachable by the suite while
still reproducible for a raw `.ts` entrypoint, confirming the fix routes around it portably. No
source or other doc was modified; only this report was written.
