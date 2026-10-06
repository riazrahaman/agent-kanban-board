/**
 * Pure logic for the "Report a bug" form (v2.16.0, opt-public-bug-reports).
 * Mirrors the server's own limits (`server/routes/bugReports.js`) so the UI
 * can reject obviously-invalid input before ever spending a Turnstile token
 * or a network round trip — the server re-validates everything regardless,
 * this is purely a faster/friendlier first pass.
 *
 * No network calls live here; those are in `api.ts`
 * (`getBugReportConfig` / `submitBugReport`), matching the rest of the app's
 * split between pure logic (`lib/`) and transport (`api.ts`).
 */

export const TITLE_MIN = 1
export const TITLE_MAX = 120
export const DESCRIPTION_MIN = 10
export const DESCRIPTION_MAX = 5000

/** The honeypot field name, shared by the form and the payload builder. */
export const HONEYPOT_FIELD = 'website'

/** The Turnstile `action` the server requires (server/routes/bugReports.js). */
export const TURNSTILE_ACTION = 'bug-report'

export type FieldErrors = {
  title?: string
  description?: string
}

/**
 * Trims the way the server does (`stripControlChars(title).trim()`) before
 * measuring length, so a title that is all whitespace reads as empty here
 * exactly like it would server-side — the counter and the submit gate agree.
 */
export function validateTitle(title: string): string | undefined {
  const trimmed = title.trim()
  if (trimmed.length < TITLE_MIN) return 'Title is required.'
  if (trimmed.length > TITLE_MAX) return `Title must be ${TITLE_MAX} characters or fewer.`
  return undefined
}

export function validateDescription(description: string): string | undefined {
  const trimmed = description.trim()
  if (trimmed.length < DESCRIPTION_MIN) {
    return `Description must be at least ${DESCRIPTION_MIN} characters.`
  }
  if (trimmed.length > DESCRIPTION_MAX) {
    return `Description must be ${DESCRIPTION_MAX} characters or fewer.`
  }
  return undefined
}

export function validateBugReport(title: string, description: string): FieldErrors {
  const errors: FieldErrors = {}
  const titleError = validateTitle(title)
  const descriptionError = validateDescription(description)
  if (titleError) errors.title = titleError
  if (descriptionError) errors.description = descriptionError
  return errors
}

/** `true` when the fields pass client-side validation AND a captcha token exists. */
export function canSubmitBugReport(title: string, description: string, turnstileToken: string | null): boolean {
  if (!turnstileToken) return false
  const errors = validateBugReport(title, description)
  return !errors.title && !errors.description
}

/** `max - length`, floored at a negative count (shown in red by the caller). */
export function remainingChars(value: string, max: number): number {
  return max - value.length
}

/** `WIDTHxHEIGHT`, the shape the server's `meta.viewport` expects. */
export function formatViewport(width: number, height: number): string {
  return `${Math.round(width)}x${Math.round(height)}`
}

export type BugReportPayload = {
  title: string
  description: string
  turnstileToken: string
  website: string
  meta: { viewport: string }
}

/**
 * Builds the exact POST body. `website` is empty on a real form submit — it
 * only carries a value when a bot fills every field, which is precisely what
 * the server's honeypot check is watching for.
 */
export function buildBugReportPayload(opts: {
  title: string
  description: string
  turnstileToken: string
  viewport: string
  website?: string
}): BugReportPayload {
  return {
    title: opts.title.trim(),
    description: opts.description.trim(),
    turnstileToken: opts.turnstileToken,
    website: opts.website ?? '',
    meta: { viewport: opts.viewport },
  }
}

/**
 * Maps a failed submit's `{status, error}` to the exact copy the form
 * should show. Codes are the server's (routes/bugReports.js); unrecognised
 * ones fall back to a status-shaped generic message rather than throwing.
 */
export function describeSubmitError(status: number, code?: string): string {
  if (status === 429) return 'Too many reports, try later.'
  if (status === 502) return 'Could not file the report, please try again.'
  if (status === 403) {
    if (code === 'invalid_captcha_action' || code === 'invalid_captcha_hostname') {
      return 'Verification failed. Please try again.'
    }
    return 'Verification failed or expired. Please try again.'
  }
  if (status === 400) {
    if (code === 'invalid_title') return `Title must be ${TITLE_MIN}-${TITLE_MAX} characters.`
    if (code === 'invalid_description') {
      return `Description must be ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} characters.`
    }
    return 'Please check the form and try again.'
  }
  return 'Something went wrong. Please try again.'
}
