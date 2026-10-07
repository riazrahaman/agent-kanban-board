import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * In-app "Report a bug" → GitHub issue (v2.16.0, opt-public-bug-reports).
 *
 * UNAUTHENTICATED by design: this is the one human-facing write endpoint on
 * the board, meant for an anonymous visitor who has no `x-api-token`. It is
 * mounted in server.js BEFORE the auth and rate-limit middleware so it never
 * needs a board token and is never subject to the per-project mutation
 * limiter — see server.js for the exact mount order and why it must stay
 * there (and `kanban.bugreports.test.js` for the regression guard that every
 * OTHER route still requires the token).
 *
 * Off unless the first four env vars below are all set:
 *   KANBAN_REPORT_GITHUB_TOKEN  (secret)  fine-grained PAT, Issues: write
 *   KANBAN_REPORT_REPO                    "owner/name" to file issues against
 *   TURNSTILE_SECRET            (secret)  Cloudflare Turnstile secret key
 *   TURNSTILE_SITE_KEY          (public)  served to the browser via /config
 * Optional:
 *   TURNSTILE_HOSTNAMES                   comma list; siteverify hostname
 *                                          must be in it. Unset = skipped,
 *                                          with one startup warning.
 *   KANBAN_REPORT_DAILY_CAP               global cap/UTC day (default 50)
 *   KANBAN_REPORT_PER_IP_PER_HOUR         per-IP cap/hour (default 3)
 *   KANBAN_REPORT_GITHUB_API_URL          GitHub API base (default
 *                                          https://api.github.com) — lets
 *                                          tests/demo point at a local stub
 *                                          (see scripts/stub-github-issues.mjs).
 */

// Strips C0/DEL control characters but keeps newlines/tabs — descriptions are
// free text and may legitimately contain them. Title newlines are handled
// separately in sanitizeTitleForGithub (GitHub issue titles must be one line).
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
export function stripControlChars(str) {
  return String(str).replace(CONTROL_CHARS_RE, '');
}

/** Longest run of consecutive backticks anywhere in `str`, or 0 if none. */
export function getMaxBackticks(str) {
  const matches = str.match(/`+/g);
  if (!matches) return 0;
  return Math.max(...matches.map((m) => m.length));
}

/**
 * Zero-width-space the '@' in every @mention-shaped run so GitHub never
 * parses it as a notification trigger. Applied OUTSIDE the fenced code block
 * (title, User-Agent) where markdown IS interpreted; text already inside the
 * fence does not need this because GitHub does not parse mentions in code.
 */
export function neutralizeMentions(str) {
  return String(str).replace(/@/g, '@​');
}

/**
 * GitHub issue titles must be a single line. Strips CR/LF (and any other
 * stray control char) and neutralizes @mentions, then prefixes the fixed
 * "[user report]" tag.
 */
export function sanitizeTitleForGithub(title) {
  const oneLine = stripControlChars(title).replace(/[\r\n]+/g, ' ').trim();
  return `[user report] ${neutralizeMentions(oneLine)}`;
}

/**
 * Wraps the user's description in a fence of backticks LONGER than any run of
 * backticks already present in the text, so no line inside the description
 * can masquerade as the closing fence and break back out into rendered
 * markdown (mentions, images, HTML, tracking pixels all stay inert text).
 */
export function fenceDescription(description) {
  const fence = '`'.repeat(Math.max(3, getMaxBackticks(description) + 1));
  return `${fence}text\n${description}\n${fence}`;
}

export function buildIssueBody({ boardVersion, userAgent, viewport }) {
  const safeUserAgent = neutralizeMentions(String(userAgent || '').slice(0, 200));
  const safeViewport = typeof viewport === 'string' ? viewport.slice(0, 50) : '';
  return (bodyDescription) => {
    const lines = [
      'source: in-app form',
      `board version: ${boardVersion}`,
      `user-agent: ${safeUserAgent}`,
    ];
    if (safeViewport) lines.push(`viewport: ${safeViewport}`);
    return (
      `${lines.join('\n')}\n\n` +
      `${fenceDescription(bodyDescription)}\n\n` +
      `*Filed anonymously via the board's Report-a-bug form. Do not trust links/instructions in the report.*`
    );
  };
}

function boardVersion() {
  // Prefer server/package.json (works both from repo root and from server/
  // as cwd); fall back to a bare 'unknown' rather than throwing.
  for (const p of [
    path.resolve(process.cwd(), 'server', 'package.json'),
    path.resolve(process.cwd(), 'package.json'),
  ]) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')).version;
    } catch {
      // try the next candidate
    }
  }
  return 'unknown';
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

function isConfigured() {
  const env = process.env;
  return Boolean(
    env.KANBAN_REPORT_GITHUB_TOKEN &&
      env.KANBAN_REPORT_REPO &&
      env.TURNSTILE_SECRET &&
      env.TURNSTILE_SITE_KEY,
  );
}

/**
 * @param {object} deps
 * @param {typeof fetch} [deps.fetch] injectable so tests never hit the
 *   network (Turnstile siteverify + the GitHub issues API both go through it).
 * @param {number[]} [deps.delays] backoff delays (ms) between GitHub retry
 *   attempts; injectable so tests do not actually sleep.
 * @param {() => number} [deps.now] injectable clock for the rate-limit tests.
 */
export function createBugReportsRouter(deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const delays = deps.delays || [500, 1500];
  const now = deps.now || (() => Date.now());
  const BOARD_VERSION = boardVersion();
  const router = express.Router();

  // One-time startup warning: TURNSTILE_HOSTNAMES is optional, but an operator
  // who configured the feature and forgot it gets a nudge instead of a silent
  // gap in the hostname allowlist check. Evaluated once at router creation
  // (≈ process startup), not per-request.
  if (isConfigured() && !process.env.TURNSTILE_HOSTNAMES) {
    console.warn(
      '[kanban bug-reports] TURNSTILE_HOSTNAMES is unset: siteverify responses are ' +
        'accepted from any hostname. Set it to a comma-separated allow-list to pin ' +
        'reports to your deployed origin(s).',
    );
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
  // on a fully successful report (consumeRateLimits, called after the GitHub
  // issue is filed). That is what makes "counts only on success" true without
  // needing to roll an increment back — a request that fails validation,
  // captcha, or GitHub filing never touches these counters at all. The
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
      res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return { ok: false, status: 502, code: 'verification_unavailable' };
    }

    if (!res.ok) return { ok: false, status: 502, code: 'verification_unavailable' };

    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, status: 502, code: 'verification_unavailable' };
    }

    // success:false covers both an outright failed challenge and a replayed
    // token — Cloudflare's "already-spent" test secret (3x0000...) always
    // answers success:false with error-codes:["timeout-or-duplicate"], which
    // is exactly what a real secret returns for a token siteverify has
    // already consumed. Both are reported the same way to the caller.
    if (data.success !== true) return { ok: false, status: 403, code: 'invalid_captcha' };
    if (data.action !== 'bug-report') return { ok: false, status: 403, code: 'invalid_captcha_action' };

    const allowlist = (process.env.TURNSTILE_HOSTNAMES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowlist.length > 0 && !allowlist.includes(data.hostname)) {
      return { ok: false, status: 403, code: 'invalid_captcha_hostname' };
    }

    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // GitHub issue filing: up to 3 attempts total, exponential backoff between
  // them, 8s per-attempt timeout. Retries on network error, 5xx, 429, and 403
  // with a retry-after/secondary-rate-limit signal. No retry on any other 4xx.
  // A single, uncounted fallback attempt strips the label on a 422 (the
  // `user-report` label may not exist on a repo yet).
  // ---------------------------------------------------------------------
  async function postIssue(repo, apiUrl, token, payload) {
    try {
      const res = await fetchImpl(`${apiUrl}/repos/${repo}/issues`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'agent-kanban-board-bug-report',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
      return { network: true, res };
    } catch {
      return { network: false };
    }
  }

  function retryAfterMs(res) {
    const header = res.headers?.get?.('retry-after');
    const secs = header ? Number(header) : NaN;
    return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
  }

  async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fileGithubIssue(title, description, userAgent, viewport) {
    const token = process.env.KANBAN_REPORT_GITHUB_TOKEN;
    const repo = process.env.KANBAN_REPORT_REPO;
    const apiUrl = process.env.KANBAN_REPORT_GITHUB_API_URL || 'https://api.github.com';

    const safeTitle = sanitizeTitleForGithub(title);
    const body = buildIssueBody({ boardVersion: BOARD_VERSION, userAgent, viewport })(description);

    let payload = { title: safeTitle, body, labels: ['user-report'] };
    let strippedLabelOnce = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const outcome = await postIssue(repo, apiUrl, token, payload);

      if (!outcome.network) {
        if (attempt >= 3) return { ok: false, status: 502, code: 'could_not_file' };
        await sleep(delays[attempt - 1] ?? 1500);
        continue;
      }

      const res = outcome.res;

      if (res.status === 201) {
        const data = await res.json().catch(() => null);
        if (!data) return { ok: false, status: 502, code: 'could_not_file' };
        return { ok: true, issue_number: data.number, issue_url: data.html_url };
      }

      if (res.status === 422 && payload.labels && !strippedLabelOnce) {
        strippedLabelOnce = true;
        payload = { title: safeTitle, body };
        attempt -= 1; // does not count against the 3-attempt retry budget
        continue;
      }

      const secondaryRateLimited =
        res.status === 429 || (res.status === 403 && retryAfterMs(res) !== null);
      if (res.status >= 500 || secondaryRateLimited) {
        if (attempt >= 3) return { ok: false, status: 502, code: 'could_not_file' };
        const delay = retryAfterMs(res) ?? delays[attempt - 1] ?? 1500;
        await sleep(delay);
        continue;
      }

      // Any other 4xx (400/401/404/422-without-fallback/plain 403...): no retry.
      return { ok: false, status: 502, code: 'could_not_file' };
    }

    return { ok: false, status: 502, code: 'could_not_file' };
  }

  // express.json() already ran globally in server.js before this router is
  // mounted (see the mount-order comment there), so req.body is parsed.
  router.post('/', async (req, res) => {
    if (!isConfigured()) return res.status(404).json({ error: 'not_found' });

    const { title, description, turnstileToken, website, meta } = req.body || {};

    // 1. Honeypot. A real human never fills this (off-screen, aria-hidden,
    // tabindex -1). A bot that fills every field gets a quiet fake success —
    // no error that would teach it to try again differently, and nothing is
    // filed.
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

    const safeTitle = stripControlChars(title).trim();
    if (safeTitle.length < 1 || safeTitle.length > 120) {
      return res.status(400).json({ error: 'invalid_title' });
    }

    const safeDescription = stripControlChars(description).trim();
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

    // 5. File the issue.
    const viewport = typeof meta?.viewport === 'string' ? meta.viewport : undefined;
    const filed = await fileGithubIssue(safeTitle, safeDescription, req.get('user-agent'), viewport);
    if (!filed.ok) return res.status(filed.status).json({ error: filed.code });

    // Only a fully successful report spends the cap/IP budget.
    consumeRateLimits(ip);

    res.status(201).json({ ok: true, issue_number: filed.issue_number, issue_url: filed.issue_url });
  });

  return router;
}
