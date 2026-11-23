import express from 'express';
import { APP_VERSION } from '../version.js';
import {
  DEFAULT_TELEGRAM_API_URL,
  TELEGRAM_TEXT_LIMIT,
  htmlEscape,
  isProductionRuntime,
  scrubSecret,
  sendTelegramMessage,
} from '../telegramSend.js';

/**
 * In-app "Report a Bug/Request a feature" -> ONE private Telegram message to
 * the board owner (v2.16.0 filed a public GitHub issue; switched to Telegram
 * at the owner's request, card bug-report-to-telegram).
 *
 * UNAUTHENTICATED by design: this is the one human-facing write endpoint on
 * the board, meant for an anonymous visitor who has no `x-api-token`. It is
 * mounted in server.js BEFORE the auth and rate-limit middleware so it never
 * needs a board token and is never subject to the per-project mutation
 * limiter — see server.js for the exact mount order and why it must stay
 * there (and `kanban.bugreports.test.js` for the regression guard that every
 * OTHER route still requires the token). It creates NO board card and no
 * GitHub issue: the report exists only as the Telegram message.
 *
 * Off unless ALL of these resolve:
 *   TURNSTILE_SECRET            (secret)  Cloudflare Turnstile secret key
 *   TURNSTILE_SITE_KEY          (public)  served to the browser via /config
 *   KANBAN_TELEGRAM_BOT_TOKEN   (secret)  the SAME bot as the reclaim alerts
 *                                          and the daily backup
 *   a chat id: KANBAN_REPORT_TELEGRAM_CHAT_ID if set (so reports can go to a
 *              dedicated channel/chat), else KANBAN_TELEGRAM_CHAT_ID. The bot
 *              must be a member (for a channel: an admin allowed to post) of
 *              that chat.
 * Optional:
 *   TURNSTILE_HOSTNAMES                   comma list; siteverify hostname
 *                                          must be in it. Unset = skipped,
 *                                          with one startup warning.
 *   KANBAN_REPORT_DAILY_CAP               global cap per rolling 24 h (default 50)
 *   KANBAN_REPORT_PER_IP_PER_HOUR         per-IP cap/hour (default 3)
 *   KANBAN_REPORT_TELEGRAM_API_URL        Bot API base (default
 *                                          https://api.telegram.org) — lets
 *                                          tests/demo point at a local stub
 *                                          (see scripts/stub-telegram.mjs).
 *   KANBAN_BOARD_URL                      when set, shown in the message footer.
 *   TURNSTILE_SITEVERIFY_URL              siteverify URL override for local
 *                                          stubs (default Cloudflare's).
 *   Both local-stub overrides are IGNORED (real endpoints, one startup
 *   warning naming the variable) when NODE_ENV=production or Railway's
 *   RAILWAY_ENVIRONMENT / RAILWAY_PROJECT_ID is set.
 * The pre-Telegram KANBAN_REPORT_GITHUB_TOKEN / KANBAN_REPORT_REPO /
 * KANBAN_REPORT_GITHUB_API_URL are no longer read at all.
 *
 * Failure logging: one line per failed request (not per attempt) for every
 * Telegram-delivery or Turnstile-verification failure, prefixed
 * `[kanban bug-report]` (HTTP status or network error, Telegram's own
 * `description`, attempt count and a human hint — or the Turnstile
 * `error-codes`), rate-limited to at most one line per 60 seconds per kind
 * (see logRateLimited). Every remote/untrusted value that reaches a log line
 * goes through `safeLogValue` first. NEVER logged: the bot token (it is in
 * the request URL; scrubbed from any error text), the Turnstile secret, the
 * report's title/description or the rendered message, and the client IP.
 * The visitor's IP is used for the per-IP limit and Turnstile's `remoteip`
 * only; it is never put into the Telegram message.
 */

// Strips C0/DEL control characters but keeps newlines/tabs — descriptions are
// free text and may legitimately contain them.
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
export function stripControlChars(str) {
  return String(str).replace(CONTROL_CHARS_RE, '');
}

