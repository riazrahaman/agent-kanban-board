import { useEffect, useRef } from 'react'
import Sortable from 'sortablejs'
import type { Task, TaskStatus } from '../types'
import { patchTask } from '../api'
import TaskCard from './TaskCard'

type Props = {
  status: TaskStatus
  title: string
  tasks: Task[]
  onOpen: (id: string) => void
}

export default function Column({ status, title, tasks, onOpen }: Props) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const isDone = status === 'done'

  useEffect(() => {
    const el = listRef.current
    if (!el) return

    const sortable = Sortable.create(el, {
      group: 'kanban',
      animation: 150,
      ghostClass: 'sortable-ghost',
      dragClass: 'sortable-drag',
      onEnd: (evt) => {
        const taskId = evt.item.dataset.id
        const newStatus = evt.to.dataset.status as TaskStatus | undefined
        const oldStatus = evt.from.dataset.status as TaskStatus | undefined

        if (!taskId || !newStatus) return
        if (newStatus === oldStatus) return

        patchTask(taskId, { status: newStatus }).catch((err) => {
          console.error('Failed to move task', err)
        })
      },
    })

    return () => sortable.destroy()
  }, [])

  return (
    <div
      className={[
        'flex w-72 shrink-0 flex-col rounded-lg border border-zinc-200 bg-zinc-100/70 dark:border-zinc-800 dark:bg-zinc-900 transition-opacity',
        isDone ? 'opacity-[0.55]' : '',
      ].join(' ')}
    >
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{title}</h2>
        <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          {tasks.length}
        </span>
      </div>
      <div
        ref={listRef}
        data-status={status}
        className="flex min-h-[120px] flex-1 flex-col gap-2 overflow-y-auto p-2"
      >
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onOpen={onOpen} />
        ))}
      </div>
    </div>
  )
}
