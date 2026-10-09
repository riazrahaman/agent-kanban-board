const STAGE_ORDER = [
  'PLANNING',
  'IN_PROGRESS',
  'BUILDING',
  'IN_REVIEW',
  'VALIDATION',
  'IN_TEST',
  'READY_TO_SHIP',
  'DONE',
] as const

/**
 * Render a task's `stage_owners` map as a compact, stable-ordered string.
 * Only active stages that are actually present are emitted, in the canonical
 * PLANNING → IN_PROGRESS → IN_REVIEW → VALIDATION → READY_TO_SHIP → DONE order,
 * joined with ` · `.
 */
export function formatStageOwners(stageOwners: Record<string, string> | undefined): string {
  if (!stageOwners || typeof stageOwners !== 'object') return ''
  return STAGE_ORDER.filter((stage) => stageOwners[stage])
    .map((stage) => `${stage}: ${stageOwners[stage]}`)
    .join(' · ')
}
