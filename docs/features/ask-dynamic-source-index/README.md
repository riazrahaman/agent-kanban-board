# Ask the Board Dynamic Source Index Feature Tracking

## Current Status

Shipped in **v3.12.0**. Source retrieval for Ask-the-Board used to be limited to
the files named in a hand-curated map; a module that was not in that map was
invisible even when the question named one of its exports. Retrieval now runs
against a cached index of `server/`, `client/src/` and `scripts/`, so any real
module can be found by symbol, route path, path segment or topic. No API, data
model or configuration change; no migration.

## Source Of Truth

- Index, scoring and ranking: `server/askKnowledge.js`
  (`collectSourcePaths`, `buildSourceIndex`, `getSourceIndex`,
  `scoreSourceEntry`, `rankSourceFiles`, `resetSourceIndex`)
- Curated hints and head-anchoring: `FILE_MAP` / `FILE_MAP_BY_PATH` in the same
  file
- Contract tests: `server/test/kanban.ask.test.js` (`ask: source-code retrieval`)
- Operator docs: `README.md` §Ask the Board,
  `docs/USER_AND_OPERATOR_MANUAL.md` §3.1.2, `docs/HANDOVER.md` §7

## Current Behavior

- **Indexed roots.** `server/`, `client/src/` and `scripts/`, limited to
  `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`. The walk skips `node_modules`,
  `dist`, `build`, `coverage`, `.git`, `data`, `spill`, `test`, `tests`,
  `__tests__` and dot-directories, plus `*.test.*` / `*.spec.*` files.
- **Index contents per file.** Path, curated note (when one exists), head flag,
  folded full text (lazily filled), extracted exported symbols, extracted route
  paths, and the file mtime already cached by `readSourceFile`.
- **Cache.** Built on first question and reused for 60 s (`SOURCE_INDEX_TTL_MS`);
  bounded by 600 files (`SOURCE_INDEX_MAX_FILES`), 12 MB total
  (`SOURCE_INDEX_MAX_TOTAL_CHARS`) and 500 KB per file
  (`SOURCE_INDEX_MAX_FILE_CHARS`). `resetSourceIndex()` is a test seam.
- **Scoring.** A path segment match, an exact symbol, a route path or a curated
  note is a *strong* signal. Content keyword density qualifies on its own only
  at two or more hits, so an off-topic question still retrieves nothing.
  Documentation outside the indexed trees ranks at half weight, so behaviour
  questions prefer code over prose. The assistant's own file is never scored
  for body/symbol/route hits.
- **Curated map is a hint layer.** `FILE_MAP` notes now score higher than
  content hits (so `server/store.js` beats an About-page paragraph about the
  reaper), and `head: true` entries such as `CHANGELOG.md` keep their
  head-anchored excerpt. Entries outside the indexed trees (README, CHANGELOG,
  docs) are still candidates.
- **Output.** `rankSourceFiles` keeps its previous shape —
  `{ path, note, head, score }`, sorted by score then path, capped at `maxFiles`
  (default 3). `gatherSourceContext` is unchanged: verbatim excerpts, 12 000
  chars per file, 20 000 chars total.

## Decisions

- **Scan the tree, not a list.** A curated file list is a maintenance tax that
  fails silently: a new module is simply never retrievable. Symbol extraction
  and keyword density make coverage a property of the repository.
- **Keep the curated notes.** They encode operator knowledge ("the reaper lives
  here") that a raw symbol scan cannot infer, so they stay as a weighted hint
  rather than being deleted.
- **Exclude tests and fixtures.** Indexing `server/test/` would let a fixture or
  a fake store be quoted as live behaviour; the exclusion is part of the
  contract, not an optimisation.
- **Fail closed on weak matches.** Requiring a strong signal or two content hits
  preserves the "off-topic questions retrieve nothing" guarantee, which is what
  keeps the assistant from padding an answer with irrelevant code.
- **Cache for 60 s, not forever.** The index is rebuilt on the next question
  after a deploy or an edit, which keeps answers current without re-reading the
  tree on every request.

## Known Risks

- **Stale excerpts within the TTL.** A file edited during the 60 s window can be
  quoted from the previous build; `readSourceFile`'s mtime cache is refreshed on
  the next rebuild.
- **Large repositories.** The 600-file / 12 MB caps bound memory and build time
  but silently stop indexing beyond the limit. The current repository is well
  inside both.
- **Symbol extraction is regex-based.** It recognises `function`, `const`/`let`/
  `var` assignments, `class`, `export { … }` lists and router calls; a symbol
  produced dynamically or via a default-export alias may only be reachable by
  path or content.
- **Ranking is heuristic.** A question that shares vocabulary with prose can
  still rank a doc above a module; the half-weight rule reduces, not removes,
  that.

## Changelog

- 2026-11-11: Replaced curated-only retrieval with a cached, symbol- and
  route-aware index of `server/`, `client/src/` and `scripts/`; tests and
  fixtures excluded; curated notes retained as weighted hints.
