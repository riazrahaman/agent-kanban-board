# ADR-002 — Git-backed commit failure and recovery

**Task:** PI-03 (KB-05, KB-09)  
**Status:** accepted

## Context

The Git YAML backend must write one card per task and create a commit for each
transition. The card write and the Git index/commit are separate filesystem
operations; no portable transaction can atomically span both a normal file
rename and Git's object database.

## Decision

The backend writes the card with the same-directory temp-file + rename protocol,
then runs `git add` and `git commit`. Any Git failure is thrown to the caller;
the store does not broadcast or update in-memory state. This makes a failed
transition visible and prevents the API from claiming a state that was not
committed.

## Accepted failure window and recovery

A process crash after the card rename but before commit can leave a newer,
uncommitted YAML card in the worktree. A cold load reads that card, so the
latest durable file state is recoverable, but the intermediate transition is
not represented as its own Git commit. A human/operator must inspect and commit
or revert that worktree before resuming the board. A commit failure is likewise
left visible in the worktree/index for inspection; it is never silently folded
into a successful in-memory transition. Closing this cross-store crash window
would require a transactional filesystem/Git journal beyond the PI-03 scope.

## Consequence

JSON persistence remains fully atomic at the file level. Git persistence is
atomic for the card replacement and fail-visible for the commit step, with the
small documented two-phase window above. The behavior is covered by the
commit-failure test and the store's post-save in-memory update ordering.
