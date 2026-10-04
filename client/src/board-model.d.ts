import type { Task, TaskStatus } from './types'

export type ColumnDefinition = {
  status: TaskStatus
  title: string
  stepNumber?: string
}

export const COLUMNS: ColumnDefinition[]

export function groupTasks(tasks: Task[]): Record<string, Task[]>

export function getVisibleColumns(grouped: Record<string, Task[]>): ColumnDefinition[]
