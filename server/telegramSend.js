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
 *   - One retry on HTTP 429, honouring `parameters.retry_after` (capped, so
 *     an upstream "retry in an hour" can never park a request handler).
 *   - A per-attempt timeout.
 *   - NEVER throws and never returns or logs the bot token: the token lives
 *     in the request URL, so any error text is scrubbed before it leaves.
 */

export const TELEGRAM_TEXT_LIMIT = 4096;
export const DEFAULT_TELEGRAM_API_URL = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRY_AFTER_S = 10;

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
} = {}) {
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

    if (res.status === 429 && attempts < 2) {
      const raw = Number(data?.parameters?.retry_after);
      const secs = Number.isFinite(raw) && raw >= 0 ? raw : 1;
      await sleep(Math.min(secs, maxRetryAfterS) * 1000);
      continue;
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
