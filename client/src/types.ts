export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'done'

export type TaskPriority = 'low' | 'medium' | 'high'

export type AgentLog = {
  timestamp: string
  message: string
  agent_id: string
}

export type Task = {
  id: string
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  assigned_agent: string | null
  agent_logs: AgentLog[]
  metadata: Record<string, unknown>
}
