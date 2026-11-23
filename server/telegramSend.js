/**
 * Small, dependency-free Telegram Bot API sender (sendMessage only).
 *
 * Used by the public Report-a-bug / Request-a-feature route
 * (routes/bugReports.js), which needs a SYNCHRONOUS outcome — the visitor is
 * told whether the report arrived — unlike the fire-and-forget reclaim
 * notifier (notifier.js), the deploy-drift alert (deployDrift.js) and the
 * daily backup (telegramBackup.js), which keep their own long-tested senders.
 * The transport rules mirror those modules (and the ranban reference
 * notifier):
 *   - Telegram HTML parse mode; only `& < >` are markup, so only those are
 *     escaped (htmlEscape).
 *   - `disable_web_page_preview: true` so a URL in a report never unfurls.
 *   - One retry on HTTP 429 when `parameters.retry_after` is <= 10 s; a
 *     longer wait fails at once. Either way a shared pause (below) makes
 *     further report sends fail fast until the wait (capped 60 s) is over.
 *   - A per-attempt timeout.
 *   - NEVER throws and never returns or logs the bot token: the token lives
 *     in the request URL, so any error text is scrubbed before it leaves.
 */

export const TELEGRAM_TEXT_LIMIT = 4096;
export const DEFAULT_TELEGRAM_API_URL = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRY_AFTER_S = 10;
export const MAX_PAUSE_S = 60;

/**
 * True when the process looks like a production deployment: NODE_ENV is
 * "production", or Railway's runtime variables are present. Used to refuse
 * local-only test/stub overrides (see routes/bugReports.js).
 */
export function isProductionRuntime(env = process.env) {
  return Boolean(
    env.NODE_ENV === 'production' || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID,
  );
}

// ---------------------------------------------------------------------------
// Shared 429 pause. The report route, the reclaim notifier and the daily
// backup all post through the SAME bot. When Telegram answers 429 to a
// report send, every report send fails fast (no outbound call) until the
// `retry_after` window (capped at MAX_PAUSE_S) has passed, so anonymous
// report traffic cannot keep the bot rate-limited and starve the alerts and
// the backup. Only callers of sendTelegramMessage (the report route) are
// paused; notifier.js, deployDrift.js and telegramBackup.js keep their own
// senders and behaviour unchanged.
// ---------------------------------------------------------------------------
let pausedUntil = 0;

/** Epoch ms until which report sends are paused (0 = not paused). */
export function telegramPausedUntil() {
  return pausedUntil;
}

/** Test helper: clear the shared pause. */
export function resetTelegramPause() {
  pausedUntil = 0;
}

/** Only the three characters Telegram's HTML parser treats as markup. */
export function htmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Removes `secret` (raw and JSON-escaped) from `text`. Short/unset secrets are ignored. */
export function scrubSecret(text, secret) {
  let out = String(text ?? '');
  if (!secret || String(secret).length < 8) return out;
  out = out.split(secret).join('[redacted]');
  const escaped = JSON.stringify(String(secret)).slice(1, -1);
  if (escaped !== secret) out = out.split(escaped).join('[redacted]');
  const encoded = encodeURIComponent(String(secret));
  if (encoded !== secret) out = out.split(encoded).join('[redacted]');
  return out;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST one sendMessage. Resolves to
 *   { ok: true,  status, attempts }
 *   { ok: false, status | null, networkError, description, attempts }
 * where `description` is Telegram's own error text with the token scrubbed
 * (still untrusted: the caller must sanitise it before logging). Never rejects.
 *
 * @param {object} opts
 * @param {string} opts.botToken
 * @param {string} opts.chatId
 * @param {string} opts.text      Telegram-HTML, already escaped and <= 4096 chars
 * @param {string} [opts.apiUrl]  Bot API base (default https://api.telegram.org)
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(ms:number)=>Promise<void>} [opts.sleep]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxRetryAfterS]
 */
export async function sendTelegramMessage({
  botToken,
  chatId,
  text,
  apiUrl = DEFAULT_TELEGRAM_API_URL,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetryAfterS = DEFAULT_MAX_RETRY_AFTER_S,
  now = Date.now,
} = {}) {
  if (now() < pausedUntil) {
    return {
      ok: false,
      status: 429,
      networkError: false,
      paused: true,
      description: 'paused after a recent Telegram 429',
      attempts: 0,
    };
  }

  const base = String(apiUrl || DEFAULT_TELEGRAM_API_URL).replace(/\/+$/, '');
  const url = `${base}/bot${botToken}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  let attempts = 0;
  for (;;) {
    attempts += 1;
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return {
        ok: false,
        status: null,
        networkError: true,
        description: scrubSecret(err && err.name ? err.name : 'network error', botToken),
        attempts,
      };
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.status === 429) {
      const raw = Number(data?.parameters?.retry_after);
      const secs = Number.isFinite(raw) && raw >= 0 ? raw : 1;
      pausedUntil = Math.max(pausedUntil, now() + Math.min(secs, MAX_PAUSE_S) * 1000);
      // One retry, only when Telegram's wait is short enough to sit out
      // inside a request. A longer wait fails now (retrying early would only
      // earn another 429 on the shared bot); the pause covers the rest.
      if (attempts < 2 && secs <= maxRetryAfterS) {
        await sleep(secs * 1000);
        continue;
      }
    }

    if (res.ok && data && data.ok === true) return { ok: true, status: res.status, attempts };

    const description =
      data && typeof data.description === 'string'
        ? data.description
        : res.ok
          ? 'response was not ok:true'
          : '';
    return {
      ok: false,
      status: res.status,
      networkError: false,
      description: scrubSecret(description, botToken),
      attempts,
    };
  }
}
