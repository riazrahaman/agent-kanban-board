ID        opened_round  severity  status  fixed_in  reviewed_in  verified_in
ISS-CI01-01  CI          blocker   CLOSED    fdea980  fe274d5     T1

# ISS-CI01-01 (blocker, CI)
Failing GitHub Actions run 34601821103, job "Test & Build (Node 20.x)", step "Run Server
Tests": the client test step executes `node --test` over `client/src/lib/signalStats.test.ts`
and aborts with `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"`. The Node
22.x leg of the same matrix passed, so only the Node 20.x leg failed. Root cause: Node's native
TypeScript execution exists only on Node 22.6+ (behind a flag until 23.6+); Node 20 cannot load a
`.ts` entrypoint at all. The `.ts` regression test was added by 9d9ca13 (the signalStats "tiles
stuck at 0" fix) and was only ever validated on Node 26, so the Node-20 matrix leg failed every
time. This is a regression-of-a-fix: the underlying signalStats fix was correct, but its test
could not run on a version the supported CI matrix tests.
FIX fdea980 / fe274d5: rename `signalStats.test.ts` to `signalStats.test.mjs` and rewrite it in
plain ESM so it esbuild-bundles `signalStats.ts` at test time (entryPoints=[signalStats.ts],
bundle:true, write:false, format:'esm', platform:'node', target:'node20'), writes the bundle to a
temp dir, dynamically imports it, asserts the 4 subtests, and cleans up the temp dir; update the
client test glob from `node --test src/**/*.test.ts` to `node --test src/**/*.test.mjs`. fe274d5
merges PI-04's fixed-fixture regression test (the 4th subtest asserts against a static in-code
fixture instead of reading the live, mutable `server/tasks.json`). REVIEWED by .loop/CI-01/review-01.md
(VERDICT PASS, reviewed_in=fe274d5); VERIFIED by .loop/CI-01/test-01.md round T1
(VERDICT PASS, verified_in=T1): node:20.20.2, node:22.23.2, and local node v26.8.1 each run the
full CI chain (server 16/16, client status helper 1/1, signalStats .mjs 4/4, vite build OK) with
`make sec` passing; a raw .ts entrypoint still throws ERR_UNKNOWN_FILE_EXTENSION on node:20, proving
the fix routes around the language limit portably.
