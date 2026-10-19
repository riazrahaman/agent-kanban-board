import type { Task } from '../types'

export type Severity = 'none' | 'green' | 'amber' | 'red'

/** Severities that can be selected in the board filter (all except 'none'). */
export type SeverityFilter = 'green' | 'amber' | 'red'

export type SeverityColor = SeverityFilter

export const SEVERITY_COLORS: Record<SeverityColor, string> = {
  green: '#3fa46a',
  amber: '#e8a13a',
  red: '#d4554f',
}

/** Stages that carry an owner concept and participate in separation analysis. */
const ACTIVE_STAGES = [
  'PLANNING',
  'IN_PROGRESS',
  'IN_REVIEW',
  'VALIDATION',
  'READY_TO_SHIP',
  'DONE',
] as const

/** Legacy stage keys (pre-normalization cards) with canonical equivalents. */
const STAGE_ALIASES: Record<string, (typeof ACTIVE_STAGES)[number]> = {
  BUILDING: 'IN_PROGRESS',
  IN_TEST: 'VALIDATION',
}

/** Inverted for read-side lookup: canonical stage -> legacy key to also probe. */
const LEGACY_KEY_FOR: Partial<Record<(typeof ACTIVE_STAGES)[number], string>> =
  Object.fromEntries(
    Object.entries(STAGE_ALIASES).map(([legacy, canonical]) => [canonical, legacy]),
  )

/** Lifecycle order used for held-stage walk reporting. */
const LIFECYCLE_ORDER = [
  'PLANNING',
  'IN_PROGRESS',
  'IN_REVIEW',
  'VALIDATION',
  'READY_TO_SHIP',
  'DONE',
] as const

export type OwnershipSummary = {
  severity: Severity
  /** Count of distinct non-null agent ids across active stages. */
  agents: number
  /** Count of active stages that have a non-null owner. */
  stages: number
  /** The single agent id when severity is amber/red; otherwise null. */
  soleAgent: string | null
  /** Active stages that soleAgent held, in lifecycle order. */
  heldStages: string[]
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Derive the solo-run severity of a task from its per-stage owners.
 *
 * Active stages are PLANNING → IN_PROGRESS → IN_REVIEW → VALIDATION →
 * READY_TO_SHIP → DONE. BACKLOG, READY and BLOCKED have no owner concept and
 * are ignored. Unknown stage keys are ignored.
 */
export function deriveOwnership(
  stageOwners: Record<string, string> | undefined,
): OwnershipSummary {
  const owners: Record<string, string> = {}

  for (const stage of ACTIVE_STAGES) {
    const raw = stageOwners?.[stage] ?? stageOwners?.[LEGACY_KEY_FOR[stage] ?? '']
    if (isNonEmptyString(raw)) owners[stage] = raw.trim()
  }

  // Normalize agent ids before comparing so casing/whitespace variance
  // ('Agent-A' vs 'agent-a') doesn't split one agent into two and silently
  // downgrade a solo-run to green. Display keeps the id as first seen.
  const byKey = new Map<string, string>()
  for (const id of Object.values(owners)) {
    const key = id.toLowerCase()
    if (!byKey.has(key)) byKey.set(key, id)
  }

  const agentSet = byKey.size
  const agents = agentSet
  const stages = Object.keys(owners).length

  let severity: Severity = 'none'
  let soleAgent: string | null = null
  let heldStages: string[] = []

  if (stages <= 1) {
    severity = 'none'
  } else if (agents >= 2) {
    severity = 'green'
  } else if (agents === 1) {
    const soleKey = [...byKey.keys()][0] ?? ''
    soleAgent = byKey.get(soleKey) ?? null
    if (soleAgent) {
      heldStages = LIFECYCLE_ORDER.filter(
        (stage) => (owners[stage] ?? '').toLowerCase() === soleKey,
      )
    }
    severity = stages >= 4 ? 'red' : 'amber'
  }

  return { severity, agents, stages, soleAgent, heldStages }
}

export function deriveTaskOwnership(task: Pick<Task, 'stage_owners'>): OwnershipSummary {
  return deriveOwnership(task.stage_owners)
}

/** Card-specific tooltip text for the severity dot. */
export function ownershipTooltip(summary: OwnershipSummary): string {
  if (summary.severity === 'green') {
    return `GREEN — separation held. ${summary.agents} different agents covered ${summary.stages} active stages.`
  }

  if (summary.severity === 'amber') {
    const agent = summary.soleAgent ?? 'one agent'
    const stagesText = summary.heldStages.join(' → ')
    return `AMBER — ${summary.stages} solo stages. ${agent} held ${stagesText}. Independent-review pair-break missing.`
  }

  if (summary.severity === 'red') {
    const agent = summary.soleAgent ?? 'one agent'
    const stagesText = summary.heldStages.join(' → ')
    return `RED — ${summary.stages} solo stages. Same agent walked ${summary.stages} stages in one pass: ${agent} held ${stagesText}. Self-approval pattern: one agent built, reviewed and validated its own work.`
  }

  return ''
}
