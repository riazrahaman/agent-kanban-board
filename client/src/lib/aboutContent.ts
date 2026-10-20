// Field Guide Nº 02 · The Agent Board — the About page's content module.
//
// Two layers live here on purpose:
//  1. A compact, code-derived 12-chapter ARTICLE (`CHAPTERS`, `ENV_VARS`) that
//     is the page's narrative. Every chapter names the real file it describes.
//  2. The data-driven reference blocks the page has always rendered
//     (`TRUST_METRICS`, `CAPABILITIES`, `STACK_ROWS`, the claim/reclaim/safety
//     flows, the orchestrator-skill entry, the tour plates). These are pinned
//     by `about.test.mjs` and `responsive.test.mjs`, so their shapes and the
//     code-location tokens inside them stay stable even as the prose around
//     them is rewritten.

// ---------------------------------------------------------------------------
// Links & the bundled orchestrator skill
// ---------------------------------------------------------------------------

export const ABOUT_GITHUB_URL =
  'https://github.com/riazrahaman/agent-kanban-board'

export const ABOUT_LIVE_URL = 'https://agent-kanban.riazrahaman.com'

export const SKILL_PATH = 'skills/kanban/SKILL.md'

export const SKILL_HUB_URL =
  'https://skills.syed-hasan.com/skills/riazrahaman/agentkanban'

export const SKILL_STANDALONE_REPO_URL =
  'https://github.com/riazrahaman/kanban-orchestrator'

export type OrchestratorSkill = {
  name: string
  summary: string
  path: string
  hubUrl?: string
  install: string[]
  notes: string[]
}

export const ORCHESTRATOR_SKILL: OrchestratorSkill = {
  name: 'kanban',
  summary:
    'A bundled opencode skill turns a coding agent into a strict orchestrator: it drives claim-first transitions over plain HTTP, dispatches builder / reviewer / tester workers, and never writes code itself. The board is the state machine; the skill is the protocol that drives it.',
  path: SKILL_PATH,
  hubUrl: SKILL_HUB_URL,
  install: [
    'npx @skillporthq/cli@latest add riazrahaman/agentkanban',
    'cp -r skills/kanban .opencode/skills/kanban',
    'cp -r skills/kanban ~/.config/opencode/skills/kanban',
  ],
  notes: [
    'Project scoping: ?project=<name> is mandatory on every task path.',
    'Claim to own, PATCH to move — never enter a stage with a status-only PATCH.',
    'Every PATCH sends expected_version; illegal moves 409, wrong roles 403.',
    'Documents the optional Telegram reclaim alerts the reaper fires on a reset card.',
    'Protocol synced: Ask-the-Board assistant, 2-stage graceful teardown, and ASCII ByteString headers.',
  ],
}

// ---------------------------------------------------------------------------
// Field-guide cover
// ---------------------------------------------------------------------------

export const FIELD_GUIDE = {
  kicker: 'Field Guide',
  edition: 'Nº 02',
  title: 'The Agent Board',
  blurb:
    'A hand-written tour of the running system: eight states, leases, the reaper, two very different 409s, and the credentials that decide who may touch a card.',
}

// One or two `font-serif italic` accent words are pulled out of the hero so the
// page can render them in the display face without splitting the string inline.
export const HERO = {
  before: 'The board is the ',
  accentOne: 'state machine',
  middle: '. Everything else just ',
  accentTwo: 'watches',
  after: '.',
  lede:
    'Agents claim work and advance one strict lifecycle over plain HTTP. The server enforces ownership, transitions and roles; humans get a live, auditable view without ever becoming the workflow engine.',
}

// ---------------------------------------------------------------------------
// Trust metrics (kept in lock-step with the real suite sizes — about.test.mjs
// counts the suites from the files and fails if these drift).
// ---------------------------------------------------------------------------

export type TrustMetric = {
  value: string
  label: string
  detail: string
}

export const TRUST_METRICS: TrustMetric[] = [
  {
    value: '678',
    label: 'server tests',
    detail: 'state machine, leases, auth, persistence',
  },
  {
    value: '299',
    label: 'client tests',
    detail: 'pure logic, theming, responsive contract',
  },
  {
    value: '20 & 22',
    label: 'Node CI matrix',
    detail: 'every push is built on both',
  },
  {
    value: '6',
    label: 'ADRs',
    detail: 'storage, git recovery, mutation serialization, 8-state workflow, credential-bound roles, deferred role-crossing toggle',
  },
]

// ---------------------------------------------------------------------------
// Why a human task board is not enough
// ---------------------------------------------------------------------------

export type WhyCard = {
  title: string
  body: string
  mechanism: string
}

export const WHY_CARDS: WhyCard[] = [
  {
    title: 'Two agents, one task',
    body: 'Without serialization both agents read the same unclaimed task, both validate it, and both write. One assignment silently overwrites the other.',
    mechanism: 'withMutationLock — every mutation is chained on one process-local promise queue',
  },
  {
    title: 'An agent disappears mid-task',
    body: 'A crashed or hung worker would otherwise hold a card hostage forever, and no one could tell whether work was actually happening.',
    mechanism: 'claim_expires_at lease + progress-stall check + reapExpiredClaims — a dead or stalled claim returns to READY',
  },
  {
    title: 'An agent skips the workflow',
    body: 'A rogue or buggy agent could jump a card straight to DONE, a builder could approve its own work, or a tester could ship what it only verified.',
    mechanism: 'canTransition + canRoleTransition — illegal moves 409; roles come from the credential and are forced server-side (403)',
  },
  {
    title: 'A task is silently reclaimed',
    body: 'A lease expiring is the system working correctly — but if nobody is told, a stalled agent looks exactly like a calm, healthy board.',
    mechanism: 'notifier.js — an onDiff subscriber posts a full-detail alert when the reaper returns a task to READY',
  },
]

// ---------------------------------------------------------------------------
// The 8-state lifecycle (ADR-004, server/state-machine.js)
// ---------------------------------------------------------------------------

export type LifecycleStep = {
  status: string
  actor: string
  detail: string
}