// Invisible formatting characters removed from ALL report text (title,
// description, user agent), both before validation and before rendering, so
// what is validated is exactly what is sent: C1 controls, the Unicode
// line/paragraph separators, the bidi embedding/override/isolate controls,
// the LRM/RLM/ALM marks (U+200E, U+200F, U+061C), zero-width space and
// non-joiner (U+200B, U+200C), word joiner (U+2060) and BOM (U+FEFF).
// Natural right-to-left text needs none of these (the renderer handles RTL
// scripts on its own); they can only hide text or make it read differently.
const EXTRA_INVISIBLE_RE = /[\u0080-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069\u200B\u200C\u200E\u200F\u2060\uFEFF\u061C]/g;

// ZERO WIDTH JOINER (U+200D) is kept only where it glues two pictographs of
// an emoji ZWJ sequence (e.g. woman + skin tone + ZWJ + laptop); anywhere
// else it is removed like the characters above.
const STRAY_ZWJ_RE = /(?<!\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}\uFE0F]?)\u200D|\u200D(?!\p{Extended_Pictographic})/gu;

// Lone UTF-16 surrogates (half of a pair with its other half missing). With
// the `u` flag a well-formed pair is one astral code point, so this class
// matches only the lone halves; real emoji are untouched.
const LONE_SURROGATE_RE = /[\uD800-\uDFFF]/gu;

// U+2800 BRAILLE PATTERN BLANK is the word space of Braille text: it becomes
// an ordinary space (so Braille words stay apart, and text made only of it is
// trimmed to nothing). The dot patterns U+2801-U+28FF are untouched.
const BRAILLE_BLANK_RE = /\u2800/g;

// Every other Default_Ignorable_Code_Point renders as nothing: the soft
// hyphen, combining grapheme joiner, Hangul fillers (U+115F, U+1160, U+3164,
// U+FFA0), Khmer inherent vowels (U+17B4/5), Mongolian vowel separator,
// invisible operators (U+2061-U+2064), deprecated format controls,
// variation selectors, tag characters and the unassigned ignorables. A text
// made only of them looks blank, so they are removed (the characters already
// in EXTRA_INVISIBLE_RE and the ZWJ are ignorable too and handled there),
// EXCEPT where they are part of real text, decided by keepIgnorable below.
const DEFAULT_IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/gu;
const EMOJI_RE = /^\p{Emoji}$/u;
const VISIBLE_BASE_RE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;
const HANGUL_CHOSEONG_RE = /^[\u1100-\u115E\uA960-\uA97C]$/u;
const HANGUL_JUNGSEONG_RE = /^[\u1161-\u11A7\uD7B0-\uD7C6]$/u;
const MONGOLIAN_LETTER_RE = /^[\u1820-\u1878\u1880-\u18AA]$/u;
// A subdivision flag (England, Scotland, Wales): U+1F3F4 + tag letters/digits
// + CANCEL TAG U+E007F. Only tags inside such a run survive.
const TAG_FLAG_RE = /\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]+\u{E007F}/gu;

/** The code point that ends `str` just before UTF-16 index `offset`, as a string. */
function charBefore(str, offset) {
  if (offset <= 0) return '';
  const low = str.charCodeAt(offset - 1);
  if (low >= 0xdc00 && low <= 0xdfff && offset >= 2) {
    const high = str.charCodeAt(offset - 2);
    if (high >= 0xd800 && high <= 0xdbff) return str.slice(offset - 2, offset);
  }
  return str[offset - 1];
}

/** Should the ignorable `ch` at `offset` stay because it belongs to real text? */
function keepIgnorable(ch, offset, str) {
  const cp = ch.codePointAt(0);
  const prev = charBefore(str, offset);
  // ZWJ: left to STRAY_ZWJ_RE (kept only inside an emoji ZWJ sequence).
  if (cp === 0x200d) return true;
  // VS15/VS16 (text/emoji presentation): only right after an emoji base
  // (which includes keycap bases 0-9 # *). A lone U+FE0F goes.
  if (cp === 0xfe0e || cp === 0xfe0f) return EMOJI_RE.test(prev);
  // Other variation selectors (standardized and ideographic variants): only
  // right after a visible base character.
  if ((cp >= 0xfe00 && cp <= 0xfe0d) || (cp >= 0xe0100 && cp <= 0xe01ef)) return VISIBLE_BASE_RE.test(prev);
  // Hangul jamo fillers: kept only where they build an old-style syllable
  // block (choseong filler + a real vowel; a real initial + jungseong filler).
  if (cp === 0x115f) return HANGUL_JUNGSEONG_RE.test(str[offset + 1] ?? '');
  if (cp === 0x1160) return HANGUL_CHOSEONG_RE.test(prev);
  // Mongolian free variation selectors and vowel separator: only inside
  // Mongolian words.
  if (cp >= 0x180b && cp <= 0x180f) return MONGOLIAN_LETTER_RE.test(prev);
  return false;
}

