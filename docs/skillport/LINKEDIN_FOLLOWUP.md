# LinkedIn follow-up — kanban-orchestrator on SkillPort

Follow-up to: https://www.linkedin.com/posts/rahamanriaz_ai-agenticai-opensource-activity-7508243086104297472-_asP

**Tagging:** LinkedIn won't tag from a pasted URL. Where the post says `@Syed Hasan`, delete it, type `@Syed Hasan`, and choose the profile at linkedin.com/in/syedhasan-uae from the dropdown.

---

## Post

I left something out of my Agent Kanban Board post a few days back: the part that lets an agent actually drive it.

The board is the state machine. The skill is the protocol that drives it.

kanban-orchestrator is an agent skill that turns your coding agent into a strict orchestrator:

→ It never writes code itself.
→ It claims a card before touching it, holds a lease, and sends heartbeats to keep it.
→ It hands work to builder → reviewer → tester, and moves the card only on evidence: test output, a commit hash.
→ If a worker dies mid-build, the lease runs out and the card goes back to BACKLOG on its own.
→ After three failed cycles it stops and tells you why, instead of looping forever.

It's now live and Verified on SkillPort 👇
https://skills.syed-hasan.com/skills/riazrahaman/agentkanban

Why I'm pointing you to SkillPort rather than just a repo:

A skill is a set of instructions your agent follows with your permissions. A directive hidden in an HTML comment or a zero-width character slips past a human reader, but the agent still reads it.

SkillPort scans every skill for hidden instructions, dangerous commands and injection payloads. Then a human reviews it, and the verdict applies to that exact version only. Every new version is rescanned and reviewed again before it's published. The installer checks the package's sha256 before it extracts anything.

It was built by @Syed Hasan, using AI, for AI skills. Thank you for building the trust layer this space has been missing.

Install (free sign-in for an API key):
npx @skillporthq/cli@latest add riazrahaman/agentkanban

Skill source (MIT): https://github.com/riazrahaman/kanban-orchestrator
Board: https://github.com/riazrahaman/agent-kanban-board

#AI #AgenticAI #OpenSource #AIAgents #AgentSkills

---

## Comment for the original post

Closes the loop for anyone who finds the first post later:

> Follow-up: the orchestrator skill that drives this board is now Verified on SkillPort → <link to the new post>
