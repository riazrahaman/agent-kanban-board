import type { Task, TaskStatus } from '../types'
import Column from './Column'

const COLUMNS: { status: TaskStatus; title: string }[] = [
  { status: 'BACKLOG', title: 'Backlog' },
  { status: 'BUILDING', title: 'Building' },
  { status: 'IN_REVIEW', title: 'In Review' },
  { status: 'IN_TEST', title: 'In Test' },
  { status: 'BLOCKED', title: 'Blocked' },
  { status: 'DONE', title: 'Done' },
  { status: 'ISSUES', title: 'Issues' },
]

type Props = {
  tasks: Task[]
  onOpen: (id: string) => void
}

function normalizeStatus(status: string): TaskStatus {
  const s = status?.toUpperCase() ?? 'BACKLOG'
  if (s === 'TODO') return 'BACKLOG'
  if (s === 'IN_PROGRESS') return 'BUILDING'
  return s as TaskStatus
}

export default function Board({ tasks, onOpen }: Props) {
  const grouped: Record<string, Task[]> = {
    BACKLOG: [],
    BUILDING: [],
    IN_REVIEW: [],
    IN_TEST: [],
    BLOCKED: [],
    DONE: [],
    ISSUES: [],
  }

  for (const task of tasks) {
    const norm = normalizeStatus(task.status)
    if (!grouped[norm]) {
      grouped[norm] = []
    }
    grouped[norm].push(task)
    if (task.issues && task.issues.length > 0) {
      grouped.ISSUES.push(task)
    }
  }

  return (
    <div className="flex h-full gap-4 overflow-x-auto p-4">
      {COLUMNS.map((col) => (
        <Column
          key={col.status}
          status={col.status}
          title={col.title}
          tasks={grouped[col.status] || []}
          onOpen={onOpen}
        />
      ))}
    </div>
  )
}
