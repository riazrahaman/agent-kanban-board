# ADR-003 — Process-local mutation serialization

**Task:** PI-03 (KB-03, KB-05)  
**Status:** accepted

## Context

Claim contention is checked against the current in-memory task. Without a
serialization boundary, two HTTP requests can both observe an unclaimed task,
both persist a claim, and whichever finishes last can win silently.

## Decision

All store mutations enter a process-local promise queue. Each operation reads
the current task, persists its candidate, and only then updates memory and
broadcasts SSE state. A rejected operation is removed from the queue chain so
one failed disk or Git operation does not permanently block later requests.

## Consequence

Concurrent requests handled by one server process have deterministic claim
contention and preserve the KB-05 memory-after-persistence invariant. This is
not a distributed lock: multiple server processes sharing the same backend
remain outside PI-03's single-process scope and require a backend-level lock or
transaction before that deployment model is supported.