// `actor` is the role that moves a card INTO that state; only READY cards can be
// claimed, and a claim lands on PLANNING (planner) or IN_PROGRESS (others).
export const LIFECYCLE_STEPS: LifecycleStep[] = [
  {
    status: 'BACKLOG',
    actor: 'anyone',
    detail: 'captured and visible, but not yet claimable',
  },
  {
    status: 'READY',
    actor: 'planner',
    detail: 'the only claimable state; a claim takes the card under a lease',
  },
  {
    status: 'PLANNING',
    actor: 'planner',
    detail: 'a planner claim lands here; the plan is written before any code',
  },
  {
    status: 'IN_PROGRESS',
    actor: 'builder',
    detail: 'a builder claim lands here; the lease must be renewed with a heartbeat',
  },
  {
    status: 'IN_REVIEW',
    actor: 'builder',
    detail: 'work submitted; the builder hands it off',
  },
  {
    status: 'VALIDATION',
    actor: 'reviewer',
    detail: 'review approved; a different role owns verification',
  },
  {
    status: 'READY_TO_SHIP',
    actor: 'tester',
    detail: 'verified; a tester cannot close the card itself',
  },
  {
    status: 'DONE',
    actor: 'releaser',
    detail: 'released and closed; the terminal state',
  },
  {
    status: 'BLOCKED',
    actor: 'runner',
    detail: 'parked off the happy path; auto-returned to READY when its dependencies complete',
  },
]

// ---------------------------------------------------------------------------
// Capability index
// ---------------------------------------------------------------------------

export type Capability = {
  name: string
  code: string
}

export const CAPABILITIES: Capability[] = [
  { name: '8-state lifecycle state machine (v3)', code: 'state-machine.js · VALID_TRANSITIONS, canTransition' },
  { name: 'Role-gated transitions (planner → releaser)', code: 'state-machine.js · canRoleTransition' },
  { name: 'Lease ownership + heartbeat', code: 'store.js · applyClaim, renewLease; POST /api/agents/:agent_id/heartbeat' },
  { name: 'Background lease reaper', code: 'store.js · reapExpiredClaims, startReaper' },
  { name: 'Progress-stall reclaim', code: 'store.js · getProgressStallMs (KANBAN_PROGRESS_STALL_MS, 30 min default)' },
  { name: 'Orphan grace window', code: 'store.js · getOrphanGraceMs (KANBAN_ORPHAN_GRACE_MS)' },
  { name: 'Process-local mutation lock', code: 'store.js · withMutationLock (ADR-003)' },
  { name: 'Pluggable persistence', code: 'storage.js · JsonStorage | GitYamlStorage' },
  { name: 'Atomic writes + git audit trail', code: 'task-identity.js · writeAtomic; storage.js · serializeCard' },
  { name: 'Real-time push over SSE', code: 'server.js · GET /api/events' },
  { name: 'Periodic data backups', code: 'store.js · runBackup, backupStatus' },
  { name: 'Telegram alerts on reclaim', code: 'notifier.js · onDiff, formatReclaimMessage' },
  { name: 'Per-project token & project-name isolation', code: 'middleware/auth.js, routes/projects.js, routes/health.js' },
  { name: 'Credential-map coverage in health', code: 'utils/credentialMap.js · checkCredentialCoverage, GET /api/health' },
  { name: 'Rate limiting + auth-failure lockout', code: 'middleware/rateLimit.js · createRateLimitMiddleware' },
  { name: 'Reverse-proxy aware client IPs', code: 'server.js · resolveTrustProxy (KANBAN_TRUST_PROXY)' },
  { name: 'HMAC session tokens', code: 'sessionAuth.js, routes/auth.js' },
  { name: 'Optimistic concurrency (version + If-Match)', code: 'store.js · nextVersionFor, versionConflict' },
  { name: 'Admin delete + bulk purge', code: 'store.js · deleteTask, purgeTasks' },
  { name: 'Trash sink & restore', code: 'store.js · restoreFromTrash, hardDeleteFromTrash' },
  { name: 'Search & real-time quick filters', code: 'BoardFilters.tsx, lib/filterTasks.ts' },
  { name: 'Effort estimation badges', code: 'TaskCard.tsx' },
  { name: 'Live Metrics Dashboard summary', code: 'MetricsDashboard.tsx, lib/dashboardMetrics.ts' },
  { name: 'Board JSON Export', code: 'App.tsx, BoardFilters.tsx' },
  { name: 'Anonymous visit counter', code: 'App.tsx · lib/useVisitCount.ts' },
  { name: 'Custom column colors (per project)', code: 'routes/settings.js, lib/columnColors.ts' },
  { name: 'Task comments thread', code: 'store.js · addComment, POST /:id/comments' },
  { name: 'In-column sorting (persisted)', code: 'lib/boardSort.ts · priority | updated | id' },
  { name: 'DONE lane completion-recency sort', code: 'board-model.js · groupTasks (completed_at descending)' },
  { name: 'Inline title editing with optimistic CAS', code: 'TaskCard.tsx, api.ts · patchTask' },
  { name: 'Persisted audit stream', code: 'auditLog.js · appendAudit, GET /api/audit' },
  { name: 'Optional read auth + stream tickets', code: 'middleware/auth.js · KANBAN_READ_AUTH, streamTicket.js' },
  { name: 'Dependency & field validation', code: 'store.js · validateDependencyGraph; task-fields.js · validateMetadata' },
  { name: 'Fail-closed corrupt-store load', code: 'storage.js · JsonStorage.load' },
  { name: 'Readiness probe', code: 'routes/health.js · GET /api/health/ready' },
  { name: 'Anonymous "Report a bug" -> GitHub issue', code: 'routes/bugReports.js · POST /api/bug-reports, Turnstile-protected' },
  { name: 'Ask-the-Board assistant (OpenRouter & Ollama)', code: 'routes/ask.js, lib/ask.ts · POST /api/ask, GET /api/ask/config' },
  { name: 'Two-stage graceful teardown', code: 'server.js · drainSseStreams, registerShutdownHandlers' },
  { name: 'HTTP ByteString header sanitization', code: 'api.ts · sanitizeByteStringHeaders' },
  { name: 'Auto / Light / Dark theme', code: 'lib/theme.ts · resolveMode, nextMode' },
  { name: 'Phone layout: document scroll, pinch-zoom block', code: 'index.css · lib/scrollLock.ts, lib/pinchZoomGuard.ts' },
]

// ---------------------------------------------------------------------------
// Adoption FAQ (chapter 12)
// ---------------------------------------------------------------------------

export type FaqItem = {
  q: string
  a: string
}

