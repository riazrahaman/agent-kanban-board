import { normalizeStatus } from './status.js'

function toCompletedTimestamp(task) {
  const ts = Date.parse(task.completed_at || task.updated || task.created_at || '')
  return Number.isNaN(ts) ? 0 : ts
}

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

  // The DONE swimlane must always show the most recently completed tasks at
  // the top, down to the oldest at the bottom, regardless of the board's
  // general active sort mode (priority/id/etc).
  grouped.DONE.sort((a, b) => {
    const ta = toCompletedTimestamp(a)
    const tb = toCompletedTimestamp(b)
    if (tb !== ta) return tb - ta
    return 0
  })

  return grouped
}
