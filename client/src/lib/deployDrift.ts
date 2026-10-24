/**
 * §2.10 (v3.9.5) — the deploy-drift chip.
 *
 * Pure: a snapshot in, a chip descriptor (or null) out. Kept out of App.tsx so
 * the wording and the hide-on-healthy rule are unit-testable without a browser.
 *
 * The chip is deliberately HIDDEN unless something is wrong:
 *   - `in_sync`                    -> null (a healthy day shows only the version)
 *   - never checked (`checked_at` null, e.g. the monitor is disabled or this
 *     deployment predates v3.9.5)  -> null (nothing to say, not a warning)
 *   - `drift`                      -> amber: the deploy was skipped, not failed
 *   - `unknown`                    -> muted: GitHub was unreachable, not an outage
 */

export type DeployDriftStatus = 'in_sync' | 'drift' | 'unknown'

export type DeployDrift = {
  status: DeployDriftStatus
  /** Version this process is running (server/package.json), no `v` prefix. */
  running: string | null
  /** Newest release tag seen, `v` stripped. */
  latest_tag: string | null
  /** ISO timestamp of the last check attempt; null = never checked. */
  checked_at: string | null
  /** ISO timestamp of the first observation of the current mismatch. */
  drift_since: string | null
}

export type DriftChip = {
  label: string
  tone: 'warn' | 'muted'
  title: string
}

/**
 * Map a health snapshot's `deploy_drift` to a compact header chip.
 *
 * @returns the chip, or null when there is nothing worth showing.
 */
export function driftChip(d: DeployDrift | null | undefined): DriftChip | null {
  if (!d || d.checked_at == null) return null
  if (d.status === 'in_sync') return null

  if (d.status === 'drift') {
    const running = d.running ?? '?'
    const latest = d.latest_tag ?? '?'
    return {
      label: `deploy drift · ${running} ≠ ${latest}`,
      tone: 'warn',
      title:
        `The live board runs v${running} but the newest release is v${latest}` +
        `${d.drift_since ? `, first seen ${d.drift_since}` : ''}. ` +
        'The deploy was most likely SKIPPED (red CI), not failed — the board itself is healthy.',
    }
  }

  if (d.status === 'unknown') {
    return {
      label: 'deploy check unavailable',
      tone: 'muted',
      title:
        'The board could not reach GitHub to compare its version with the newest release' +
        `${d.checked_at ? ` (last attempt ${d.checked_at})` : ''}. ` +
        'This is a check failure, not a board outage.',
    }
  }

  return null
}
