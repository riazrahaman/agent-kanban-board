import type { Task } from './types'

export function groupTasks(tasks: Task[]): Record<string, Task[]>
