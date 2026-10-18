/**
 * Ask-the-Board client surface (v3.5.0 About rebuild).
 *
 * `POST /api/ask` is UNAUTHENTICATED by the board's token model and instead
 * gated by a shared password sent in the `x-ask-pass` header (see
 * `server/routes/ask.js`). This module is the browser side of that: it reads
 * the feature's on/off state and asks a question.
 *
 * The password is held per-browser in localStorage — the same pragmatic trade
 * `lib/authToken.ts` makes for the write token: it is a secret the operator
 * already holds, readable by any XSS on this origin, and the reason it is an
 * explicit field rather than something the app acquires on its own. It is never
 * placed in a URL and only ever sent as a request header.
 */

// Same-origin `/api`, matching `api.ts`: the deployed server serves the client
// bundle AND the API on one origin, so a relative base works everywhere.
const API_BASE = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE) || '/api'

const ASK_PASS_KEY = 'kanban.askPass'

export type AskConfig = {
  enabled: boolean
  gated?: boolean
  provider?: 'openrouter' | 'ollama' | string
  model?: string
}

export type AskAnswer = {
  answer: string
  provider?: 'openrouter' | 'ollama' | string
  model?: string
  fallback?: boolean
}

/**
 * A failed `POST /api/ask`, carrying the HTTP status and the server's machine
 * `error` code (`invalid_pass`, `too_many_attempts`, `daily_cap_reached`,
 * `ip_limit_reached`, `gateway_error`, `timeout`, `invalid_question`) so the UI
 * can render a specific, honest message instead of a raw dump.
 */
export class AskError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message?: string) {
    super(message ?? `Ask failed (${status}): ${code}`)
    this.name = 'AskError'
    this.status = status
    this.code = code
  }
}

export function readStoredAskPass(): string {
  try {
    return localStorage.getItem(ASK_PASS_KEY) ?? ''
  } catch {
    // Private mode / blocked site data: behave as no password rather than throw.
    return ''
  }
}

export function writeStoredAskPass(password: string): void {
  try {
    const trimmed = password.trim()
    if (trimmed) localStorage.setItem(ASK_PASS_KEY, trimmed)
    else localStorage.removeItem(ASK_PASS_KEY)
  } catch {
    // Nothing useful to do; the request will simply go out unauthenticated.
  }
}

/** Feature state for the Ask card. `enabled:false` means the operator has not set it up. */
export async function getAskConfig(): Promise<AskConfig> {
  const res = await fetch(`${API_BASE}/ask/config`)
  if (!res.ok) throw new AskError(res.status, 'config_unavailable')
  return (await res.json()) as AskConfig
}

/**
 * Ask one question. On a non-2xx response this throws an {@link AskError} whose
 * `status` + `code` the caller maps to a message; a successful answer's `model`
 * (and optional `fallback` flag) is returned verbatim.
 */
export async function askQuestion(
  question: string,
  password: string,
): Promise<AskAnswer> {
  const res = await fetch(`${API_BASE}/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ask-pass': password,
    },
    body: JSON.stringify({ question }),
  })

  if (!res.ok) {
    let code = 'error'
    try {
      const body = (await res.json()) as { error?: unknown }
      if (typeof body?.error === 'string' && body.error) code = body.error
    } catch {
      // Non-JSON error body: keep the generic code.
    }
    throw new AskError(res.status, code)
  }

  return (await res.json()) as AskAnswer
}
