# PI-03 Builder fix report — Tester round 01

I read `.loop/PI-03/issues.md`, `.loop/PI-03/test-01.md`, and the Reviewer
round-02 PASS report before editing. All three Tester issues are advanced only
to `FIXED`; the Reviewer/Tester own later issue transitions.

- **ISS-PI03-07 — duplicate task IDs:** `server/store.js:346-348` now checks
  the in-memory task index before validation/persistence and returns `409` for
  an existing id. `server/test/kanban.test.js:63-74` creates a card, repeats
  the create, and verifies the original title remains.
- **ISS-PI03-08 — unknown roles:** `server/middleware/auth.js:8-16`
  defines the allowlisted workflow roles, and `server/middleware/auth.js:58-65`
  rejects missing or unknown roles on every mutating HTTP method after token
  validation. `server/test/kanban.test.js:209-228` proves unknown create,
  claim, and log requests all return `403`.
- **ISS-PI03-09 — async Git errors crash the process:**
  `server/routes/tasks.js:6-8` adds an Express-4 promise rejection adapter and
  all mutating async routes use it (`server/routes/tasks.js:14-22,30-42,44-58,60-72,80-91`).
  `server/server.js:36-40` therefore receives the rejection and returns the
  controlled `500` response. `server/test/kanban.test.js:337-357` makes
  `.git/index` a directory so `git add` fails through the HTTP route, asserts
  `500`, and then confirms the same server still answers `GET /api/tasks`.

The required issue rows now read `FIXED` with
`fixed_in=b0094bf99123528873a6fbfc00d9a846c025f476`. The implementation and
regression tests are in that single fix commit. No spec, gate, merge, or push
was performed. Context percentage for this manual fix round is a self-estimate
of 28%; no external runner measured it.
