# CLAUDE.md

Project-level notes for agents working in this repository. For the full
contributor/operator picture see README.md, DESIGN.md, and
docs/CONFIGURATION.md; this file is deliberately short.

## Workflow notes

- **Report-a-bug (v2.16.0+) touches several places at once.** If you change
  anything about `server/routes/bugReports.js`, also check:
  `server.js` (mount order — it must stay ahead of the auth/rate-limit
  middleware), `scripts/gen-config-reference.mjs` + `.env.example` (every new
  `process.env.KANBAN_*`/`TURNSTILE_*` var needs a `DESCRIPTIONS` entry and an
  `.env.example` line, enforced by `server/test/kanban.config.test.js`),
  `client/src/lib/bugReport.ts` (keep the client-side validation limits in
  sync with the server's), and `client/src/lib/aboutContent.ts`'s
  `TRUST_METRICS` test-count pair (enforced by `about.test.mjs`).
- **Never commit a real secret.** `.env.example` and any docs/README snippets
  use placeholders or Cloudflare's published Turnstile *test* keys only
  (`1x...AA` / `2x...AA` / `3x...AA` secrets, `1x...AA` site key) — never a
  real `KANBAN_REPORT_GITHUB_TOKEN`, `TURNSTILE_SECRET`, or real site key.
- **Version bumps are lockstep, not optional.** See README.md "Releasing":
  `server/package.json` + root `package.json` + a new CHANGELOG.md section +
  the version headers in `docs/` and `docs/with-images/` +
  `skills/kanban/SKILL.md` frontmatter, all in the same commit sequence as the
  user-visible change.
