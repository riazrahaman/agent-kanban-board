# PI-03 Builder fix report — round 01

I read `.loop/PI-03/review-01.md` in full. This fix addresses every numbered
finding in the Reviewer report in one fix commit on the existing `task/PI-03`
branch.

1. **KB-03 PATCH bypass** — `server/store.js:429-438`: removed
   `assigned_agent` from the PATCH allowlist. Claim ownership is now changed
   only through `/claim`; the test at `server/test/kanban.test.js:187-191`
   proves PATCH cannot steal the winner's claim.
2. **Commit failure evidence** — `server/test/kanban.test.js:278-299` creates a
   local failing Git pre-commit hook, asserts the Git-backed save throws, and
   asserts `store.getTask()` remains null. The throw behavior remains at
   `server/store.js:236-238`.
3. **Missing/blank status** — `server/store.js:346-350` now normalizes the
   supplied status without a BACKLOG fallback and returns 400 when absent or
   blank. `server/test/kanban.test.js:64-78` covers both forms.
4. **Missing round** — `server/store.js:350-352` requires a positive integer
   round at creation, and `server/store.js:191-195` refuses malformed Git cards
   instead of serializing a fabricated 1. `server/test/kanban.test.js:72-78`
   covers the API refusal.
5. **Git torn-write window** — added
   `docs/decisions/ADR-002-git-commit-failure-and-recovery.md`, documenting the
   actual two-phase card-rename/Git-commit crash window, recovery procedure,
   and why a cross-store transaction is outside PI-03. The backend remains
   fail-visible and never updates memory before commit success.
6. **Missing ADRs** — ADR-002 records commit failure behavior and ADR-003
   (`docs/decisions/ADR-003-process-local-mutation-serialization.md`) records
   the process-local mutation queue, its failure-chain behavior, and its
   single-process boundary.

I also added the Reviewer's minor requested tests for duplicate issue IDs and a
malformed role. I did not touch the immutable spec, gate tests, unrelated PI-04
work, or merge/push anything.

The original report remains unchanged. Context percentage for this fix round is
a self-estimate of 20% (no external runner measures this manual session), not
an externally verified usage value.