export const FAQ: FaqItem[] = [
  {
    q: 'Do I need a database?',
    a: 'No. State persists to a single atomic JSON file by default, or to git-backed YAML (KANBAN_STORAGE_BACKEND=git). The pluggable storage factory leaves room for a database backend — a natural first contribution.',
  },
  {
    q: 'How will I know an agent died?',
    a: 'The reaper returns the card to READY and, when configured, notifier.js posts a full-detail alert — project, title, reclaim reason, who held it, when the lease ended and a deep link back to that project. Set KANBAN_TELEGRAM_BOT_TOKEN and KANBAN_TELEGRAM_CHAT_ID to switch it on; it is off by default.',
  },
  {
    q: 'How do I connect a new project?',
    a: 'There is no registration step. A project materialises the first time you post a task under its id; you give it out-of-band credentials via KANBAN_PROJECT_TOKENS — one role-bound token per agent role. Generate each credential value as 24 random hex bytes (openssl rand -hex 24 on macOS and Linux, the PowerShell RNGCryptoServiceProvider one-liner on Windows, or node -p "require(\'crypto\').randomBytes(24).toString(\'hex\')" anywhere). See ONBOARDING.md for the curl walkthrough and the field guide "Who May Write" chapter for the full commands per platform.',
  },
  {
    q: 'Can humans change task state?',
    a: 'By default the UI is a read-only observability viewport — the primary users are headless agents driving the board over HTTP. Humans watch, and can bind an api token to act as an agent.',
  },
  {
    q: 'Does it phone home?',
    a: 'No. The board itself is local-first: no accounts, no SaaS, no analytics — run it on localhost or self-host it. Only this hosted demo adds one thing: a single anonymous site-wide visit counter (one count per browser session, no per-visitor data) shown on this page.',
  },
  {
    q: 'How do I report a bug?',
    a: '"Report a bug" opens a short form — title, description, a Cloudflare Turnstile captcha — and files a labelled GitHub issue straight from the server. Off by default; an operator turns it on with KANBAN_REPORT_GITHUB_TOKEN, KANBAN_REPORT_REPO, TURNSTILE_SECRET and TURNSTILE_SITE_KEY (see README "Enabling Report-a-bug"). The same button lives in the header.',
  },
]

// ---------------------------------------------------------------------------
// Headless-first snippets
// ---------------------------------------------------------------------------

export const CLAIM_CURL = `curl -s -X POST "$BOARD/api/tasks/next-claim?project=$PROJECT&agent_id=builder-1" \\
  -H "Authorization: Bearer $BUILDER_TOKEN"   # the credential is bound to the builder role`

export const CURL_SNIPPET = `# an agent drives the board headlessly (claims READY -> IN_PROGRESS)
${CLAIM_CURL}

# every PATCH carries the card's current version (409 if stale) — and no role header:
# the role-bound credential decides, a self-declared X-Agent-Role cannot switch it
curl -s -X PATCH "$BOARD/api/tasks/$ID?project=$PROJECT" \\
  -H "Authorization: Bearer $BUILDER_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"status":"IN_REVIEW","expected_version":2}'

# humans just watch: the same state, live, over SSE`

// ---------------------------------------------------------------------------
// Workflow plates (back matter)
// ---------------------------------------------------------------------------

export type TourShot = {
  src: string
  alt: string
  caption: string
}

export const TOUR_SHOTS: TourShot[] = [
  {
    src: '/landing/board.png',
    alt: 'The board with the filter, sort and export toolbar, priority badges and stage-accents on every column',
    caption: 'The board — a live projection of server state, not the source of truth',
  },
  {
    src: '/landing/picker.png',
    alt: 'The project picker open, listing all projects',
    caption: 'Scope the board, the activity feed and auto-claim to one project',
  },
  {
    src: '/landing/task-sheet.png',
    alt: 'A task detail sheet showing priority and status badges, description, metadata, a comment thread and the agent log',
    caption: 'Every card carries its evidence: metadata, comments, per-stage owners and the agent log',
  },
  {
    src: '/landing/portfolio.png',
    alt: 'The portfolio view rolling every project into backlog, work-in-progress, blocked and done',
    caption: 'Portfolio control — throughput and exceptions across every project',
  },
  {
    src: '/landing/dark.png',
    alt: 'The same board rendered in a dark theme',
    caption: 'Same operational model, dark by explicit choice — not OS guesswork',
  },
]

// ---------------------------------------------------------------------------
// Stack table (back matter)
// ---------------------------------------------------------------------------

export type StackRow = {
  layer: string
  choice: string
  why: string
  location: string
}

export const STACK_ROWS: StackRow[] = [
  {
    layer: 'Client',
    choice: 'React 19 · Vite · TypeScript · Tailwind v4',
    why: 'An observability viewport, not the workflow engine.',
    location: 'client/src/',
  },
  {
    layer: 'Transport',
    choice: 'Express 5 (ESM, Node 20/22) + Server-Sent Events',
    why: 'Plain HTTP any agent can curl; SSE pushes live state to humans.',
    location: 'server/server.js',
  },
  {
    layer: 'Core engine',
    choice: 'One store: state machine + RBAC + leases + lock',
    why: 'A single serialization point is what makes contention deterministic.',
    location: 'server/store.js · state-machine.js',
  },
  {
    layer: 'Persistence',
    choice: 'Atomic JSON or git-backed YAML',
    why: 'Local-first, zero dependencies — and git becomes the audit trail.',
    location: 'storage.js · JsonStorage · GitYamlStorage',
  },
  {
    layer: 'Auth',
    choice: 'Static / per-project / HMAC session tokens',
    why: 'Fail-closed by default; per-project isolation on every write.',
    location: 'middleware/auth.js · sessionAuth.js',
  },
  {
    layer: 'Deploy',
    choice: 'One Node process + mounted disk',
    why: 'SSE and the reaper need a long-lived process — not serverless.',
    location: 'railway.json · render.yaml',
  },
]

// ---------------------------------------------------------------------------
// Code flows (folded into the chapters that explain them)
// ---------------------------------------------------------------------------

export type FlowStep = {
  label: string
  title: string
  detail: string
}

