import type { Task } from '../types'
import { normalizePriority } from '../priority'

export type FilterCriteria = {
  search: string
  priority: string
  assignee: string
}

export function filterTasks(tasks: Task[], criteria: FilterCriteria): Task[] {
  const searchLower = criteria.search.trim().toLowerCase()
  const priorityFilter = criteria.priority.trim().toLowerCase()
  const assigneeFilter = criteria.assignee.trim().toLowerCase()

  if (!searchLower && !priorityFilter && !assigneeFilter) {
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

    return true
  })
}
