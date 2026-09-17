import type { ProjectMetrics } from '../types'

/**
 * Pure presentation logic for the §2.10 portfolio view, kept out of the
 * component so it can be unit tested (same split as claimCoordinator.ts).
 */

/** The columns that make up "work in flight" — between backlog and done. */
export const WIP_STATUSES = ['BUILDING', 'IN_REVIEW', 'IN_TEST'] as const

export function wipOf(m: Pick<ProjectMetrics, 'by_status'>): number {
  return WIP_STATUSES.reduce((acc, s) => acc + (m.by_status[s] ?? 0), 0)
}

export function blockedOf(m: Pick<ProjectMetrics, 'by_status'>): number {
  return m.by_status.BLOCKED ?? 0
}

export function backlogOf(m: Pick<ProjectMetrics, 'by_status'>): number {
  return m.by_status.BACKLOG ?? 0
}

/**
 * Compact duration for a table cell. Null (no completed work yet) reads as a
 * dash rather than "0", which would wrongly suggest instant delivery.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 0) return '—'
  const hours = ms / 3600000
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60000))}m`
  if (hours < 48) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}
