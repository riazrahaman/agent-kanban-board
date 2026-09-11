export type StatusStyle = {
  normalized: string
  stripe: string
  badge: string
}

export function normalizeStatus(status: unknown): string
export function statusStyle(status: unknown): StatusStyle
