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
    value: '222',
    label: 'server tests',
    detail: 'state machine, leases, auth, persistence',
  },
  {
    value: '68',
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
  {
    title: 'A task is silently reclaimed',
    body: 'A lease expiring is the system working correctly — but if nobody is told, a stalled agent looks exactly like a calm, healthy board.',
    mechanism: 'notifier.js — an onDiff subscriber posts a full-detail alert when the reaper returns a task to BACKLOG',
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
  { name: 'Orphan grace window', code: 'store.js · getOrphanGraceMs (KANBAN_ORPHAN_GRACE_MS)' },
  { name: 'Process-local mutation lock', code: 'store.js · withMutationLock (ADR-003)' },
  { name: 'Pluggable persistence', code: 'store.js · JsonStorage | GitYamlStorage' },
  { name: 'Atomic writes + git audit trail', code: 'store.js · writeAtomic, serializeCard' },
  { name: 'Real-time push over SSE', code: 'server.js · GET /api/events' },
  { name: 'Telegram alerts on reclaim', code: 'notifier.js · onDiff, formatReclaimMessage' },
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
  {
    q: 'How will I know when an agent dies?',
    a: 'The reaper returns the task to BACKLOG and the notifier posts a full-detail alert — project, title, reason, who held it, when the lease ended and a deep link back to that project. A held lease dies the moment it stops being renewed; an ownerless active card is only normalized once a grace window has passed. Configure KANBAN_TELEGRAM_BOT_TOKEN and KANBAN_TELEGRAM_CHAT_ID to switch it on; it is off by default.',
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

export type StackRow = {
  layer: string
  choice: string
  why: string
  location: string
}

export const STACK_ROWS: StackRow[] = [
  {
    layer: 'Client',
    choice: 'React 18 · Vite · TypeScript · Tailwind',
    why: 'An observability viewport, not the workflow engine.',
    location: 'client/src/',
  },
  {
    layer: 'Transport',
    choice: 'Express 4 (ESM) + Server-Sent Events',
    why: 'Plain HTTP any agent can curl; SSE pushes live state to humans.',
    location: 'server/server.js',
  },
  {
    layer: 'Core engine',
    choice: 'One module: state machine + RBAC + leases + lock',
    why: 'A single serialization point is what makes contention deterministic.',
    location: 'server/store.js',
  },
  {
    layer: 'Persistence',
    choice: 'Atomic JSON or git-backed YAML',
    why: 'Local-first, zero dependencies — and git becomes the audit trail.',
    location: 'JsonStorage · GitYamlStorage',
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
    title: 'Selects the highest-priority eligible BACKLOG task.',
    detail: 'Priority, then FIFO — and its dependencyGate must be satisfied.',
  },
  {
    label: '05',
    title: 'applyClaim writes the owner, the lease and the stage.',
    detail: 'Sets assigned_agent, claim_expires_at and stage_owners.BUILDING; lifts BACKLOG → BUILDING; bumps version.',
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
    detail: 'A live lease held by another owner → 409 already-claimed; an expired lease is reaped immediately, while an ownerless active card waits out a grace window (KANBAN_ORPHAN_GRACE_MS, default = the lease TTL) before it is normalized.',
  },
]

export const SAFETY_FOOTER =
  'All inside withMutationLock, then persist → update memory → notify over SSE. Persist first (KB-05): memory is never ahead of disk.'

export const RECLAIM_FLOW: FlowStep[] = [
  {
    label: '01',
    title: 'An agent stops heartbeating mid-task.',
    detail: 'The card stays BUILDING, IN_REVIEW or IN_TEST with a lease that is quietly running out.',
  },
  {
    label: '02',
    title: 'The background reaper sweeps expired leases.',
    detail: 'reapExpiredClaims runs on a timer; a task with no owner at all is treated as structurally stuck and normalized on the next sweep.',
  },
  {
    label: '03',
    title: 'reclaimTaskInner returns the card to BACKLOG.',
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
