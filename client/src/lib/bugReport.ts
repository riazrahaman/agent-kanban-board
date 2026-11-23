/**
 * Pure logic for the "Report a Bug/Request a feature" form (v2.16.0,
 * opt-public-bug-reports; delivered to the owner on Telegram since the
 * GitHub-issue path was retired).
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

// Characters the server always strips and that render as nothing: every
// default-ignorable code point, the Braille blank, the interlinear and
// Egyptian format controls, the musical null notehead (U+1D159), lone
// surrogates, and whitespace. A title or description made only of them is
// certainly rejected server-side, so the form says so first.
const ALWAYS_BLANK_RE = /^[\s\p{Default_Ignorable_Code_Point}\u2800\uFFF9-\uFFFB\u{13430}-\u{1343F}\u{1D159}\uD800-\uDFFF]*$/u

/** True when the text has no visible character at all (a cheap pre-check). */
export function isBlankText(text: string): boolean {
  return ALWAYS_BLANK_RE.test(text)
}

/**
 * A light check, NOT the server's cleaning: it trims whitespace and rejects a
 * title that is empty or made only of invisible characters. The server still
 * strips invisible characters in context (for example a variation selector
 * after another invisible one) and has the final word; its 400 is shown by
 * describeSubmitError.
 */
export function validateTitle(title: string): string | undefined {
  const trimmed = title.trim()
  if (trimmed.length < TITLE_MIN || isBlankText(trimmed)) return 'Title is empty or only invisible characters.'
  if (trimmed.length > TITLE_MAX) return `Title must be ${TITLE_MAX} characters or fewer.`
  return undefined
}

export function validateDescription(description: string): string | undefined {
  const trimmed = description.trim()
  if (isBlankText(trimmed)) return 'Description is empty or only invisible characters.'
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
  if (status === 502) return 'Could not send right now. Please try again later.'
  if (status === 403) {
    if (code === 'invalid_captcha_action' || code === 'invalid_captcha_hostname') {
      return 'Verification failed. Please try again.'
    }
    return 'Verification failed or expired. Please try again.'
  }
  if (status === 400) {
    if (code === 'invalid_title') {
      return `Title is empty or only invisible characters, or longer than ${TITLE_MAX} characters.`
    }
    if (code === 'invalid_description') {
      return `Description must be ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} characters.`
    }
    return 'Please check the form and try again.'
  }
  return 'Something went wrong. Please try again.'
}
