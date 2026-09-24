import type { TaskPriority } from './types'

// The backend issues priorities as the triage scheme (P0-critical, P1-high,
// P2-medium, P3-low) as well as the plain high/medium/low. A card whose priority
// is not in PRIORITY_STYLES would yield `undefined` and throw on `style.label`,
// unmounting the whole board. Normalize any value to a known key and fall back to
// 'medium' so an unmapped priority can never crash a render.
const PRIORITY_RANK: Record<string, TaskPriority> = {
  high: 'high',
  medium: 'medium',
  low: 'low',
  'P0-critical': 'high',
  P0: 'high',
  'P1-high': 'high',
  P1: 'high',
  'P2-medium': 'medium',
  P2: 'medium',
  'P3-low': 'low',
  P3: 'low',
}

export function normalizePriority(raw: string | null | undefined): TaskPriority {
  return (raw && PRIORITY_RANK[raw]) || 'medium'
}

export const PRIORITY_BADGE: Record<TaskPriority, string> = {
  high: 'bg-fail-bg text-fail border-fail/40 font-semibold',
  medium: 'bg-warn-bg text-warn border-warn/40',
  low: 'bg-muted-bg text-muted border-line',
}

export function priorityBadgeClass(priority: string | null | undefined): string {
  return PRIORITY_BADGE[normalizePriority(priority)]
}

export const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
}