export const CLAIM_FLOW: FlowStep[] = [
  {
    label: '01',
    title: 'POST /api/tasks/next-claim arrives with an agent id and role.',
    detail: 'Agents ask for work; they never pick a card from the DOM.',
  },
  {
    label: '02',
    title: 'Auth middleware verifies the token and sets req.caller = {agent_id, role}.',
    detail: 'The role is authenticated, never taken from a query string.',
  },
  {
    label: '03',
    title: 'store.nextClaim() enters withMutationLock.',
    detail: 'Every write is chained on one process-local promise queue.',
  },
  {
    label: '04',
    title: 'Selects the highest-priority eligible READY task.',
    detail: 'Priority, then FIFO — and its dependencyGate must be satisfied.',
  },
  {
    label: '05',
    title: 'applyClaim writes the owner, the lease and the stage.',
    detail: 'Sets assigned_agent, claim_expires_at and the stage owner; lifts READY → IN_PROGRESS (PLANNING for a planner); bumps version.',
  },
  {
    label: '06',
    title: 'Persist first, then memory, then notify.',
    detail: 'writeAtomic (temp + rename) or a real git commit — the write lands on disk before memory changes.',
  },
  {
    label: '07',
    title: 'notify() pushes an SSE diff to every connected browser.',
    detail: 'Humans just watch; the board is a projection of server state.',
  },
]

export type SafetyLayer = {
  label: string
  name: string
  detail: string
}

export const SAFETY_LAYERS: SafetyLayer[] = [
  {
    label: 'A',
    name: 'Optimistic concurrency',
    detail: 'version + If-Match — a stale write is rejected 409.',
  },
  {
    label: 'B',
    name: 'Deterministic state machine',
    detail: 'canTransition → illegal move 409 · canRoleTransition → wrong role 403.',
  },
  {
    label: 'C',
    name: 'Lease ownership',
    detail: 'A live lease held by another owner → 409 already-claimed; an expired lease is reaped immediately, while an ownerless active card waits out a decoupled grace window (KANBAN_ORPHAN_GRACE_MS, fixed 300 s default) before it is normalized.',
  },
]

export const SAFETY_FOOTER =
  'All inside withMutationLock, then persist → update memory → notify over SSE. Persist first (KB-05): memory is never ahead of disk.'

export const RECLAIM_FLOW: FlowStep[] = [
  {
    label: '01',
    title: 'An agent stops heartbeating mid-task.',
    detail: 'The card stays PLANNING, IN_PROGRESS, IN_REVIEW or VALIDATION with a lease that is quietly running out.',
  },
  {
    label: '02',
    title: 'The background reaper sweeps expired and stalled claims.',
    detail: 'reapExpiredClaims runs on a timer: an expired lease, a held card with no progress for KANBAN_PROGRESS_STALL_MS (30 min default), or an ownerless active card past its grace window is reclaimed.',
  },
  {
    label: '03',
    title: 'reclaimTaskInner returns the card to READY.',
    detail: 'Owner and lease are cleared, reclaim_count increments and the version bumps — then the write is persisted first.',
  },
  {
    label: '04',
    title: 'notify() emits a reclaimed diff event.',
    detail: 'The same event stream that drives the browser carries { kind: reclaimed, reason, prevTask }.',
  },
  {
    label: '05',
    title: 'notifier.js formats a full-detail alert and posts it to Telegram.',
    detail: 'Project, title, reason, who held it, when the lease ended, stage owners, the last log and a deep link back to that project.',
  },
  {
    label: '06',
    title: 'Delivery is fail-silent.',
    detail: 'A Telegram outage is logged and swallowed — an alert that cannot be sent never breaks the reclaim that triggered it.',
  },
]

export const RECLAIM_INTRO =
  'A vanished agent is the failure the board is most opinionated about. Here is what actually happens, from a stalled heartbeat to a message in your phone.'

export const ARCH_LAYERS: FlowStep[] = [
  { label: '1', title: 'Client', detail: 'React viewport — no drag-and-drop, no workflow logic.' },
  { label: '2', title: 'Transport & security', detail: 'CORS allow-list, token auth, rate limiting, project scope.' },
  { label: '3', title: 'Routing', detail: 'server.js composes the routers and the SSE channel.' },
  { label: '4', title: 'Core engine', detail: 'store.js — state machine, RBAC, claims, reaper, mutation lock.' },
  { label: '5', title: 'State & events', detail: 'In-memory tasks[], diff/audit listeners, broadcast.' },
  { label: '6', title: 'Persistence', detail: 'writeAtomic into JSON or git YAML, pluggable via the storage factory.' },
]

export const ARCH_INTRO =
  'The capability table names the parts. This section shows how they fit together — the stack, the exact path a claim takes through the code, and the three layers that guard every write.'

// ---------------------------------------------------------------------------
// Chapter 9 — the architecture diagram
//
// The SVG itself is hand-authored in components/About.tsx (no mermaid, no
// external image, no build step). Only its accessible title/description and the
// short labels drawn on the arrows live here, so the prose stays data-driven.
// ---------------------------------------------------------------------------

export const ARCH_DIAGRAM = {
  title: 'The running system, end to end',
  desc:
    'Agents and the web board call the Express server over REST. A write walks the auth and rate-limit middleware into the core store, is persisted to disk before memory changes, then fans out over SSE to the browser and, optionally, to the Telegram notifier, signed webhooks and the audit log.',
}

export const ARCH_DIAGRAM_CALLOUTS = {
  rest: 'REST + token',
  sse: 'SSE diff',
  persist: 'persist-first',
  reaper: 'reaper every 30 s',
} as const

// ---------------------------------------------------------------------------
// The article: 13 chapters, each ELI5 → Under the hood → Real snippet → Gotcha
// ---------------------------------------------------------------------------

export type ChapterSnippet = {
  label: string
  code: string
}

export type Chapter = {
  id: string
  number: string
  emoji: string
  title: string
  eli5: string
  underTheHood: string
  snippet: ChapterSnippet
  gotcha: string
  /** Real file paths this chapter is written from (rendered as mono chips). */
  files: string[]
}

