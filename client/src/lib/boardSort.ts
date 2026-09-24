import type { Task } from '../types'
import { normalizePriority, PRIORITY_WEIGHT } from '../priority'

/**
 * Column sort modes. 'priority' (default) ranks high > medium > low and keeps
 * the server's recency order within a rank (Array.prototype.sort is stable in
 * modern V8, so equal-priority cards never jump). 'updated' is newest first;
 * 'id' is a plain lexical A→Z. Unlike the removed local reorder controls, the
 * choice is a real control: it is persisted per browser and re-applied on every
 * SSE snapshot instead of being silently discarded on the next broadcast.
 */
export type BoardSort = 'priority' | 'updated' | 'id'

export const SORT_STORAGE_KEY = 'kanban.sort'

export const SORT_OPTIONS: { value: BoardSort; label: string }[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'updated', label: 'Recently Updated' },
  { value: 'id', label: 'Task ID' },
]

export const DEFAULT_SORT: BoardSort = 'priority'

function isValidSort(value: unknown): value is BoardSort {
  return value === 'priority' || value === 'updated' || value === 'id'
}

/** Read the persisted sort choice, falling back to the default on anything else. */
export function readStoredSort(): BoardSort {
  if (typeof window === 'undefined') return DEFAULT_SORT
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY)
    return isValidSort(raw) ? raw : DEFAULT_SORT
  } catch {
    return DEFAULT_SORT
  }
}

/** Persist the sort choice. Failures (private mode, quota) are silently ignored. */
export function writeStoredSort(sort: BoardSort): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(SORT_STORAGE_KEY, sort)
  } catch {
    // Non-fatal: the board just falls back to the default next load.
  }
}

/**
 * Sort a task list for column display. Pure: returns a NEW array, never
 * mutates the input (the caller's `tasks` array is the SSE state). Ties keep
 * the incoming (server recency) order because the sort is stable.
 */
export function sortTasks(tasks: Task[], sort: BoardSort = DEFAULT_SORT): Task[] {
  const list = [...tasks]
  switch (sort) {
    case 'priority':
      return list.sort((a, b) => {
        const wa = PRIORITY_WEIGHT[normalizePriority(a.priority)] ?? 1
        const wb = PRIORITY_WEIGHT[normalizePriority(b.priority)] ?? 1
        return wa - wb
      })
    case 'updated':
      return list.sort(
        (a, b) => Date.parse(b.updated ?? '') - Date.parse(a.updated ?? ''),
      )
    case 'id':
      return list.sort((a, b) => a.id.localeCompare(b.id))
    default:
      return list
  }
}