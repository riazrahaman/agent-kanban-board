# CLAUDE.md

Agent Kanban Board: a Kanban state dashboard for swarms of autonomous AI agents.
Agents claim tasks and move them through a state machine over an HTTP API; humans
watch live over SSE. Node/Express server + Vite/React 19/Tailwind v4/TS client.

**The canonical, harness-neutral agent guide is [`AGENTS.md`](AGENTS.md) - read
it first.** It carries the commands (`npm --prefix server install`,
`npm --prefix client install`, `npm start`, `npm run build`, `npm test`,
`make sec`, single-test invocations), the CI/quality gates, the architecture,
the release discipline, the owner decisions that must not be re-litigated, and
the skill distribution rule. Nothing in this file overrides it.

Claude-specific notes:

- `docs/presentation/index.html` is the same walkthrough as
  `docs/PRESENTER_RUNBOOK.md`, published as a claude.ai Artifact. It is
  version-pinned by `server/test/kanban.version.test.js`, so a release bumps it
  in the same commit as the runbook and the deck.
- The orchestration skill is listed on SkillPort
  (`skills.syed-hasan.com/skills/riazrahaman/agentkanban`). Its source of truth
  is `skills/kanban/SKILL.md` (+ `skills/kanban/README.md`) in this repo; sync
  installed Claude skill copies from here on release, never edit them in place.

Quick check that the tree is sane:

```bash
npm test
```