export const CHAPTERS: Chapter[] = [
  {
    id: 'states',
    number: '01',
    emoji: '🔄',
    title: 'Eight States',
    eli5:
      'A card is never "just opened". It walks one fixed path, and each step belongs to a different kind of worker.',
    underTheHood:
      'server/state-machine.js is the whole rulebook. VALID_TRANSITIONS lists the only legal edges for the eight canonical states plus BLOCKED; canTransition rejects anything else with a 409 and canRoleTransition rejects the wrong role with a 403. Input is normalised first, so the pre-v3 spellings — `todo`, `building`, `in_test` — resolve to BACKLOG, IN_PROGRESS and VALIDATION instead of failing.',
    snippet: {
      label: 'VALID_TRANSITIONS',
      code: `BACKLOG       -> READY, BLOCKED
READY         -> PLANNING, IN_PROGRESS, BACKLOG, BLOCKED
PLANNING      -> IN_PROGRESS, READY, BLOCKED
IN_PROGRESS   -> IN_REVIEW, PLANNING, BLOCKED
IN_REVIEW     -> VALIDATION, IN_PROGRESS, BLOCKED
VALIDATION    -> READY_TO_SHIP, IN_PROGRESS, BLOCKED
READY_TO_SHIP -> DONE, IN_PROGRESS, BLOCKED
BLOCKED       -> BACKLOG, READY, PLANNING, IN_PROGRESS, IN_REVIEW, VALIDATION
DONE          -> (terminal)`,
    },
    gotcha:
      'DONE is terminal — VALID_TRANSITIONS[DONE] is an empty list, so nothing moves a shipped card again. Corrections happen with a new card.',
    files: ['server/state-machine.js'],
  },
  {
    id: 'claims',
    number: '02',
    emoji: '⏱️',
    title: 'Claims & Leases',
    eli5:
      'Claiming a card is borrowing it with a timer. Keep checking in and it stays yours; stop checking in and the timer hands it back.',
    underTheHood:
      'A claim sets assigned_agent and arms claim_expires_at. Only a READY card can be claimed. The window is leaseWindowFor(task): a per-card claim_lease_ms if one was requested, otherwise KANBAN_CLAIM_TTL_MS (600000 ms). A requested window is clamped by resolveLeaseMs between KANBAN_MIN_LEASE_MS (60000) and KANBAN_MAX_LEASE_MS (7200000). Renewal only pushes the deadline out; a sibling lease renewal deliberately does NOT bump version, so it never invalidates a concurrent expected_version PATCH on a card nobody is editing.',
    snippet: {
      label: 'a claimed card on disk',
      code: `{
  "status": "IN_PROGRESS",
  "assigned_agent": "builder-1",
  "claim_expires_at": "2026-10-17T12:10:00.000Z",
  "claim_lease_ms": 600000,
  "last_progress_at": "2026-10-17T12:00:00.000Z"
}`,
    },
    gotcha:
      'last_progress_at is NOT touched by a sibling renewal — only a fresh claim or a real write advances it, which is exactly what lets the reaper tell "alive" apart from "working".',
    files: ['server/store.js'],
  },
  {
    id: 'reaper',
    number: '03',
    emoji: '🧟',
    title: 'The Reaper',
    eli5:
      'A background janitor sweeps dead or stalled claims back into the queue so one crashed agent cannot freeze a card forever.',
    underTheHood:
      'reapExpiredClaims in server/store.js runs on a timer and marks each active card with a reason: orphan_normalized (active but ownerless past its grace window), progress_stalled (a held card whose last_progress_at is older than KANBAN_PROGRESS_STALL_MS, 1800000 by default) or lease_expired. Each candidate goes through reclaimTaskInner, which clears owner and lease, bumps reclaim_count, raises the version and persists before emitting a reclaimed diff.',
    snippet: {
      label: 'reaper knobs & reasons',
      code: `KANBAN_PROGRESS_STALL_MS=1800000   # 30 min — 0 disables the stall check
KANBAN_REAP_INTERVAL_MS=30000      # sweep every 30 s
KANBAN_ORPHAN_GRACE_MS=300000      # grace for an ownerless active card

# reclaim reasons
'orphan_normalized' | 'progress_stalled' | 'lease_expired'`,
    },
    gotcha:
      'The reaper resets a card to READY — immediately claimable again — not to BACKLOG. Older comments once said BACKLOG; the code has returned cards to READY since ADR-004.',
    files: ['server/store.js'],
  },
  {
    id: 'conflicts',
    number: '04',
    emoji: '🧮',
    title: 'The Two 409s',
    eli5:
      'Two failures both answer with 409, and they mean opposite things: one says "your copy is old, retry", the other says "you lost the race, give up".',
    underTheHood:
      'A "Version mismatch" is a stale read: your expected_version no longer matches the stored one — re-read the card and retry with the fresh expected_version. A "Task … is already claimed by …" is contention: another agent holds a live lease, so retrying is pointless until it lapses. The claim path also tags some 409s with a machine-readable reason — dependency_unsatisfied, not_ready (still in BACKLOG), status_not_claimable, or claim_limit when the caller is already at KANBAN_MAX_CLAIMS_PER_AGENT — so an orchestrator can branch without parsing prose.',
    snippet: {
      label: '409 payloads',
      code: `// (a) stale read — retry with a fresh expected_version
{ "error": "Version mismatch",
  "details": { "expected": 7, "provided": 5 } }

// (b) lost the race — a live lease is held elsewhere
{ "error": "Task KB-12 is already claimed by builder-2" }

// (c) reason-tagged claim refusals
{ "reason": "dependency_unsatisfied" }  // unresolved depends_on
{ "reason": "not_ready" }               // still in BACKLOG
{ "reason": "status_not_claimable" }    // not READY, not active
{ "reason": "claim_limit" }             // at the per-agent cap`,
    },
    gotcha:
      'Treat them differently: retry a version mismatch (it is your bug), never hot-retry a claim loss (it is a race you lost) — wait for the holder or for the reaper.',
    files: ['server/store.js'],
  },
  {
    id: 'auth',
    number: '05',
    emoji: '🔐',
    title: 'Who May Write',
    eli5:
      'Every write carries a credential, and the credential decides which projects it may touch. What you claim to be in a header counts for nothing.',
    underTheHood:
      'server/middleware/auth.js resolves the request against KANBAN_ADMIN_TOKEN (spans every project), KANBAN_PROJECT_TOKENS (per-project credentials — a token only works for the projects it names, otherwise 403 "token is not authorized for project \'X\'", and each credential may be role-bound {"token":"…","role":"…"} so the server derives the role), an HMAC session token from KANBAN_AUTH_SECRET (revocable via jti), or the legacy global KANBAN_AUTH_TOKEN. The SSE stream cannot set headers, so it accepts a short-lived, single-use 60-second ticket. Malformed or missing config fails closed with a 503 rather than opening an unauthenticated write API.',
    snippet: {
      label: 'per-role credentials',
      code: `# one credential per agent role, bound in the token map
KANBAN_PROJECT_TOKENS={"alpha":{"credentials":[{"token":"tok-build","role":"builder"},{"token":"tok-review","role":"reviewer"}]}}

# never hand-write credential values — generate a random 192-bit value per role.
# macOS and Linux:
openssl rand -hex 24
# Windows PowerShell 7+:
[BitConverter]::ToString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).Replace('-','').ToLower()
# Windows PowerShell 5.1 (GetBytes is absent before .NET 6):
$b=[byte[]]::new(24);(New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b);[BitConverter]::ToString($b).Replace('-','').ToLower()
# anywhere Node runs — the only portable one-liner:
node -p "require('crypto').randomBytes(24).toString('hex')"

# a bound credential cannot impersonate another role — the header is ignored and audited
role_binding_mismatch: declared 'reviewer' conflicts with credential-bound role 'builder'`,
    },
    gotcha:
      'Privilege AND role come from the CREDENTIAL, never from the self-asserted X-Agent-Role header. A role-bound worker token cannot re-declare itself reviewer; a conflicting header is ignored and audited, and only legacy unbound tokens still honor the header.',
    files: ['server/middleware/auth.js'],
  },
  {
    id: 'storage',
    number: '06',
    emoji: '💾',
    title: 'Where Cards Live',
    eli5:
      'Cards live in a file, not in the browser. A write lands on disk before the server updates its memory, so a crash never loses committed work.',
    underTheHood:
      'server/storage.js offers two interchangeable backends behind one factory: KANBAN_STORAGE_BACKEND=json (the default — one partitioned atomic file per project) and git (one YAML card per task, one real commit per transition, so git becomes the audit trail). Writes go through an atomic temp-file-plus-rename, and the store persists before it mutates memory. If a JSON file exists but cannot be parsed, JsonStorage.load throws and the server refuses to boot rather than overwrite good data with an empty board.',
    snippet: {
      label: 'backend selection',
      code: `KANBAN_STORAGE_BACKEND=json   # default: one atomic JSON file per project
KANBAN_STORAGE_BACKEND=git    # one YAML card per task, one commit per write
KANBAN_DATA_DIR=/data         # named projects, archives and settings live here`,
    },
    gotcha:
      'Named projects (anything beyond the default) live under KANBAN_DATA_DIR — so the writable disk you mount must cover that directory, not just the tasks file.',
    files: ['server/storage.js'],
  },
  {
    id: 'alerts',
    number: '07',
    emoji: '📣',
    title: 'Reporting & Alerts',
    eli5:
      'Three optional channels let the humans find out what happened: file a bug, get a reclaim alert, or stream every change to another system.',
    underTheHood:
      'server/routes/bugReports.js turns an anonymous in-app report into a labelled GitHub issue, guarded by Cloudflare Turnstile, a honeypot field and peek-and-consume rate limits (a request that fails validation or the captcha never spends the budget). server/notifier.js posts a full-detail Telegram alert whenever the reaper returns a card to READY. server/webhooks.js POSTs a signed, machine-readable envelope for every committed mutation to one or more subscriber URLs.',
    snippet: {
      label: 'the three channels',
      code: `# 1. bug reports -> one GitHub issue (routes/bugReports.js)
POST /api/bug-reports   # Turnstile + honeypot + peek-and-consume caps

# 2. reclaim alerts (notifier.js) — OFF unless BOTH are set
KANBAN_TELEGRAM_BOT_TOKEN=...
KANBAN_TELEGRAM_CHAT_ID=...

# 3. signed outbound hooks (webhooks.js)
KANBAN_WEBHOOK_URLS=https://example.test/hook
KANBAN_WEBHOOK_SECRET=...`,
    },
    gotcha:
      'All three are off by default and fail-silent: a Telegram or webhook outage is logged and swallowed so it can never break the mutation or reclaim that triggered it.',
    files: ['server/routes/bugReports.js', 'server/notifier.js', 'server/webhooks.js'],
  },
  {
    id: 'client',
    number: '08',
    emoji: '🧭',
    title: 'The Client',
    eli5:
      'The browser opens one live stream and redraws from it. It never invents state of its own, and it can only claim through the same protocol an agent uses.',
    underTheHood:
      'client/src/App.tsx keeps ONE combined Server-Sent Events connection (mode=diff) and reconciles each event into its local array by the composite key (id, project) — task ids are unique only within a project. client/src/lib/useClaimCoordinator.ts is the single writer on the browser side: it heartbeats every card the bound agent holds and, when idle, pulls the next one with nextClaim (claim-first). Pure decisions live in lib/claimCoordinator.ts so they are unit-testable without a browser. Nothing in the client handles a redeploy: when the server shuts down it ENDS the stream rather than dropping the socket, which EventSource treats as a normal end and retries on its own schedule — straight onto the replacement container (chapter 9).',
    snippet: {
      label: 'one stream, one writer',
      code: `// App.tsx — one EventSource, reconciled by (id, project)
subscribeToBoard(applyDiff, applySettings, { project: scope })

prev.findIndex(
  (t) => t.id === evt.task.id && (t.project ?? '') === (evt.project ?? ''),
)

// useClaimCoordinator.ts — claim-first, then heartbeat
await heartbeatTask(task.id, who, { project: task.project })
const claimed = await nextClaim(who, { project: proj, role: 'builder' })`,
    },
    gotcha:
      'The UI is a projection — no drag-and-drop, no client-side workflow logic. State only ever changes through the API, so the board can never disagree with the server.',
    files: ['client/src/App.tsx', 'client/src/lib/useClaimCoordinator.ts'],
  },
  {
    id: 'solo',
    number: '09',
    emoji: '🚦',
    title: 'Solo-Run Marks',
    eli5:
      'Every card carries a small colored dot: green means two or more agents covered its stages, amber means one agent walked most of it alone, red means one agent walked it all — and shipped its own work.',
    underTheHood:
      'client/src/lib/ownership.ts derives the mark READ-SIDE from stage_owners alone — no server schema changed when this shipped in v3.8.0. It collects the agents recorded per active stage (legacy spellings `building`/`in_test` alias back to IN_PROGRESS/VALIDATION), normalizes ids for counting (case and whitespace), and thresholds the distinct count: one agent holding 2–3 active stages is amber, four or more is red. The mark is a property of the card’s whole ownership history, so it shows in every lane — including DONE, where self-approval evidence matters most — and cards with at most one held stage stay unmarked. The toolbar’s green/amber/red bubbles filter on it (multi-select, persisted per client), and the dot’s tooltip spells out the walk: who held which stage.',
    snippet: {
      label: 'thresholds (client/src/lib/ownership.ts)',
      code: `agents >= 2                 -> green   # separation held across the walk
agents == 1 && stages <= 3  -> amber   # solo-run: no independent pair-break
agents == 1 && stages >= 4  -> red     # solo-run severe: built, reviewed,
                                       # validated and/or closed its own work
stages <= 1                 -> none    # too little history to judge

# filter bar (BoardFilters): green/amber/red bubbles + reset,
# persisted per client in localStorage under kanban.filters`,
    },
    gotcha:
      'The dot reports the WALK, not a verdict. Orchestrators and CI runners legitimately hold several roles; a red dot is a review prompt for a human, not an accusation — pair it with the role_binding_mismatch audit (chapter 5) for the enforced version of the same discipline.',
    files: [
      'client/src/lib/ownership.ts',
      'client/src/components/SeverityDot.tsx',
      'client/src/components/BoardFilters.tsx',
    ],
  },
  {
    id: 'architecture',
    number: '10',
    emoji: '🏗️',
    title: 'Architecture',
    eli5:
      'Every request walks the same corridor: authenticated, rate-limited, routed to one store, written to disk before memory, and only then pushed out to whoever is watching.',
    underTheHood:
      'server/server.js composes the process in a fixed order — CORS, express.json and the trust-proxy setting, then the pre-auth routes (/api/auth, /api/bug-reports, and /api/ask with its own password gate), then the auth middleware (middleware/auth.js) and the rate limiter (middleware/rateLimit.js), then the routers (tasks.js, agents.js, projects.js, metrics.js, settings.js, milestones.js, audit.js, health.js) and the SSE channel GET /api/events. Every mutation funnels into server/store.js and its siblings — state-machine.js (the eight states plus canRoleTransition), task-fields.js, task-identity.js and storage.js — through withMutationLock, the one serialized write path. A claim is applyClaim; leases and stalls are swept by the reaper. The write is persisted first — JsonStorage via an atomic temp-file-plus-rename, or GitYamlStorage with one YAML card per task and one commit per transition — under the mounted disk KANBAN_DATA_DIR; only then does memory change and the onDiff / onChange / onAudit bus fire. That bus drives SSE to the browser plus the optional notifier.js (Telegram), webhooks.js and auditLog.js (audit.jsonl). Teardown runs that corridor backwards, and the order is load-bearing: registerShutdownHandlers catches SIGTERM, drainSseStreams ends every open /api/events response FIRST, and only then does server.close() run. Closing first would wait for exactly the connections that never end by themselves — a browser tab holds its stream open for as long as it is open — so before v3.5.1 the process never finished shutting down and was killed five seconds later by its host.',
    snippet: {
      label: 'server/server.js — mount order, and the teardown that mirrors it',
      code: `cors -> express.json -> trust proxy
  -> /api/auth  /api/bug-reports  /api/ask   # pre-auth
  -> auth middleware -> rate limit
  -> /api/tasks /agents /projects /metrics
     /settings /milestones /audit /health
  -> GET /api/events                        # SSE, mode=diff

SIGTERM
  -> drainSseStreams()        # res.end() every open stream
  -> server.close()           # now it can actually finish
  -> closeIdleConnections()   # in-flight requests are spared
  -> exit(0)                  # "closed cleanly in 1ms"`,
    },
    gotcha:
      'A storage failure never advances in-memory state. The store persists first, so a disk error leaves the card untouched and emits no SSE diff — memory is never ahead of disk.',
    files: [
      'server/server.js',
      'server/store.js',
      'server/state-machine.js',
      'server/storage.js',
      'client/src/App.tsx',
    ],
  },
  {
    id: 'config',
    number: '11',
    emoji: '⚙️',
    title: 'Configuration',
    eli5:
      'Everything that changes how the board behaves is an environment variable. Set none and you get a safe, local, single-token board.',
    underTheHood:
      'The server reads its configuration from the environment at call time, so tests and redeploys can change behaviour without a code change. Secrets are server-only — they are never inlined into the client bundle (the client stores its one write token in localStorage rather than a build-time env var). A feature whose prerequisite secrets are unset stays off: Ask-the-Board, reclaim alerts and bug reports are all fail-closed by default.',
    snippet: {
      label: 'docs/CONFIGURATION.md is generated',
      code: `# regenerate the reference table from the code
node scripts/gen-config-reference.mjs`,
    },
    gotcha:
      'Prefer the per-project tokens over the legacy global KANBAN_AUTH_TOKEN: the global token opens every project and lets one agent re-declare any role per request — exactly what per-project role-bound credentials exist to prevent.',
    files: ['docs/CONFIGURATION.md', 'scripts/gen-config-reference.mjs'],
  },
  {
    id: 'ask',
    number: '12',
    emoji: '💬',
    title: 'Ask the Board',
    eli5:
      'A password-locked assistant that answers questions about this board: it retrieves excerpts from the repository, so it can explain the code itself as well as the protocol, alongside a live read-only snapshot.',
    underTheHood:
      'GET /api/ask/config reports whether the feature is on; POST /api/ask takes { question } behind an x-ask-pass password header. server/routes/ask.js is mounted before the auth middleware (like bug reports) but is gated by its own shared password and its own rate limits: a global per-day cap, a per-IP per-hour cap, and a separate wrong-password counter. It supports both OpenRouter and local Ollama (e.g. qwen3.6:latest via Cloudflare/Tailscale tunnels), omitting max_tokens on local reasoning models to prevent truncated thought chains. It never reads or writes the board — the only board data it sees is an in-process snapshot — and the model never claims, moves or deletes a card, and never sees a token.',
    snippet: {
      label: 'the ask surface',
      code: `GET  /api/ask/config   -> { "enabled": true, "gated": true, "provider": "ollama", "model": "..." }

POST /api/ask
  x-ask-pass: <password>
  { "question": "Why do claims expire?" }
  -> { "answer": "...", "model": "..." }`,
    },
    gotcha:
      'The scope limit is a prompt instruction, not a hard fence: the assistant is instructed to stay on topic, but it is the same model answering, so treat an off-topic reply as expected behaviour rather than a security bug.',
    files: ['client/src/lib/ask.ts', 'server/routes/ask.js'],
  },
  {
    id: 'faq',
    number: '13',
    emoji: '❓',
    title: 'FAQ',
    eli5:
      'The questions people ask before they trust a board their coding agents will drive.',
    underTheHood:
      'These answers are derived from the same code the rest of this guide describes. The two that matter most are storage (there is no database — state is a file) and liveness (a dead agent is detected by the lease and announced by the notifier, both configurable).',
    snippet: {
      label: 'the shortest honest summary',
      code: `local-first · headless-first · no accounts
no tracking · one Node process + a mounted disk
enforced server-side: transitions, roles, leases, versions`,
    },
    gotcha:
      'If an answer here ever disagrees with the code, the code wins — this page is generated by hand from the source, and the source is the contract.',
    files: ['docs/CONFIGURATION.md'],
  },
]