function stripIgnorable(str) {
  // Whole subdivision flags are copied through untouched; the text between
  // them is filtered, so every other tag character is dropped.
  let out = '';
  let last = 0;
  for (const m of str.matchAll(TAG_FLAG_RE)) {
    out += stripIgnorableRun(str.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + stripIgnorableRun(str.slice(last));
}

function stripIgnorableRun(str) {
  return str.replace(DEFAULT_IGNORABLE_RE, (ch, offset, whole) => (keepIgnorable(ch, offset, whole) ? ch : ''));
}

function stripInvisible(str) {
  const text = String(str ?? '').replace(LONE_SURROGATE_RE, '').replace(BRAILLE_BLANK_RE, ' ');
  return stripIgnorable(text.replace(EXTRA_INVISIBLE_RE, '')).replace(STRAY_ZWJ_RE, '');
}

/** Free text for the message body: control chars gone, newlines/tabs kept. */
export function cleanMultiline(str) {
  return stripInvisible(stripControlChars(str ?? '').replace(/\r\n?/g, '\n'));
}

/** One-line text (title, user agent): every control char and newline becomes a space. */
export function cleanOneLine(str) {
  return stripInvisible(String(str ?? '').replace(/[\x00-\x1F\x7F]+/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Text OUTSIDE the <pre> block (title, user agent) is scanned by Telegram for
 * entities: `@name` becomes a clickable mention and `scheme://...` a link. A
 * zero-width space after every `@` and inside every `://` keeps both as
 * plain text. Text inside <pre> is not entity-parsed, so the description
 * needs only HTML escaping.
 */
export function neutralizeEntities(str) {
  return String(str ?? '')
    .replace(/@/g, '@\u200B')
    .replace(/:\/\//g, ':\u200B//');
}

const VIEWPORT_RE = /^\d{1,5}x\d{1,5}$/;
const USER_AGENT_MAX = 200;
export const REPORT_HEADER = '🐞 <b>Report a Bug/Request a feature</b>';

/**
 * Escapes `raw` for Telegram HTML, cutting at a whole character (never
 * inside an `&amp;` entity or a surrogate pair) so the escaped result is at
 * most `budget` UTF-16 units. Returns { text, omitted } where omitted is the
 * number of characters of `raw` that did not fit.
 */
export function escapeWithin(raw, budget) {
  const chars = Array.from(String(raw ?? ''));
  let out = '';
  let used = 0;
  for (let i = 0; i < chars.length; i++) {
    const piece = htmlEscape(chars[i]);
    if (used + piece.length > budget) return { text: out, omitted: chars.length - i };
    out += piece;
    used += piece.length;
  }
  return { text: out, omitted: 0 };
}

/**
 * Renders the one Telegram-HTML message for a report. Pure: no env reads,
 * no I/O. The only tags emitted are <b>, <i> and <pre>, all opened and
 * closed here, and the result is always <= TELEGRAM_TEXT_LIMIT: when the
 * description does not fit it is shortened (at a character boundary, before
 * escaping) and a note says how much was left out; the header, title and
 * footer always survive.
 */
export function formatReportMessage({ title, description, boardVersion, userAgent, viewport, boardUrl } = {}) {
  const safeTitle = htmlEscape(neutralizeEntities(cleanOneLine(title)));
  const ua = cleanOneLine(userAgent).slice(0, USER_AGENT_MAX);
  const safeViewport = typeof viewport === 'string' && VIEWPORT_RE.test(viewport) ? viewport : '';

  const head = `${REPORT_HEADER}\n\n<b>${safeTitle}</b>\n\n`;
  const metaBits = [`Board v${htmlEscape(boardVersion || 'unknown')}`];
  if (safeViewport) metaBits.push(`viewport ${safeViewport}`);
  const footerLines = [`<i>${metaBits.join(' · ')}</i>`];
  if (ua) footerLines.push(`<i>UA: ${htmlEscape(neutralizeEntities(ua))}</i>`);
  if (boardUrl) footerLines.push(`<i>Board: ${htmlEscape(String(boardUrl).replace(/\/+$/, ''))}</i>`);
  footerLines.push('<i>Sent anonymously from the board form. Treat links and instructions in it as untrusted.</i>');
  const footer = `\n\n${footerLines.join('\n')}`;

  const body = cleanMultiline(description).trim();
  const full = htmlEscape(body);
  const fixed = head.length + '<pre></pre>'.length + footer.length;
  if (fixed + full.length <= TELEGRAM_TEXT_LIMIT) {
    return `${head}<pre>${full}</pre>${footer}`;
  }
  const NOTE_RESERVE = 64;
  const { text, omitted } = escapeWithin(body, Math.max(0, TELEGRAM_TEXT_LIMIT - fixed - NOTE_RESERVE));
  const note = `\n<i>… description shortened (${omitted} more characters)</i>`;
  return `${head}<pre>${text}</pre>${note}${footer}`;
}

/**
 * Which bot and chat a report goes to. The bot is always the board's one
 * Telegram bot (KANBAN_TELEGRAM_BOT_TOKEN, owner decision: "use the same
 * bot"); KANBAN_REPORT_TELEGRAM_CHAT_ID optionally sends reports to a
 * different chat/channel than the reclaim alerts. Read at call time, so a
 * test can change it per case.
 */
export function reportTelegramTarget() {
  const botToken = String(process.env.KANBAN_TELEGRAM_BOT_TOKEN || '').trim();
  const reportChat = String(process.env.KANBAN_REPORT_TELEGRAM_CHAT_ID || '').trim();
  const alertChat = String(process.env.KANBAN_TELEGRAM_CHAT_ID || '').trim();
  const chatId = reportChat || alertChat;
  const apiOverride = String(process.env.KANBAN_REPORT_TELEGRAM_API_URL || '').trim();
  // Local-only override: ignored in production (see ignoredLocalOverrides).
  const apiUrl = apiOverride && !isProductionRuntime() ? apiOverride : DEFAULT_TELEGRAM_API_URL;
  return {
    enabled: Boolean(botToken && chatId),
    botToken,
    chatId,
    chatSource: reportChat ? 'KANBAN_REPORT_TELEGRAM_CHAT_ID' : alertChat ? 'KANBAN_TELEGRAM_CHAT_ID' : null,
    apiUrl,
  };
}

function boardVersion() {
  // C4 (v3.12.5): same helper as /api/health, resolved relative to the module
  // instead of `process.cwd()` — so the message can never report a different
  // version than the health endpoint. Falls back to 'unknown' internally.
  return APP_VERSION;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function getDailyCap() {
  const n = parseInt(process.env.KANBAN_REPORT_DAILY_CAP, 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

function getPerIpHourlyLimit() {
  const n = parseInt(process.env.KANBAN_REPORT_PER_IP_PER_HOUR, 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

function turnstileConfigured() {
  return Boolean(process.env.TURNSTILE_SECRET && process.env.TURNSTILE_SITE_KEY);
}

function isConfigured() {
  return turnstileConfigured() && reportTelegramTarget().enabled;
}

const LOG_PREFIX = '[kanban bug-report]';

// Cloudflare's siteverify endpoint. TURNSTILE_SITEVERIFY_URL overrides it for
// local demos/e2e runs only (scripts/stub-telegram.mjs serves a stand-in), so a
// test never calls Cloudflare.
const TURNSTILE_SITEVERIFY_DEFAULT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Siteverify URL: the local-stub override is honoured only outside production. */
export function turnstileSiteverifyUrl() {
  const override = String(process.env.TURNSTILE_SITEVERIFY_URL || '').trim();
  return override && !isProductionRuntime() ? override : TURNSTILE_SITEVERIFY_DEFAULT;
}

/**
 * Names of the local-only overrides that are set but IGNORED because the
 * process is a production deployment (NODE_ENV=production, or Railway's
 * RAILWAY_ENVIRONMENT / RAILWAY_PROJECT_ID). Never returns values.
 */
export function ignoredLocalOverrides() {
  if (!isProductionRuntime()) return [];
  const names = [];
  if (String(process.env.KANBAN_REPORT_TELEGRAM_API_URL || '').trim()) names.push('KANBAN_REPORT_TELEGRAM_API_URL');
  if (String(process.env.TURNSTILE_SITEVERIFY_URL || '').trim()) names.push('TURNSTILE_SITEVERIFY_URL');
  return names;
}

/** Loose shape check: Cloudflare Turnstile site keys are a short opaque
 * token with no whitespace; this does not try to validate the real format,
 * only catch an obviously-wrong value (empty, too short, containing spaces). */
export function looksLikeTurnstileSiteKey(key) {
  return typeof key === 'string' && /^[0-9a-zA-Z_-]{10,}$/.test(key);
}

// C0 (0x00-0x1F), DEL (0x7F) and C1 (0x80-0x9F) control characters, plus the
// Unicode LINE SEPARATOR (U+2028) and PARAGRAPH SEPARATOR (U+2029) — neither
// is a control character by Unicode category, but both still break a
// console line in two, so safeLogValue strips them alongside the rest.
const CONTROL_AND_LINE_SEP_RE = new RegExp('[\\x00-\\x1F\\x7F-\\x9F\\u2028\\u2029]', 'g');

/**
 * The one sanitizer for EVERY remote/untrusted value this router ever logs:
 * Telegram's `description`, Cloudflare's `error-codes`/`action`/`hostname`.
 * Strips every C0/C1 control character and the Unicode line/paragraph
 * separators (so the value can never inject a raw control byte or split the
 * line), collapses whitespace, caps the length, then JSON-quotes the result
 * so it is unambiguously delimited from the next field in the rendered line.
 *
 * Callers that also need secret redaction MUST redact the raw value first and
 * pass the redacted string in here — redaction has to run before this
 * truncates, or a secret straddling the length cut would leak its surviving
 * prefix.
 */
export function safeLogValue(value, maxLength = 160) {
  let out = String(value ?? '')
    .replace(CONTROL_AND_LINE_SEP_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > maxLength) out = out.slice(0, maxLength);
  return JSON.stringify(out);
}

/** Short human hint keyed on the Telegram HTTP status, for the failure log line. */
export function hintForTelegramStatus(status) {
  switch (status) {
    case 400:
      return 'bad request: chat id wrong (chat not found) or message rejected';
    case 401:
      return 'bot token invalid/revoked (KANBAN_TELEGRAM_BOT_TOKEN)';
    case 403:
      return 'bot is not a member of the chat or may not post there (make it a channel admin)';
    case 404:
      return 'wrong bot token or KANBAN_REPORT_TELEGRAM_API_URL';
    case 429:
      return 'Telegram rate limit; retry later';
    default:
      return status >= 500 ? 'Telegram outage' : 'unexpected Telegram response';
  }
}

/**
 * @param {object} deps
 * @param {typeof fetch} [deps.fetch] injectable so tests never hit the
 *   network (Turnstile siteverify + the Telegram Bot API both go through it).
 * @param {(ms:number)=>Promise<void>} [deps.sleep] injectable wait used for
 *   the single 429 `retry_after` back-off, so tests do not actually sleep.
 * @param {() => number} [deps.now] injectable clock for the rate-limit tests.
 */
export function createBugReportsRouter(deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || (() => Date.now());
  const BOARD_VERSION = boardVersion();
  const router = express.Router();

  // A local-only stub override left set on a production deployment would
  // silently replace real captcha verification or real delivery, so it is
  // ignored there (the real endpoint is used) and named loudly once.
  for (const name of ignoredLocalOverrides()) {
    console.warn(
      `${LOG_PREFIX} WARNING: ${name} is set but IGNORED: it is a local test/stub override and this is a ` +
        'production runtime (NODE_ENV=production or Railway). The real endpoint is used. Unset it.',
    );
  }

  // One-time startup warnings, evaluated at router creation (≈ process
  // startup). An operator who configured Turnstile (the visible half of the
  // feature) but has no bot/chat gets a loud reason why the bug icon is
  // hidden, instead of a silently missing feature.
  if (turnstileConfigured()) {
    const target = reportTelegramTarget();
    if (!target.botToken) {
      console.warn(
        `${LOG_PREFIX} WARNING: Report-a-bug is DISABLED: KANBAN_TELEGRAM_BOT_TOKEN is unset, ` +
          'so reports have nowhere to go (the header bug icon stays hidden).',
      );
    } else if (!target.chatId) {
      console.warn(
        `${LOG_PREFIX} WARNING: Report-a-bug is DISABLED: neither KANBAN_REPORT_TELEGRAM_CHAT_ID nor ` +
          'KANBAN_TELEGRAM_CHAT_ID is set, so reports have nowhere to go (the header bug icon stays hidden).',
      );
    }
    if (target.enabled) {
      // TURNSTILE_HOSTNAMES is optional, but an operator who configured the
      // feature and forgot it gets a nudge instead of a silent gap in the
      // hostname allowlist check.
      if (!process.env.TURNSTILE_HOSTNAMES) {
        console.warn(
          `${LOG_PREFIX} TURNSTILE_HOSTNAMES is unset: siteverify responses are ` +
            'accepted from any hostname. Set it to a comma-separated allow-list to pin ' +
            'reports to your deployed origin(s).',
        );
      }
      if (!looksLikeTurnstileSiteKey(process.env.TURNSTILE_SITE_KEY)) {
        console.warn(
          `${LOG_PREFIX} WARNING: TURNSTILE_SITE_KEY does not look like a Cloudflare Turnstile site key (placeholder?)`,
        );
      }
    }
  }

  // Per-process log de-duplication: the SAME kind of event (same Telegram
  // status or network error, or the same Turnstile check) logs at most once
  // per LOG_WINDOW_MS, so a spam flood — or a real Telegram outage making
  // every request fail the same way — cannot fill the deploy log.
  const LOG_WINDOW_MS = 60 * 1000;
  const lastLoggedAt = new Map();

  // Defense in depth on every line we emit: the bot token and the Turnstile
  // secret are removed (raw, JSON-escaped and URL-encoded forms) even though
  // no code path is meant to put them there.
  function redactSecrets(str) {
    let out = String(str);
    for (const secret of [process.env.KANBAN_TELEGRAM_BOT_TOKEN, process.env.TURNSTILE_SECRET]) {
      out = scrubSecret(out, secret);
    }
    return out;
  }

  function logRateLimited(key, level, line) {
    const nowTs = now();
    const last = lastLoggedAt.get(key);
    if (last !== undefined && nowTs - last < LOG_WINDOW_MS) return;
    lastLoggedAt.set(key, nowTs);
    console[level](redactSecrets(line));
  }

  router.get('/config', (req, res) => {
    if (!isConfigured()) return res.json({ enabled: false });
    res.json({ enabled: true, siteKey: process.env.TURNSTILE_SITE_KEY });
  });

  // ---------------------------------------------------------------------
  // In-memory rate limiting. Bounded + pruned (see pruneIpLimits below), but
  // process-local: counters reset on restart/redeploy. That is an accepted
  // trade for zero infra — this guards abuse, not a hard financial ceiling.
  //
  // Checks are PEEK-only (checkRateLimits); the counters are only INCREMENTED
  // on a fully successful report (consumeRateLimits, called after Telegram
  // accepted the message). That is what makes "counts only on success" true without
  // needing to roll an increment back — a request that fails validation,
  // captcha, or Telegram delivery never touches these counters at all. The
  // trade-off: under concurrent requests there is a window between the peek
  // and the eventual consume (spanning two outbound HTTP calls) where more
  // requests than the cap can be in flight at once, so a large simultaneous
  // burst can overshoot the cap by the size of the burst. Acceptable for an
  // abuse guard; not a hard real-time limiter.
  // ---------------------------------------------------------------------
  const globalTimestamps = [];
  const ipTimestamps = new Map(); // ip -> number[]

  function pruneGlobal() {
    const cutoff = now() - DAY_MS;
    while (globalTimestamps.length > 0 && globalTimestamps[0] < cutoff) globalTimestamps.shift();
  }

  function pruneIp(ip) {
    const list = ipTimestamps.get(ip);
    if (!list) return [];
    const cutoff = now() - HOUR_MS;
    while (list.length > 0 && list[0] < cutoff) list.shift();
    if (list.length === 0) ipTimestamps.delete(ip);
    return list;
  }

  // Sweeps every tracked IP periodically so an IP that stops sending requests
  // is not held in memory forever (the per-request prune above only ever
  // touches the IP making THAT request). Unref'd so it never keeps the
  // process alive, matching the reaper/backup timers elsewhere in server.js.
  const sweepTimer = setInterval(() => {
    pruneGlobal();
    for (const ip of Array.from(ipTimestamps.keys())) pruneIp(ip);
  }, 10 * 60 * 1000);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  function checkRateLimits(ip) {
    pruneGlobal();
    if (globalTimestamps.length >= getDailyCap()) return 'daily_cap_reached';
    const list = pruneIp(ip);
    if (list.length >= getPerIpHourlyLimit()) return 'ip_limit_reached';
    return null;
  }

  function consumeRateLimits(ip) {
    const ts = now();
    globalTimestamps.push(ts);
    if (!ipTimestamps.has(ip)) ipTimestamps.set(ip, []);
    ipTimestamps.get(ip).push(ts);
  }

  // ---------------------------------------------------------------------
  // Turnstile verification
  // ---------------------------------------------------------------------
  async function verifyTurnstile(token, ip) {
    const body = new URLSearchParams({
      secret: process.env.TURNSTILE_SECRET,
      response: token,
      remoteip: ip,
    });

    let res;
    try {
      res = await fetchImpl(turnstileSiteverifyUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      logRateLimited(
        'turnstile:network',
        'warn',
        `${LOG_PREFIX} turnstile verification unavailable: network error reaching Cloudflare siteverify`,
      );
      return { ok: false, status: 502, code: 'verification_unavailable' };
    }

    if (!res.ok) {
      logRateLimited(
        'turnstile:http',
        'warn',
        `${LOG_PREFIX} turnstile verification unavailable: siteverify responded HTTP ${res.status}`,
      );
      return { ok: false, status: 502, code: 'verification_unavailable' };
    }

    let data;
    try {
      data = await res.json();
    } catch {
      logRateLimited(
        'turnstile:badjson',
        'warn',
        `${LOG_PREFIX} turnstile verification unavailable: siteverify response was not valid JSON`,
      );
      return { ok: false, status: 502, code: 'verification_unavailable' };
    }

    // success:false covers both an outright failed challenge and a replayed
    // token — Cloudflare's "already-spent" test secret (3x0000...) always
    // answers success:false with error-codes:["timeout-or-duplicate"], which
    // is exactly what a real secret returns for a token siteverify has
    // already consumed. Both are reported the same way to the caller.
    if (data.success !== true) {
      const codes = Array.isArray(data['error-codes']) ? data['error-codes'] : [];
      const safeCodes = `[${codes.map((c) => safeLogValue(c, 120)).join(',')}]`;
      logRateLimited(
        `turnstile:success-false:${codes.join(',')}`,
        'warn',
        `${LOG_PREFIX} turnstile check failed: success=false error-codes=${safeCodes}`,
      );
      return { ok: false, status: 403, code: 'invalid_captcha' };
    }
    if (data.action !== 'bug-report') {
      logRateLimited(
        'turnstile:action-mismatch',
        'warn',
        `${LOG_PREFIX} turnstile check failed: action mismatch (expected "bug-report", got ${safeLogValue(data.action, 120)})`,
      );
      return { ok: false, status: 403, code: 'invalid_captcha_action' };
    }

    const allowlist = (process.env.TURNSTILE_HOSTNAMES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowlist.length > 0 && !allowlist.includes(data.hostname)) {
      logRateLimited(
        'turnstile:hostname-mismatch',
        'warn',
        `${LOG_PREFIX} turnstile check failed: hostname mismatch (got ${safeLogValue(data.hostname, 120)})`,
      );
      return { ok: false, status: 403, code: 'invalid_captcha_hostname' };
    }

    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // Telegram delivery: one sendMessage, one retry on 429 honouring
  // `retry_after` (capped at 10s so a visitor is never kept waiting long),
  // 10s per-attempt timeout (telegramSend.js). No retry on any other
  // failure: the visitor is told to try again later instead.
  // ---------------------------------------------------------------------
  function logTelegramFailure(result) {
    const statusLabel = result.paused
      ? 'paused (recent 429, no call made)'
      : result.networkError
        ? 'network error'
        : `status=${result.status}`;
    const hint = result.networkError
      ? 'network/DNS error or wrong KANBAN_REPORT_TELEGRAM_API_URL'
      : hintForTelegramStatus(result.status);
    const key = `telegram:${result.paused ? 'paused' : result.networkError ? 'network' : result.status}`;
    // Redact the RAW description first, then sanitise/truncate (see
    // safeLogValue): truncating first could leak a secret's prefix.
    const safeDescription = safeLogValue(redactSecrets(result.description || ''), 160);
    logRateLimited(
      key,
      'error',
      `${LOG_PREFIX} could_not_send: telegram ${statusLabel} description=${safeDescription} ` +
        `attempts=${result.attempts} hint=${JSON.stringify(hint)}`,
    );
  }

  async function deliverReport(title, description, userAgent, viewport) {
    const target = reportTelegramTarget();
    const text = formatReportMessage({
      title,
      description,
      boardVersion: BOARD_VERSION,
      userAgent,
      viewport,
      boardUrl: String(process.env.KANBAN_BOARD_URL || '').trim(),
    });
    let result;
    try {
      result = await sendTelegramMessage({
        botToken: target.botToken,
        chatId: target.chatId,
        text,
        apiUrl: target.apiUrl,
        fetchImpl,
        sleep,
        now, // same injectable clock as the rate limits; drives the shared 429 pause
      });
    } catch {
      // sendTelegramMessage never rejects; belt and braces.
      result = { ok: false, status: null, networkError: true, description: '', attempts: 1 };
    }
    if (!result.ok) {
      logTelegramFailure(result);
      return { ok: false, status: 502, code: 'could_not_send' };
    }
    // Positive delivery proof for the deploy log. The message body is NOT
    // logged (and the URL carries the token), only that a send succeeded.
    console.info(`${LOG_PREFIX} delivered 1 report to telegram`);
    return { ok: true };
  }

  // express.json() already ran globally in server.js before this router is
  // mounted (see the mount-order comment there), so req.body is parsed.
  router.post('/', async (req, res) => {
    if (!isConfigured()) return res.status(404).json({ error: 'not_found' });

    const { title, description, turnstileToken, website, meta } = req.body || {};

    // 1. Honeypot. A real human never fills this (off-screen, aria-hidden,
    // tabindex -1). A bot that fills every field gets a quiet fake success —
    // no error that would teach it to try again differently, and nothing is
    // sent.
    const honeypotFilled = typeof website === 'string' ? website.trim() !== '' : Boolean(website);
    if (honeypotFilled) return res.status(200).json({ ok: true });

    // 2. Validate: strings only, trimmed title 1..120, description 10..5000.
    if (
      typeof title !== 'string' ||
      typeof description !== 'string' ||
      typeof turnstileToken !== 'string'
    ) {
      return res.status(400).json({ error: 'invalid_payload' });
    }

    // Validate exactly what will be rendered (cleanOneLine/cleanMultiline),
    // so a title made only of invisible characters is rejected as empty.
    const safeTitle = cleanOneLine(title);
    if (safeTitle.length < 1 || safeTitle.length > 120) {
      return res.status(400).json({ error: 'invalid_title' });
    }

    const safeDescription = cleanMultiline(description).trim();
    if (safeDescription.length < 10 || safeDescription.length > 5000) {
      return res.status(400).json({ error: 'invalid_description' });
    }

    // 3. Rate limits (peek only — see consumeRateLimits above).
    const ip = req.ip;
    const limitError = checkRateLimits(ip);
    if (limitError) return res.status(429).json({ error: limitError });

    // 4. Turnstile.
    const turnstile = await verifyTurnstile(turnstileToken, ip);
    if (!turnstile.ok) return res.status(turnstile.status).json({ error: turnstile.code });

    // 5. Send the one Telegram message. The IP is deliberately NOT passed.
    const viewport = typeof meta?.viewport === 'string' ? meta.viewport : undefined;
    const sent = await deliverReport(safeTitle, safeDescription, req.get('user-agent'), viewport);
    if (!sent.ok) return res.status(sent.status).json({ error: sent.code });

    // Only a fully successful report spends the cap/IP budget.
    consumeRateLimits(ip);

    res.status(201).json({ ok: true });
  });

  return router;
}
