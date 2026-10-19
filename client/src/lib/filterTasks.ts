import type { Task } from '../types'
import { normalizePriority } from '../priority'
import { deriveOwnership, type SeverityFilter } from './ownership'

export type FilterCriteria = {
  search: string
  priority: string
  assignee: string
  severity: SeverityFilter[]
}

export function filterTasks(tasks: Task[], criteria: FilterCriteria): Task[] {
  const searchLower = criteria.search.trim().toLowerCase()
  const priorityFilter = criteria.priority.trim().toLowerCase()
  const assigneeFilter = criteria.assignee.trim().toLowerCase()
  const severityFilter = criteria.severity ?? []

  if (!searchLower && !priorityFilter && !assigneeFilter && severityFilter.length === 0) {
    return tasks
  }

  return tasks.filter((task) => {
    // 1. Search filter: matches task id, title, description, branch, or assigned_agent
    if (searchLower) {
      const idMatch = task.id.toLowerCase().includes(searchLower)
      const titleMatch = (task.title || '').toLowerCase().includes(searchLower)
      const descMatch = (task.description || '').toLowerCase().includes(searchLower)
      const branchMatch = (task.branch || '').toLowerCase().includes(searchLower)
      const agentMatch = (task.assigned_agent || '').toLowerCase().includes(searchLower)
      if (!idMatch && !titleMatch && !descMatch && !branchMatch && !agentMatch) {
        return false
      }
    }

    // 2. Priority filter
    if (priorityFilter && priorityFilter !== 'all') {
      const taskPriority = normalizePriority(task.priority).toLowerCase()
      const rawPriority = (task.priority || '').toLowerCase()
      if (taskPriority !== priorityFilter && rawPriority !== priorityFilter) {
        return false
      }
    }

    // 3. Assignee filter
    if (assigneeFilter && assigneeFilter !== 'all') {
      if (assigneeFilter === 'unassigned') {
        if (task.assigned_agent) return false
      } else {
        if (!task.assigned_agent || task.assigned_agent.toLowerCase() !== assigneeFilter) {
          return false
        }
      }
    }

    // 4. Solo-run severity filter (multi-select; empty means show all)
    if (severityFilter.length > 0) {
      const taskSeverity = deriveOwnership(task.stage_owners).severity
      if (taskSeverity === 'none' || !severityFilter.includes(taskSeverity)) {
        return false
      }
    }

    return true
  })
}
