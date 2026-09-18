import { useMemo } from 'react'
import type { Task, TaskStatus } from '../types'
import { groupTasks } from '../board-model.js'
import Column from './Column'

const COLUMNS: { status: TaskStatus; title: string }[] = [
  { status: 'BACKLOG', title: 'Backlog' },
  { status: 'BUILDING', title: 'Building' },
  { status: 'IN_REVIEW', title: 'In Review' },
  { status: 'IN_TEST', title: 'In Test' },
  { status: 'BLOCKED', title: 'Blocked' },
  { status: 'DONE', title: 'Done' },
  { status: 'UNKNOWN', title: 'Unknown' },
  { status: 'ISSUES', title: 'Issues' },
]

type Props = {
  tasks: Task[]
  onOpen: (id: string) => void
}

export default function Board({ tasks, onOpen }: Props) {
  const grouped = useMemo(() => groupTasks(tasks), [tasks])

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