// ---------------------------------------------------------------------------
// Chapter 10 — the configuration table
// ---------------------------------------------------------------------------

export type EnvVar = {
  name: string
  purpose: string
}

export const ENV_VARS: EnvVar[] = [
  { name: 'KANBAN_PROJECT_TOKENS', purpose: 'Per-project credentials with optional role binding ({"token","role"} — the role is forced server-side); a token only works for the projects it names.' },
  { name: 'KANBAN_ADMIN_TOKEN', purpose: 'Privileged token that spans every project (audited as admin_write).' },
  { name: 'KANBAN_AUTH_TOKEN', purpose: 'Legacy global shared token gating every mutating request (opens every project — prefer per-project tokens).' },
  { name: 'KANBAN_AUTH_SECRET', purpose: 'HMAC secret that enables stateless, revocable session tokens.' },
  { name: 'KANBAN_READ_AUTH', purpose: 'Set to "token" to require auth on reads and SSE (single-use stream tickets).' },
  { name: 'KANBAN_CLAIM_TTL_MS', purpose: 'Default lease window for a claimed task, in ms (default 600000 = 10 min).' },
  { name: 'KANBAN_MIN_LEASE_MS', purpose: 'Lower bound a per-task lease request is clamped to (default 60000).' },
  { name: 'KANBAN_MAX_LEASE_MS', purpose: 'Upper bound a per-task lease request is clamped to (default 7200000).' },
  { name: 'KANBAN_PROGRESS_STALL_MS', purpose: 'No-progress timeout before a held card is reaped (default 1800000; 0 disables).' },
  { name: 'KANBAN_REAP_ENABLED', purpose: 'Set falsy to disable the background lease reaper.' },
  { name: 'KANBAN_STORAGE_BACKEND', purpose: 'Persistence backend: "json" (default) or "git" (one YAML card per task).' },
  { name: 'KANBAN_DATA_DIR', purpose: 'Directory for named-project data, archives and settings.' },
  { name: 'KANBAN_ASK_PROVIDER', purpose: 'LLM provider for Ask-the-Board: "openrouter" or "ollama" (auto-detected if unset).' },
  { name: 'KANBAN_ASK_OPENROUTER_API_KEY', purpose: 'Secret OpenRouter key — required only for the "openrouter" provider, which is the default.' },
  { name: 'KANBAN_ASK_OLLAMA_HOST', purpose: 'Base URL for Ollama instance (default http://localhost:11434).' },
  { name: 'KANBAN_ASK_OLLAMA_AUTH_HEADER', purpose: 'Optional secret token for Ollama / reverse-proxy gateway.' },
  { name: 'KANBAN_ASK_PASSWORD', purpose: 'Secret shared password gate for POST /api/ask.' },
  { name: 'KANBAN_ASK_MODEL', purpose: 'Model id for Ask-the-Board (default openai/gpt-oss-20b for OpenRouter, qwen3.6:latest for Ollama).' },
  { name: 'KANBAN_ASK_DAILY_CAP', purpose: 'Global Ask-the-Board answers cap per UTC day (default 50).' },
  { name: 'KANBAN_ASK_PER_IP_PER_HOUR', purpose: 'Per-IP Ask-the-Board answers cap per hour (default 3).' },
  { name: 'KANBAN_ASK_TIMEOUT_MS', purpose: 'Upstream request timeout for Ask-the-Board, in ms (default 45000).' },
  { name: 'KANBAN_ASK_MAX_PROMPT_TOKENS', purpose: 'System-prompt token budget for Ask-the-Board (default 6000).' },
  { name: 'KANBAN_ASK_MAX_OUTPUT_TOKENS', purpose: 'Max completion tokens for one Ask-the-Board answer (default 1500).' },
]

