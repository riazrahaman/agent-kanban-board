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

export type Task = {
  id: string
  project: string
  workspace_id?: string       // input alias only; not persisted
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  assigned_agent: string | null
  agent_logs: AgentLog[]
  branch?: string
  depends_on?: string[]
  round?: number
  issues?: string[]
  created_at?: string
  completed_at?: string
  archived_at?: string
  updated?: string
  metadata: Record<string, unknown>
}

export type ProjectSummary = {
  project: string
  task_count: number
  done_count: number
  live_count: number
  archived_count: number
  updated?: string
}
