export type TaskStatus =
  | 'BACKLOG'
  | 'BUILDING'
  | 'IN_REVIEW'
  | 'IN_TEST'
  | 'BLOCKED'
  | 'DONE'
  | 'UNKNOWN'
  | 'ISSUES'
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'blocked'
  | 'done'

export type TaskPriority = 'low' | 'medium' | 'high'

export type AgentLog = {
  timestamp: string
  message: string
  agent_id: string
}

/** v2.5.0 — a human/agent comment on a card's discussion thread. */
export type Comment = {
  timestamp: string
  message: string
  agent_id: string
}

export type Task = {
  id: string
  project: string
  workspace_id?: string        // input alias only; not persisted
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  assigned_agent: string | null
  stage_owners?: Record<string, string>
  agent_logs: AgentLog[]
  comments?: Comment[]         // v2.5.0: discussion thread (separate from agent_logs)
  branch?: string
  milestone?: string | null    // v2.11.0: optional grouping label (opt-milestones)
  depends_on?: string[]
  round?: number
  issues?: string[]
  created_at?: string
  completed_at?: string
  archived_at?: string
  updated?: string
  metadata: Record<string, unknown>
  version: number               // §2.6: monotonically increasing CAS guard, starts at 1
  expected_version?: number     // input guard only; supplied to mutations, never persisted
  claim_expires_at?: string | null  // §2.4: ISO-8601 lease deadline; null/absent = unclaimed
  claim_lease_ms?: number | null    // v2.12.0: this card's lease window (ms); null = server default
  last_progress_at?: string | null  // v2.12.1: last claim/log/PATCH on THIS card (distinct from lease renewal)
  reclaim_count?: number        // §2.4: reaper reclaim count, seeds 0
}

export type ProjectSummary = {
  project: string
  task_count: number
  done_count: number
  live_count: number
  archived_count: number
  updated?: string
}

/** §2.9 — per-project (or aggregate) observability figures. */
export type CycleTimeSummary = {
  count: number
  mean_ms: number | null
  median_ms: number | null
  p90_ms: number | null
  min_ms: number | null
  max_ms: number | null
}

export type ProjectMetrics = {
  /** null on the portfolio aggregate row. */
  project: string | null
  task_count: number
  live_count: number
  archived_count: number
  /** DONE on the live board — agrees with ProjectSummary.done_count. */
  done_count: number
  /** All work ever finished, archived rows included. */
  completed_count: number
  by_status: Record<string, number>
  cycle_time: CycleTimeSummary
  reclaim_count: number
  reclaimed_task_count: number
  active_agents: string[]
  active_agent_count: number
  /** `conflicts` is counted since `since` — it has no durable source. */
  claim_contention: { conflicts: number; since: string }
}

export type MetricsResponse = {
  generated_at: string
  scope: string | null
  projects: ProjectMetrics[]
  aggregate: ProjectMetrics & { project_count: number }
}

/** v2.11.0 (opt-milestones) — a per-goal rollup from GET /api/milestones. */
export type MilestoneSummary = {
  milestone: string
  project: string
  total: number
  done: number
  progress: number
  by_status: Record<string, number>
}
