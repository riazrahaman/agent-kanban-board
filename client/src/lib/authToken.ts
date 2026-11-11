/**
 * Credentials for browser-originated mutations.
 *
 * The server requires a shared token on every mutating request (KB-04/A07), and
 * §2.3 narrows a token to the project(s) it was issued for. The operator supplies
 * that token here rather than it being baked into the build: Vite inlines
 * `import.meta.env.*` into the published bundle, so an env var would ship the
 * shared write secret to everyone who can load the page.
 *
 * The token is held per-browser in localStorage. That is readable by any XSS on
 * this origin — acceptable because it is a secret the operator already holds and
 * scopes deliberately, but it is the reason this is an explicit, revocable field
 * rather than something the app acquires on its own. It is never placed in a URL,
 * never logged, and only ever sent as a request header.
 */

const TOKEN_KEY = 'kanban.token'

/**
 * The role every browser-originated mutation is attributed to. The UI performs
 * only `appendLog`, `heartbeatTask` and `nextClaim` — none of which are role-gated
 * beyond "must be a valid role" — so one role is sufficient. If status transitions
 * are ever driven from the UI, this must become a per-action choice: the server
 * gates IN_TEST on `reviewer` and DONE on `tester`.
 */
export const CLIENT_ROLE = 'builder'

export function readStoredToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    // Private mode / blocked site data: behave as unauthenticated rather than throw.
    return ''
  }
}

export function writeStoredToken(token: string): void {
  try {
    const trimmed = token.trim()
    if (trimmed) localStorage.setItem(TOKEN_KEY, trimmed)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Nothing useful to do; the request will simply be unauthenticated.
  }
}

/**
 * Auth headers for a mutating request. Pure, so the "never send an empty Bearer"
 * rule is unit-testable without a browser.
 *
 * An absent token yields no `Authorization` header at all rather than an empty
 * one: `Bearer ` would be sent, fail the server's comparison, and produce the
 * same 401 while looking in logs like a wrong token rather than a missing one.
 *
 * A7 (v3.12.8): `agentId` is the caller's OWN identity and is sent as
 * `X-Agent-Id`. Since v3.12.8 the server derives a non-privileged caller's
 * identity from that header only — a body `agent_id` is no longer identity for
 * a project credential — so a browser that omitted the header would 400 every
 * claim/heartbeat/log/comment/next-claim. Callers still put `agent_id` in the
 * body too: it keeps working against a server older than v3.12.8.
 *
 * The header value is reduced to printable ASCII. `fetch` converts header
 * values to a ByteString, so ANY codepoint above U+00FF (Cyrillic, CJK, emoji —
 * all plausible agent names) makes the call throw "Cannot convert argument to
 * a ByteString" before the request leaves the browser; an embedded newline
 * throws for the same reason and could forge an audit log line. Runs of such
 * characters collapse to a single `-`, and an identity with nothing printable
 * left becomes `agent` so the header is never empty. This is presentation only:
 * the raw id still travels in the JSON body, and a credential-bound caller is
 * unaffected because the server prefers the credential's id.
 */

/** Stable stand-in when an identity has no printable ASCII left to send. */
const AGENT_ID_FALLBACK = 'agent'

function headerSafeAgentId(agentId: string): string {
  const ascii = agentId.replace(/[^\u0020-\u007e]+/g, '-').trim()
  const trimmed = ascii.replace(/^[-\s]+|[-\s]+$/g, '')
  return trimmed || AGENT_ID_FALLBACK
}

export function authHeaders(
  token: string | null | undefined,
  role: string = CLIENT_ROLE,
  agentId?: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {}
  const trimmed = typeof token === 'string' ? token.trim() : ''
  if (trimmed) headers.Authorization = `Bearer ${trimmed}`
  if (role) headers['X-Agent-Role'] = role
  // A blank identity is still omitted rather than replaced by the fallback: no
  // caller supplied one, so there is nothing to stand in for.
  const agent = typeof agentId === 'string' ? agentId.trim() : ''
  if (agent) headers['X-Agent-Id'] = headerSafeAgentId(agent)
  return headers
}
