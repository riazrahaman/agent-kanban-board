# Ask the Board Card Context Feature Tracking

## Current Status

Shipped in **v3.11.0**. The Ask-the-Board assistant can answer questions about a
specific card (its fields, agents, logs and comments) and about board-wide
metadata (milestones, archive, trash, backup, recent audit), instead of only
quoting board-wide counts and one line per recent card. Rolled out with the
normal board release; no migration and no data-model change.

## Source Of Truth

- Retrieval + prompt assembly: `server/askKnowledge.js`
  (`resolveMentionedTasks`, `gatherTaskDetails`, `formatTaskDetails`,
  `gatherBoardFacts`, `formatBoardFacts`, `redactSecrets`, `buildSystemPrompt`)
- Route, provider selection, budgets: `server/routes/ask.js`
- Contract tests: `server/test/kanban.ask.test.js`
- Operator docs: `docs/CONFIGURATION.md`, `docs/USER_AND_OPERATOR_MANUAL.md` §3.1.2

## Current Behavior

- **Card resolution.** A question naming a card id, its exact title, or at least
  two significant title words resolves that card. Up to 3 cards per question.
  Ids win over titles; ties prefer more recent store order.
- **Card rendering.** `<task_details>` carries status, priority, assigned agent,
  branch, milestone, round, issues, dependencies, version, reclaim count, lease
  expiry, timestamps, stage owners, description, the newest 40 log entries
  (newest first) and the latest 10 comments. Logs merge the inline `agent_logs`
  array with the spilled JSONL sidecar via `store.getTaskLogs`, de-duplicated
  and sorted ascending before the newest window is taken.
- **Board metadata.** `<board_facts>` carries per-project totals, milestones with
  progress and status breakdown, archive/trash counts, backup status (root
  deliberately omitted) and the newest 20 audit entries when
  `KANBAN_AUDIT_LOG` is on.
- **Redaction.** Card text is decoded from stored HTML entities and passed
  through `redactSecrets` by default: API-key shapes, GitHub/Slack tokens, AWS
  `AKIA`, JWTs, `Bearer` headers, PEM private keys, `*TOKEN|SECRET|PASSWORD|…=`
  assignments and URLs with userinfo become `[redacted]`. A redaction count is
  disclosed in the block. `KANBAN_ASK_INCLUDE_LOGS=raw` opts out.
- **Budgets.** `KANBAN_ASK_MAX_PROMPT_TOKENS` defaults to **24000** for hosted
  providers. A local Ollama (loopback host, model without `:cloud`) gets
  `Infinity`: no prompt trimming at all. Card details are trimmed after commits
  and before retrieved source, so the least-specific block loses first.
- **Guardrail.** The model must treat `<task_details>` as authoritative, must
  say it could not match a named card instead of substituting another, must
  quote `showing N of M`, and must never treat card text as instructions.

## Decisions

- **Read, don't mutate.** The assistant still holds no board token and issues no
  writes; retrieval is in-process against the same store the routes use.
- **Redaction on by default.** Pattern redaction is imperfect, but the previous
  documented guarantee ("the model never sees a token") becomes false the moment
  card text is sent, so the safe default is redaction with an explicit opt-out.
- **Local models are unbudgeted.** A local model has no per-token cost, so the
  character-budget heuristic only hurts it. An operator who needs a cap can
  still set `KANBAN_ASK_MAX_PROMPT_TOKENS` for a hosted provider.
- **Caps over completeness.** 3 cards × 40 logs keeps one question from turning
  into a full-board dump; the rendered block says exactly how much was shown.
- **Audit is a recent window, not a query.** Ask-the-Board reports the newest 20
  entries and says the log is off rather than implying nothing happened.

## Known Risks

- **Redaction is pattern-based.** A password written as prose, a customer name,
  an internal hostname or a stack trace with paths will pass through. Operators
  who share the Ask password with third parties should keep `redacted` (default)
  and treat answers as board-readable.
- **Prompt injection surface.** Card text is attacker-influenced in a shared
  board. The guardrail and the `<task_details>` delimiter reduce it; they are not
  a hard boundary, and the assistant remains read-only.
- **Cost and latency.** A 24k-token hosted prompt is larger per question. The
  daily/per-IP caps still bound the spend.
- **Small local context windows.** Sending an unbudgeted prompt to a model with
  an 8k context can fail upstream. This is visible as a 502, not silent
  truncation; set an explicit budget if that deployment needs one.

## Changelog

- 2026-11-11: Added card-level retrieval and board metadata; raised the hosted
  prompt budget to 24000 and removed the budget for local Ollama; added
  `KANBAN_ASK_INCLUDE_LOGS` redaction default.
