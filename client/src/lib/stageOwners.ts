const STAGE_ORDER = ['BUILDING', 'IN_REVIEW', 'IN_TEST', 'DONE'] as const

/**
 * Render a task's `stage_owners` map as a compact, stable-ordered string.
 * Only active stages that are actually present are emitted, in the canonical
 * BUILDING → IN_REVIEW → IN_TEST → DONE order, joined with ` · `.
 */
export function formatStageOwners(stageOwners: Record<string, string> | undefined): string {
  if (!stageOwners || typeof stageOwners !== 'object') return ''
  return STAGE_ORDER.filter((stage) => stageOwners[stage])
    .map((stage) => `${stage}: ${stageOwners[stage]}`)
    .join(' · ')
}
