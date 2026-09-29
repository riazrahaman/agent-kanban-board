# Changelog

All notable changes to the `kanban-orchestrator` skill are documented here.
This project follows [Semantic Versioning](https://semver.org/).

Release tags are available on [GitHub Releases](https://github.com/riazrahaman/kanban-orchestrator/releases).

> **Version numbering.** From `2.14.3` on, the skill's version matches its
> [SkillPort listing](https://skills.syed-hasan.com/skills/riazrahaman/agentkanban).
> Earlier SkillPort versions map to the GitHub releases below:
> SkillPort `2.14.2` = `v1.0.0` (commit `09f4f90`), SkillPort `2.14.3` = `v1.2.0` (commit `cf01541`).
> `v1.1.0` was not published on SkillPort. Skill versions are independent of
> [agent-kanban-board](https://github.com/riazrahaman/agent-kanban-board) versions;
> board compatibility is listed in each entry.

## [2.14.6] — 2026-09-29

Protocol schema alignment and dynamic versioning guidance.

### Added
- **POST /tasks Required Schema**: Explicitly documented mandatory caller-supplied `id` (slug), `status: "BACKLOG"`, and `round: 1` in `SKILL.md` Stage A. Documented that work statuses (`BUILDING`, `IN_REVIEW`, etc.) require privileged roles and return `403`.
- **Dynamic Versioning & 409 Error Inspection**: Documented that `expected_version` must be re-read before each `PATCH` because intermediate `claim`, `logs`, and `heartbeat` calls increment card versions on the server. Added distinct handling for `409 Version mismatch` (retry with fresh version) vs `409 Invalid state transition` (lease expired and reaped; re-claim card).

### Fixed
- **Plural Install Path**: Corrected install paths in `SKILL.md` and `README.md` to `.opencode/skills/kanban-orchestrator/` (plural).

## [2.14.4] — 2026-09-28

Human-facing overview and docs structure.

### Changed
- Rewrote `README.md` as human-facing overview with visual architecture diagrams and clear stage workflows.

## [2.14.3] — 2026-09-28

Version renumbering only. The protocol is unchanged from `1.2.0`.

### Changed
- Skill frontmatter `version` set to `2.14.3` to match the SkillPort listing.
- Compatible with upstream `agent-kanban-board` `v2.14.0` through `v2.15.1+`.

## [1.2.0] — 2026-09-28

Protocol alignment with [agent-kanban-board](https://github.com/riazrahaman/agent-kanban-board) v2.15.1.

### Added
- **GitHub Issue Lifecycle**: Integrated formal GitHub issue tracking into Stage A (issue creation or linking via `"issues": ["#<N>"]`) and Stage C (issue resolution and closure via `gh issue close`).
- **Release Tagging & Deployment Verification**: Added step-by-step release tagging (`git tag -a`) and production deployment verification (`railway status` and health checks) to Stage C closure protocol.
- **Lockstep Documentation & Versioning**: Formalized lockstep version bumping across README, docs, and CHANGELOG.

### Changed
- Updated skill frontmatter version to `1.2.0`.
- Documented compatibility with upstream `agent-kanban-board` through `v2.15.1+`.

## [1.1.0] — 2026-09-27

Protocol alignment with [agent-kanban-board](https://github.com/riazrahaman/agent-kanban-board) v2.14.3.

### Added
- **Changelog**: Introduced `CHANGELOG.md` for tracking skill protocol and documentation updates.
- **Compatibility Documentation**: Documented compatibility with upstream `agent-kanban-board` v2.14.0+ through v2.14.3+.

### Changed
- Aligned skill protocol documentation with upstream `v2.14.3`, including branch normalization rules and Telegram reclaim alert mechanisms.
- Updated `README.md` with links to changelog and upstream board releases.

## [1.0.0] — 2026-09-26

Initial standalone release of the `kanban-orchestrator` skill.

### Added
- **Protocol Specification**: Standalone `SKILL.md` orchestrator protocol for OpenCode coding agents driving `agent-kanban-board`.
- **Automatic Local Deployment**: Automated local clone, build, and run instructions if no remote board URL is configured.
- **Role-based Lifecycle**: Step-by-step workflow covering claim-first `BUILDING`, `IN_REVIEW`, `IN_TEST`, and `DONE` stages.
- **Safety Rules**: Enforces optimistic locking with `expected_version`, heartbeats, and per-claim lease windows.