// ---------------------------------------------------------------------------
// Chapter 11 — the Ask card copy
// ---------------------------------------------------------------------------

export const ASK_UNCONFIGURED_NOTE =
  'Ask-the-Board is off on this deployment. An operator switches it on by setting KANBAN_ASK_PASSWORD — always required — plus one engine: KANBAN_ASK_OPENROUTER_API_KEY for a hosted model, or KANBAN_ASK_PROVIDER=ollama (or just KANBAN_ASK_OLLAMA_HOST, which selects Ollama on its own when no OpenRouter key is set) for a local one.'

export const ASK_SCOPE_NOTE =
  'The assistant is instructed to stay on this board — its protocol, engine, client, deployment, configuration and source. Answers are read-only; it can never claim, move or delete a card.'

// ---------------------------------------------------------------------------
// Video Walkthrough
// ---------------------------------------------------------------------------

export type VideoChapter = {
  time: number
  label: string
  timestamp: string
}

export type VideoWalkthrough = {
  title: string
  subtitle: string
  badge: string
  description: string
  src: string
  poster: string
  duration: string
  chapters: VideoChapter[]
}

export const VIDEO_WALKTHROUGH: VideoWalkthrough = {
  title: 'The System in Motion',
  subtitle: 'Setup, usage, and the machinery underneath',
  badge: 'VIDEO FIELD GUIDE · 24 MIN',
  description:
    'An end-to-end architectural tour: why human boards fail concurrent agents, the eight strict states, role-gated leases, the background reaper, the mutation lock corridor, and real receipts.',
  src: '/media/kanban-video.mp4',
  poster: '/media/kanban-video-poster.jpg',
  duration: '24:06',
  chapters: [
    { time: 0, timestamp: '00:00', label: 'Cold Open (The Failure)' },
    { time: 64, timestamp: '01:04', label: 'Why Not a Human Board' },
    { time: 171, timestamp: '02:51', label: 'Setup & Deployment' },
    { time: 374, timestamp: '06:14', label: 'The Eight States' },
    { time: 488, timestamp: '08:08', label: 'Role Ownership' },
    { time: 534, timestamp: '08:54', label: 'Claims & Leases' },
    { time: 627, timestamp: '10:27', label: 'The Orchestrator Skill' },
    { time: 765, timestamp: '12:45', label: 'The Request Corridor' },
    { time: 792, timestamp: '13:12', label: 'The Mutation Lock' },
    { time: 910, timestamp: '15:10', label: 'The Reaper & Recovery' },
    { time: 1066, timestamp: '17:46', label: 'Solo-Run Marks' },
    { time: 1306, timestamp: '21:46', label: 'The Receipts & Architecture' },
  ],
}
