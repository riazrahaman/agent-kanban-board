import { useEffect, useState } from 'react'

// Public, tokenless visit counter (abacus.jasoncameron.dev) backed by Cloudflare
// Workers + KV. Free and keyless, so nothing secret ships to the browser and no
// account is required. It stores a single integer per namespace/key; there is no
// geography and no per-visitor data, and anyone who knows the key could inflate
// it. This mirrors the counter on riazrahaman.com but uses a distinct namespace
// so the board's visits are counted independently.
//
// The data lives entirely on the counter's servers. This app keeps no copy: the
// only client-side state is a sessionStorage flag so a reload inside the same
// browsing session does not double-count.
export const COUNTER_BASE = 'https://abacus.jasoncameron.dev'
export const VISIT_NAMESPACE = 'agent-kanban.riazrahaman.com'
export const VISIT_KEY = 'pageviews'
export const VISIT_SESSION_FLAG = 'kanban-visit-counted'

export type VisitState = { count: number | null; counted: boolean }

async function readVisits(): Promise<number | null> {
  try {
    const res = await fetch(`${COUNTER_BASE}/get/${VISIT_NAMESPACE}/${VISIT_KEY}`)
    if (!res.ok) return null
    const data = (await res.json()) as { value?: number }
    return typeof data.value === 'number' ? data.value : null
  } catch {
    return null
  }
}

async function hitVisits(): Promise<number | null> {
  try {
    const res = await fetch(`${COUNTER_BASE}/hit/${VISIT_NAMESPACE}/${VISIT_KEY}`)
    if (!res.ok) return null
    const data = (await res.json()) as { value?: number }
    return typeof data.value === 'number' ? data.value : null
  } catch {
    return null
  }
}

// Formats the footer label, e.g. `1,234 visits` / `1 visit`. Empty string when
// there is nothing to show (still loading, or the counter is unreachable).
export function formatVisitCount(count: number | null): string {
  if (typeof count !== 'number' || !Number.isFinite(count)) return ''
  const n = count.toLocaleString()
  return `${n} ${count === 1 ? 'visit' : 'visits'}`
}

export function useVisitCount(): VisitState {
  const [count, setCount] = useState<number | null>(null)
  const [counted, setCounted] = useState(false)

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      let alreadyCounted = false
      try {
        alreadyCounted = sessionStorage.getItem(VISIT_SESSION_FLAG) === '1'
      } catch {
        // sessionStorage can throw in private modes; fall through and just read.
      }

      if (!alreadyCounted) {
        try {
          sessionStorage.setItem(VISIT_SESSION_FLAG, '1')
        } catch {
          // ignore
        }
      }

      const value = alreadyCounted ? await readVisits() : await hitVisits()
      if (cancelled) return

      setCount(value)
      setCounted(!alreadyCounted && value !== null)
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [])

  return { count, counted }
}
