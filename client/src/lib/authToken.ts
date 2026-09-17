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
 */
export function authHeaders(
  token: string | null | undefined,
  role: string = CLIENT_ROLE,
): Record<string, string> {
  const headers: Record<string, string> = {}
  const trimmed = typeof token === 'string' ? token.trim() : ''
  if (trimmed) headers.Authorization = `Bearer ${trimmed}`
  if (role) headers['X-Agent-Role'] = role
  return headers
}
