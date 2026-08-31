import type { Task, TaskStatus } from '../types'
import Column from './Column'

const COLUMNS: { status: TaskStatus; title: string }[] = [
  { status: 'backlog', title: 'Backlog' },
  { status: 'todo', title: 'To Do' },
  { status: 'in_progress', title: 'In Progress' },
  { status: 'blocked', title: 'Blocked' },
  { status: 'done', title: 'Done' },
]

type Props = {
  tasks: Task[]
  onOpen: (id: string) => void
}

export default function Board({ tasks, onOpen }: Props) {
  const grouped: Record<TaskStatus, Task[]> = {
    backlog: [],
    todo: [],
    in_progress: [],
    blocked: [],
    done: [],
  }

  for (const task of tasks) {
    grouped[task.status]?.push(task)
  }

  return (
    <div className="flex h-full gap-4 overflow-x-auto p-4">
      {COLUMNS.map((col) => (
        <Column
          key={col.status}
          status={col.status}
          title={col.title}
          tasks={grouped[col.status]}
          onOpen={onOpen}
        />
      ))}
    </div>
  )
}
