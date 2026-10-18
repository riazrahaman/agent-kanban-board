import express from 'express';
import { tokensMatch } from '../utils/constantTime.js';
import { buildSystemPrompt, gatherSnapshot, gatherSourceContext } from '../askKnowledge.js';
import * as storeModule from '../store.js';

/**
 * Ask-the-Board (v3.4.0) — a read-only, password-gated Q&A endpoint.
 *
 * UNAUTHENTICATED by the board's token model, but gated by a shared password
 * (`x-ask-pass`) and mounted in server.js BEFORE the auth middleware, exactly
 * like `/api/bug-reports` — see the mount-order comment there. It never reads
 * or writes the board: no token is accepted, and the only board data it sees
 * is the in-process snapshot assembled by `gatherSnapshot(store)`.
 *
 * Off (fail-closed) unless BOTH of these are non-empty:
 *   KANBAN_ASK_OPENROUTER_API_KEY   (secret) turns the feature on
 *   KANBAN_ASK_PASSWORD             (secret) the gate on POST /api/ask
 * Optional knobs (all default, all read here):
 *   KANBAN_ASK_MODEL                default: openai/gpt-oss-20b
 *   KANBAN_ASK_DAILY_CAP            default: 50 (global, per UTC day)
 *   KANBAN_ASK_PER_IP_PER_HOUR      default: 3
 *   KANBAN_ASK_TIMEOUT_MS           default: 45000
 *   KANBAN_ASK_MAX_PROMPT_TOKENS    default: 6000
 *   KANBAN_ASK_MAX_OUTPUT_TOKENS    default: 600
 *   KANBAN_AUTH_RATE_LIMIT_PER_MIN  wrong-password backoff ceiling (default 10;
 *                                   shared name with the auth middleware, but
 *                                   this router keeps its OWN counter)
 *
 * NEVER returned or logged: the API key, the password, or the raw upstream
 * error body. The model is told, in the system prompt, that it may never
 * claim/move a card or reveal a token (see askKnowledge.js).
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_REFERER = 'https://agent-kanban.riazrahaman.com';
const OPENROUTER_TITLE = 'Agent Kanban Board — Ask';
const DEFAULT_MODEL = 'openai/gpt-oss-20b';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const MIN_QUESTION_LEN = 3;
const MAX_QUESTION_LEN = 500;

/** Positive integer from an env value, else the fallback (0/negative/garbage → fallback). */
function intFrom(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Reads every `KANBAN_ASK_*` key literally off `process.env` so the config
 * generator (scripts/gen-config-reference.mjs) and the config drift test
 * (server/test/kanban.config.test.js) discover each one by name. `deps.env`
 * lets tests supply a fixed environment object instead of mutating the
 * process — production uses this default.
 */
function readEnv() {
  return {
    KANBAN_ASK_OPENROUTER_API_KEY: process.env.KANBAN_ASK_OPENROUTER_API_KEY,
    KANBAN_ASK_PASSWORD: process.env.KANBAN_ASK_PASSWORD,
    KANBAN_ASK_MODEL: process.env.KANBAN_ASK_MODEL,
    KANBAN_ASK_DAILY_CAP: process.env.KANBAN_ASK_DAILY_CAP,
    KANBAN_ASK_PER_IP_PER_HOUR: process.env.KANBAN_ASK_PER_IP_PER_HOUR,
    KANBAN_ASK_TIMEOUT_MS: process.env.KANBAN_ASK_TIMEOUT_MS,
    KANBAN_ASK_MAX_PROMPT_TOKENS: process.env.KANBAN_ASK_MAX_PROMPT_TOKENS,
    KANBAN_ASK_MAX_OUTPUT_TOKENS: process.env.KANBAN_ASK_MAX_OUTPUT_TOKENS,
    KANBAN_AUTH_RATE_LIMIT_PER_MIN: process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN,
  };
}

/** Fail-closed gate: enabled only when BOTH the key and the password are non-empty. */
function isEnabled(env) {
  return isNonEmpty(env.KANBAN_ASK_OPENROUTER_API_KEY) && isNonEmpty(env.KANBAN_ASK_PASSWORD);
}

function modelName(env) {
  return isNonEmpty(env.KANBAN_ASK_MODEL) ? env.KANBAN_ASK_MODEL.trim() : DEFAULT_MODEL;
}

/**
 * @param {object} deps
 * @param {typeof fetch} [deps.fetch] injectable so tests never hit OpenRouter.
 * @param {() => number} [deps.now] injectable clock for the rate-limit tests.
 * @param {object} [deps.store] injectable store module for gatherSnapshot.
 * @param {object} [deps.env] injectable environment; defaults to process.env.
 */
export function createAskRouter(deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const now = deps.now || (() => Date.now());
  const store = deps.store || storeModule;
  const env = deps.env || readEnv();
  const router = express.Router();

  // ---------------------------------------------------------------------
  // In-memory rate limiting — same proven peek/consume pattern as
  // routes/bugReports.js. Counters are process-local (reset on redeploy) and
  // bounded: they are pruned per request and by a periodic unref'd sweep.
  // `checkLimits` is PEEK-only; `consume` runs ONLY after a successful answer,
  // so a request that fails validation, auth, the upstream call, or a timeout
  // never spends the budget.
  // ---------------------------------------------------------------------
  const globalTimestamps = [];
  const ipTimestamps = new Map(); // ip -> number[]

  // Wrong-password attempts get their OWN fixed 60s-window counter per IP, so
  // a password-guessing burst cannot spend OpenRouter quota (it never reaches
  // the upstream call) and is retried more slowly after the limit.
  const failedAuth = new Map(); // ip -> { count, windowStartMs }

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

  function pruneFailedAuth() {
    const cutoff = now() - MINUTE_MS;
    for (const [ip, rec] of failedAuth) {
      if (rec.windowStartMs < cutoff) failedAuth.delete(ip);
    }
  }

  // Unref'd so it never keeps the process alive (matches the reaper/backup
  // timers elsewhere in server.js).
  const sweepTimer = setInterval(() => {
    pruneGlobal();
    for (const ip of Array.from(ipTimestamps.keys())) pruneIp(ip);
    pruneFailedAuth();
  }, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  function dailyCap() {
    return intFrom(env.KANBAN_ASK_DAILY_CAP, 50);
  }

  function perIpHourlyLimit() {
    return intFrom(env.KANBAN_ASK_PER_IP_PER_HOUR, 3);
  }

  function checkLimits(ip) {
    pruneGlobal();
    if (globalTimestamps.length >= dailyCap()) return 'daily_cap_reached';
    const list = pruneIp(ip);
    if (list.length >= perIpHourlyLimit()) return 'ip_limit_reached';
    return null;
  }

  function consume(ip) {
    const ts = now();
    globalTimestamps.push(ts);
    if (!ipTimestamps.has(ip)) ipTimestamps.set(ip, []);
    ipTimestamps.get(ip).push(ts);
  }

  /** ms until the oldest timestamp in the exhausted window ages out. */
  function retryAfterMs(reason, ip) {
    const ts = now();
    if (reason === 'daily_cap_reached') {
      const oldest = globalTimestamps[0];
      return oldest !== undefined ? Math.max(0, oldest + DAY_MS - ts) : DAY_MS;
    }
    const list = ipTimestamps.get(ip) || [];
    return list.length > 0 ? Math.max(0, list[0] + HOUR_MS - ts) : HOUR_MS;
  }

  function authLimit() {
    return intFrom(env.KANBAN_AUTH_RATE_LIMIT_PER_MIN, 10);
  }

  /** Records a failed password attempt and returns the count in the current 60s window. */
  function recordFailedAuth(ip) {
    const ts = now();
    const rec = failedAuth.get(ip);
    if (!rec || ts - rec.windowStartMs >= MINUTE_MS) {
      failedAuth.set(ip, { count: 1, windowStartMs: ts });
      return 1;
    }
    rec.count += 1;
    return rec.count;
  }

  function failedAuthRetryAfterMs(ip) {
    const rec = failedAuth.get(ip);
    if (!rec) return MINUTE_MS;
    return Math.max(0, rec.windowStartMs + MINUTE_MS - now());
  }

  function clientIp(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  router.get('/config', (req, res) => {
    if (!isEnabled(env)) return res.json({ enabled: false });
    res.json({ enabled: true, gated: true, model: modelName(env) });
  });

  // express.json() already ran globally in server.js before this router is
  // mounted, so req.body is parsed.
  router.post('/', async (req, res) => {
    if (!isEnabled(env)) return res.status(404).json({ error: 'not_found' });

    const ip = clientIp(req);

    // 1. Password gate. Same generic 401 for missing AND wrong — never hint
    //    which. A failure is counted so a guessing burst backs off.
    const provided = req.get('x-ask-pass');
    if (!tokensMatch(provided, env.KANBAN_ASK_PASSWORD)) {
      const count = recordFailedAuth(ip);
      if (count > authLimit()) {
        const ms = failedAuthRetryAfterMs(ip);
        res.set('Retry-After', String(Math.max(1, Math.ceil(ms / 1000))));
        return res.status(429).json({ error: 'too_many_attempts', retry_after_ms: ms });
      }
      return res.status(401).json({ error: 'invalid_pass' });
    }

    // 2. Validate the question: string, trimmed length 3..500.
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (question.length < MIN_QUESTION_LEN || question.length > MAX_QUESTION_LEN) {
      return res.status(400).json({ error: 'invalid_question' });
    }

    // 3. Peek-only rate limit.
    const limitError = checkLimits(ip);
    if (limitError) {
      const ms = retryAfterMs(limitError, ip);
      res.set('Retry-After', String(Math.max(1, Math.ceil(ms / 1000))));
      return res.status(429).json({ error: limitError, retry_after_ms: ms });
    }

    // 4. Build the prompt from the protocol pack + retrieved source + a live
    //    read-only snapshot.
    const maxPromptTokens = intFrom(env.KANBAN_ASK_MAX_PROMPT_TOKENS, 6000);
    const retrieved = gatherSourceContext(question.trim());
    const snapshot = gatherSnapshot(store);
    const fallback = !snapshot || snapshot.available === false;
    if (fallback) {
      console.warn('[kanban ask] live board snapshot unavailable; answering from the static knowledge pack');
    }
    const systemPrompt = buildSystemPrompt({
      snapshot,
      retrieved,
      maxTokens: maxPromptTokens,
    });
    const model = modelName(env);
    const maxOutputTokens = intFrom(env.KANBAN_ASK_MAX_OUTPUT_TOKENS, 600);
    const timeoutMs = intFrom(env.KANBAN_ASK_TIMEOUT_MS, 45000);

    // 5. Call OpenRouter.
    let upstream;
    try {
      upstream = await fetchImpl(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.KANBAN_ASK_OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': OPENROUTER_REFERER,
          'X-Title': OPENROUTER_TITLE,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: question },
          ],
          max_tokens: maxOutputTokens,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const aborted =
        err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR');
      // No upstream detail is ever surfaced or logged.
      if (aborted) return res.status(503).json({ error: 'timeout' });
      return res.status(502).json({ error: 'gateway_error' });
    }

    if (!upstream || !upstream.ok) {
      return res.status(502).json({ error: 'gateway_error' });
    }

    let data;
    try {
      data = await upstream.json();
    } catch {
      return res.status(502).json({ error: 'gateway_error' });
    }

    const answer = data?.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || answer.trim().length === 0) {
      return res.status(502).json({ error: 'gateway_error' });
    }

    // Only a fully successful answer spends the cap/IP budget.
    consume(ip);

    res.json(fallback ? { answer, model, fallback: true } : { answer, model });
  });

  return router;
}
