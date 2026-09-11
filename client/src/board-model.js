import { normalizeStatus } from './status.js'

export function groupTasks(tasks) {
  const grouped = {
    BACKLOG: [],
    BUILDING: [],
    IN_REVIEW: [],
    IN_TEST: [],
    BLOCKED: [],
    DONE: [],
    UNKNOWN: [],
    ISSUES: [],
  }

  for (const task of tasks) {
    const normalized = normalizeStatus(task.status)
    grouped[normalized].push(task)
    if (task.issues && task.issues.length > 0) grouped.ISSUES.push(task)
  }

  return grouped
}
