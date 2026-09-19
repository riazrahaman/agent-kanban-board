export const ABOUT_GITHUB_URL =
  'https://github.com/riazrahaman/agent-kanban-board'

export const ABOUT_LIVE_URL = 'https://agent-kanban.riazrahaman.com'

export type TrustMetric = {
  value: string
  label: string
  detail: string
}

export const TRUST_METRICS: TrustMetric[] = [
  {
    value: '181',
    label: 'server tests',
    detail: 'state machine, leases, auth, persistence',
  },
  {
    value: '48',
    label: 'client tests',
    detail: 'pure logic, theming, responsive contract',
  },
  {
    value: '20 & 22',
    label: 'Node CI matrix',
    detail: 'every push is built on both',
  },
  {
    value: '3',
    label: 'ADRs',
    detail: 'storage, git recovery, mutation serialization',
  },
]

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
    mechanism: 'claim_expires_at lease + reapExpiredClaims — expired claims return to BACKLOG',
  },
  {
    title: 'An agent skips the workflow',
    body: 'A rogue or buggy agent could jump a card straight to DONE, or a builder could approve its own work.',
    mechanism: 'canTransition + canRoleTransition — illegal moves 409, wrong roles 403, enforced server-side',
  },
]

export type LifecycleStep = {
  status: string
  actor: string
  detail: string
}

export const LIFECYCLE_STEPS: LifecycleStep[] = [
  {
    status: 'BACKLOG',
    actor: 'unclaimed',
    detail: 'queued and visible; any eligible agent can take it',
  },
  {
    status: 'BUILDING',
    actor: 'builder',
    detail: 'claimed under a lease that must be renewed with a heartbeat',
  },
  {
    status: 'IN_REVIEW',
    actor: 'builder',
    detail: 'work submitted; the builder hands it off',
  },
  {
    status: 'IN_TEST',
    actor: 'reviewer',
    detail: 'review approved; a different role owns verification',
  },
  {
    status: 'DONE',
    actor: 'tester',
    detail: 'verified and closed; the terminal state',
  },
  {
    status: 'BLOCKED',
    actor: 'runner',
    detail: 'parked off the happy path; auto-unblocked when dependencies complete',
  },
]

export type Capability = {
  name: string
  code: string
}

export const CAPABILITIES: Capability[] = [
  { name: 'Strict lifecycle state machine', code: 'store.js · VALID_TRANSITIONS, canTransition' },
  { name: 'Role-gated transitions', code: 'store.js · canRoleTransition' },
  { name: 'Lease ownership + heartbeat', code: 'store.js · applyClaim, renewLease' },
  { name: 'Background lease reaper', code: 'store.js · reapExpiredClaims, startReaper' },
  { name: 'Process-local mutation lock', code: 'store.js · withMutationLock (ADR-003)' },
  { name: 'Pluggable persistence', code: 'store.js · JsonStorage | GitYamlStorage' },
  { name: 'Atomic writes + git audit trail', code: 'store.js · writeAtomic, serializeCard' },
  { name: 'Real-time push over SSE', code: 'server.js · GET /api/events' },
  { name: 'Per-project token isolation', code: 'middleware/auth.js, projectScope.js' },
  { name: 'HMAC session tokens', code: 'sessionAuth.js, routes/auth.js' },
  { name: 'Optimistic concurrency (version + If-Match)', code: 'store.js · nextVersionFor, versionConflict' },
  { name: 'Admin delete + bulk purge', code: 'store.js · deleteTask, purgeTasks' },
]

export type FaqItem = {
  q: string
  a: string
}

export const FAQ: FaqItem[] = [
  {
    q: 'Do I need a database?',
    a: 'No. State persists to a single atomic JSON file by default, or to git-backed YAML. A database backend is anticipated by the pluggable getStorage factory — a natural first contribution.',
  },
  {
    q: 'Does it phone home?',
    a: 'No. It is local-first and zero-telemetry: no accounts, no SaaS, no analytics. Run it on localhost or self-host it.',
  },
  {
    q: 'How do I host it?',
    a: 'One Node process serves the API, the built SPA and the SSE stream. It needs a persistent process and a mounted disk (SSE + the background reaper rule out serverless). railway.json and render.yaml are included.',
  },
  {
    q: 'Can humans change task state?',
    a: 'By default the UI is a read-only observability viewport — the primary users are headless agents driving the board over HTTP. Humans watch, and can bind an api token to act as an agent.',
  },
  {
    q: 'How do I connect a new project?',
    a: 'There is no registration step. A project materialises the first time you post a task under its id; you give it a project token out of band. See ONBOARDING.md for the curl walkthrough.',
  },
]

export const CURL_SNIPPET = `# an agent drives the board headlessly
curl -s -X POST "$BOARD/api/tasks/next-claim?agent_id=builder-1" \\
  -H "Authorization: Bearer $TOKEN" -H "X-Agent-Role: builder"

curl -s -X PATCH "$BOARD/api/tasks/$ID?project=$PROJECT" \\
  -H "Authorization: Bearer $TOKEN" -H "X-Agent-Role: builder" \\
  -d '{"status":"IN_REVIEW"}'

# humans just watch: the same state, live, over SSE`

export type TourShot = {
  src: string
  alt: string
  caption: string
}

export const TOUR_SHOTS: TourShot[] = [
  {
    src: '/landing/board.png',
    alt: 'The board showing Backlog, Building, In Review and In Test columns with task cards',
    caption: 'The board — a live projection of server state, not the source of truth',
  },
  {
    src: '/landing/picker.png',
    alt: 'The project picker open, listing all projects',
    caption: 'Scope the board, the activity feed and auto-claim to one project',
  },
  {
    src: '/landing/task-sheet.png',
    alt: 'A task detail sheet showing description, metadata and the agent log',
    caption: 'Every card carries its evidence: metadata, per-stage owners and the agent log',
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
