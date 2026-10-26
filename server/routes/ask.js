import dns from 'node:dns';
import express from 'express';
import { tokensMatch } from '../utils/constantTime.js';
import { buildSystemPrompt, gatherSnapshot, gatherSourceContext, gatherRecentCommits } from '../askKnowledge.js';
import { safeLogValue } from './bugReports.js';
import * as storeModule from '../store.js';

// Map of temporarily failed Tailscale Funnel ingress IPs -> timestamp
const failedTunnelIps = new Map();
// Pre-seed known dead Tailscale DERP edge node in Paris that terminates TLS handshakes with ECONNRESET
failedTunnelIps.set('176.58.90.63', Date.now());

function setupTailscaleDnsFallback() {
  if (globalThis.__tailscaleDnsFallbackInstalled) return;
  globalThis.__tailscaleDnsFallbackInstalled = true;
  const originalLookup = dns.lookup;
  dns.lookup = function (hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (typeof hostname === 'string' && hostname.endsWith('.ts.net')) {
      return originalLookup(hostname, { all: true }, (err, addresses) => {
        if (err || !Array.isArray(addresses) || addresses.length <= 1) {
          return originalLookup(hostname, options, callback);
        }
        const now = Date.now();
        for (const [ip, ts] of failedTunnelIps) {
          if (now - ts > 600000) failedTunnelIps.delete(ip);
        }
        const healthy = addresses.filter((a) => !failedTunnelIps.has(a.address));
        const pool = healthy.length > 0 ? healthy : addresses;
        if (options && options.all) {
          return callback(null, pool);
        }
        return callback(null, pool[0].address, pool[0].family);
      });
    }
    return originalLookup(hostname, options, callback);
  };
}

/**
 * Ask-the-Board (v3.4.0) — a read-only, password-gated Q&A endpoint.
 *
 * UNAUTHENTICATED by the board's token model, but gated by a shared password
 * (`x-ask-pass`) and mounted in server.js BEFORE the auth middleware, exactly
 * like `/api/bug-reports` — see the mount-order comment there. It never reads
 * or writes the board: no token is accepted, and the only board data it sees
 * is the in-process snapshot assembled by `gatherSnapshot(store)`.
 *
 * Off (fail-closed). The password is ALWAYS required; the OpenRouter key is
 * required only for the `openrouter` provider (see resolveProvider below):
 *   KANBAN_ASK_PASSWORD             (secret) the gate on POST /api/ask
 *   KANBAN_ASK_OPENROUTER_API_KEY   (secret) required for provider=openrouter
 * Provider selection (v3.7.0):
 *   KANBAN_ASK_PROVIDER             'openrouter' (default) | 'ollama'; an
 *                                   explicit value always wins. With no
 *                                   explicit value, KANBAN_ASK_OLLAMA_HOST set
 *                                   and no OpenRouter key selects 'ollama'.
 *   KANBAN_ASK_OLLAMA_HOST          default: http://localhost:11434
 *   KANBAN_ASK_OLLAMA_AUTH_HEADER   (secret) bearer for a tunnel/gateway
 * Optional knobs (all default, all read here):
 *   KANBAN_ASK_MODEL                default: openai/gpt-oss-20b (openrouter),
 *                                   qwen3.6:latest (ollama)
 *   KANBAN_ASK_DAILY_CAP            default: 50 (global, per UTC day)
 *   KANBAN_ASK_PER_IP_PER_HOUR      default: 3
 *   KANBAN_ASK_TIMEOUT_MS           default: 45000
 *   KANBAN_ASK_MAX_PROMPT_TOKENS    default: 6000
 *   KANBAN_ASK_MAX_OUTPUT_TOKENS    default: 1500 — but on the ollama provider
 *                                   max_tokens is OMITTED entirely unless this
 *                                   is set, because the cap also bounds a
 *                                   reasoning model's chain of thought (v3.7.2)
 *   KANBAN_AUTH_RATE_LIMIT_PER_MIN  wrong-password backoff ceiling (default 10;
 *                                   shared name with the auth middleware, but
 *                                   this router keeps its OWN counter)
 *
 * NEVER returned or logged: the API key, the password, or the raw upstream
 * error body. The model is told, in the system prompt, that it may never
 * claim/move a card or reveal a token (see askKnowledge.js).
 *
 * The HTTP STATUS of a failed upstream call, and a short hint keyed on it, ARE
 * logged (v3.6.1). Until then this path logged nothing whatsoever, so a dead
 * key, an exhausted balance and a genuine outage were indistinguishable from
 * each other and from a working feature — the user saw one generic message and
 * the deploy log said nothing at all. That is the same blind spot bug reports
 * had before v3.2.5; this is the same fix, with the same rate limiting and the
 * same secret redaction. A status is not a secret; a response body might be,
 * so the body is still never logged.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_REFERER = 'https://agent-kanban.riazrahaman.com';
// ASCII ONLY. An HTTP header value is a ByteString: every character must fit
// in one byte. This constant previously used an em dash (U+2014), which made
// `fetch` throw `TypeError: Cannot convert argument to a ByteString ...` before
// a single packet left the process — so Ask-the-Board failed on every request
// from v3.4.0 until v3.6.3, while the deploy logs showed no outbound
// connection at all. The project's prose style uses em dashes freely; headers
// are the one place they cannot go. Guarded by a test that runs the real
// `Headers` validator over the request this route actually builds.
const OPENROUTER_TITLE = 'Agent Kanban Board - Ask';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-oss-20b';
const DEFAULT_OLLAMA_MODEL = 'qwen3.6:latest';
const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const MIN_QUESTION_LEN = 3;
const MAX_QUESTION_LEN = 500;
const LOG_PREFIX = '[kanban ask]';
const LOG_WINDOW_MS = 60 * 1000;

/**
 * Shape-only check on the OpenRouter key, for a boot-time nudge. It never
 * disables the feature and never sees the network — the whole point is to
 * catch a placeholder before it becomes a silent 401 on every question, which
 * is the failure mode this file had no way of reporting.
 */
export function looksLikeOpenRouterKey(key) {
  return typeof key === 'string' && /^sk-or-[A-Za-z0-9._-]{16,}$/.test(key.trim());
}

/** Short operator-facing hint keyed on OpenRouter or Ollama HTTP status. */
export function hintForUpstreamStatus(status, provider = 'openrouter') {
  if (provider === 'ollama') {
    switch (status) {
      case 404:
        return 'model not found on Ollama instance — run `ollama pull <model>` or check KANBAN_ASK_MODEL';
      case 401:
      case 403:
        return 'unauthorized — check KANBAN_ASK_OLLAMA_AUTH_HEADER or tunnel secret';
      default:
        return status >= 500 ? 'Ollama internal server error' : 'unexpected status from Ollama';
    }
  }

  switch (status) {
    case 400:
      return 'bad request — often a prompt over the model context; try lowering KANBAN_ASK_MAX_PROMPT_TOKENS';
    case 401:
      return 'KANBAN_ASK_OPENROUTER_API_KEY invalid, revoked or a placeholder';
    case 402:
      return 'OpenRouter credit exhausted — top up the account';
    case 403:
      return 'key not permitted to use this model (check KANBAN_ASK_MODEL and the key scope)';
    case 404:
      return 'KANBAN_ASK_MODEL not found — check the id against openrouter.ai/models';
    case 408:
      return 'upstream timeout';
    case 429:
      return "OpenRouter's own rate limit — retry later or raise the plan";
    case 502:
    case 503:
      return 'the selected provider is down or at capacity; OpenRouter found no route';
    default:
      return status >= 500 ? 'OpenRouter outage' : 'unexpected status';
  }
}

/** Positive integer from an env value, else the fallback (0/negative/garbage → fallback). */
function intFrom(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Resolves the active provider: 'openrouter' or 'ollama'.
 * Auto-detects if unset: defaults to 'ollama' if KANBAN_ASK_OLLAMA_HOST is set
 * without an OpenRouter key, otherwise defaults to 'openrouter'.
 */
export function resolveProvider(env) {
  if (isNonEmpty(env.KANBAN_ASK_PROVIDER)) {
    const p = env.KANBAN_ASK_PROVIDER.trim().toLowerCase();
    if (p === 'ollama') return 'ollama';
    return 'openrouter';
  }
  if (!isNonEmpty(env.KANBAN_ASK_OPENROUTER_API_KEY) && isNonEmpty(env.KANBAN_ASK_OLLAMA_HOST)) {
    return 'ollama';
  }
  return 'openrouter';
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
    KANBAN_ASK_PROVIDER: process.env.KANBAN_ASK_PROVIDER,
    KANBAN_ASK_OLLAMA_HOST: process.env.KANBAN_ASK_OLLAMA_HOST,
    KANBAN_ASK_OLLAMA_AUTH_HEADER: process.env.KANBAN_ASK_OLLAMA_AUTH_HEADER,
    KANBAN_ASK_OPENROUTER_API_KEY: process.env.KANBAN_ASK_OPENROUTER_API_KEY,
    KANBAN_ASK_PASSWORD: process.env.KANBAN_ASK_PASSWORD,
    KANBAN_ASK_MODEL: process.env.KANBAN_ASK_MODEL,
    KANBAN_ASK_DAILY_CAP: process.env.KANBAN_ASK_DAILY_CAP,
    KANBAN_ASK_PER_IP_PER_HOUR: process.env.KANBAN_ASK_PER_IP_PER_HOUR,
    KANBAN_ASK_TIMEOUT_MS: process.env.KANBAN_ASK_TIMEOUT_MS,
    KANBAN_ASK_MAX_PROMPT_TOKENS: process.env.KANBAN_ASK_MAX_PROMPT_TOKENS,
    KANBAN_ASK_MAX_OUTPUT_TOKENS: process.env.KANBAN_ASK_MAX_OUTPUT_TOKENS,
    KANBAN_ASK_SNAPSHOT_PROJECTS: process.env.KANBAN_ASK_SNAPSHOT_PROJECTS,
    KANBAN_AUTH_RATE_LIMIT_PER_MIN: process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN,
  };
}

/**
 * Fail-closed gate:
 * - Always requires KANBAN_ASK_PASSWORD.
 * - If provider is openrouter: requires KANBAN_ASK_OPENROUTER_API_KEY.
 * - If provider is ollama: requires KANBAN_ASK_PASSWORD (host defaults to http://localhost:11434).
 */
function isEnabled(env) {
  if (!isNonEmpty(env.KANBAN_ASK_PASSWORD)) return false;
  const provider = resolveProvider(env);
  if (provider === 'ollama') return true;
  return isNonEmpty(env.KANBAN_ASK_OPENROUTER_API_KEY);
}

function modelName(env) {
  if (isNonEmpty(env.KANBAN_ASK_MODEL)) return env.KANBAN_ASK_MODEL.trim();
  const provider = resolveProvider(env);
  return provider === 'ollama' ? DEFAULT_OLLAMA_MODEL : DEFAULT_OPENROUTER_MODEL;
}

/**
 * v3.9.2 — optional snapshot scope.
 *
 * The Ask password is an OWNER credential: by default the snapshot covers every
 * project on the board, because the person using the board is entitled to see
 * it. `KANBAN_ASK_SNAPSHOT_PROJECTS` exists for the other case — a deployment
 * that shares the password and wants the assistant to see only some projects.
 *
 * Unset / empty / whitespace -> null, meaning "all projects" (the historical
 * behaviour, and the one this board runs with). A non-empty list is parsed and
 * de-duplicated; an entry that names no existing project simply matches nothing,
 * so a typo narrows the answer rather than silently widening it.
 */
export function snapshotProjects(env) {
  const raw = env.KANBAN_ASK_SNAPSHOT_PROJECTS;
  if (!isNonEmpty(raw)) return null;
  const list = raw.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? Array.from(new Set(list)) : null;
}

function ollamaHost(env) {
  if (isNonEmpty(env.KANBAN_ASK_OLLAMA_HOST)) {
    return env.KANBAN_ASK_OLLAMA_HOST.trim().replace(/\/+$/, '');
  }
  return DEFAULT_OLLAMA_HOST;
}

/**
 * Returns true if Ollama is configured to run against a local model/host,
 * rather than a hosted cloud Ollama endpoint (e.g. ollama.com) or cloud model (:cloud).
 */
export function isLocalOllama(env) {
  if (resolveProvider(env) !== 'ollama') return false;
  const host = ollamaHost(env).toLowerCase();
  const model = modelName(env).toLowerCase();
  if (host.includes('ollama.com') || host.includes('ollama.ai') || model.endsWith(':cloud')) {
    return false;
  }
  return true;
}

/**
 * @param {object} deps
 * @param {typeof fetch} [deps.fetch] injectable so tests never hit OpenRouter.
 * @param {() => number} [deps.now] injectable clock for the rate-limit tests.
 * @param {object} [deps.store] injectable store module for gatherSnapshot.
 * @param {object} [deps.env] injectable environment; defaults to process.env.
 */
export function createAskRouter(deps = {}) {
  setupTailscaleDnsFallback();
  const fetchImpl = deps.fetch || globalThis.fetch;
  const now = deps.now || (() => Date.now());
  const store = deps.store || storeModule;
  const env = deps.env || readEnv();
  const router = express.Router();
  const logger = deps.logger || console;
  const retryDelayMs = deps.retryDelayMs !== undefined
    ? deps.retryDelayMs
    : (deps.fetch || process.env.NODE_ENV === 'test' ? 1 : 750);

  const provider = resolveProvider(env);

  // Deep-review extension of the em-dash lesson: the static X-Title constant
  // was fixed, but env-derived HEADER values are still pasted by operators.
  // Node throws 'Cannot convert argument to a ByteString' on any value beyond
  // ISO-8859-1 before a byte leaves the process — flag it here with the exact
  // variable name instead of surfacing as an unexplained gateway_error.
  for (const key of ['KANBAN_ASK_OPENROUTER_API_KEY', 'KANBAN_ASK_OLLAMA_AUTH_HEADER', 'KANBAN_ASK_PASSWORD']) {
    const v = env[key];
    if (typeof v === 'string' && v !== '' && !/^[\x00-\xFF]*$/.test(v)) {
      logger.warn(`[kanban ask] ${key} contains non-Latin-1 characters — outbound auth headers will throw; paste the plain ASCII value.`);
    }
  }

  // Boot-time nudge, matching routes/bugReports.js. A placeholder key is the
  // single most likely cause of a feature that is "on" but answers nothing,
  // and before v3.6.1 it produced no output anywhere at all.
  if (provider === 'openrouter' && isEnabled(env) && !looksLikeOpenRouterKey(env.KANBAN_ASK_OPENROUTER_API_KEY)) {
    logger.warn(
      `${LOG_PREFIX} WARNING: KANBAN_ASK_OPENROUTER_API_KEY does not look like an OpenRouter key (placeholder?)`,
    );
  }

  // One line per failed request, not one per cause-of-failure and not one per
  // retry, de-duplicated per kind for LOG_WINDOW_MS so an outage or a flood
  // cannot fill the deploy log.
  const lastLoggedAt = new Map();

  /** Strip our own secrets out of anything about to be logged. */
  function redactSecrets(line) {
    let out = String(line);
    for (const secret of [
      env.KANBAN_ASK_OPENROUTER_API_KEY,
      env.KANBAN_ASK_PASSWORD,
      env.KANBAN_ASK_OLLAMA_AUTH_HEADER,
    ]) {
      if (!secret || secret.length < 8) continue;
      out = out.split(secret).join('[redacted]');
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret) out = out.split(escaped).join('[redacted]');
    }
    return out;
  }

  function logFailure(kind, detail) {
    const nowTs = now();
    const last = lastLoggedAt.get(kind);
    if (last !== undefined && nowTs - last < LOG_WINDOW_MS) return;
    lastLoggedAt.set(kind, nowTs);
    logger.warn(
      redactSecrets(`${LOG_PREFIX} request failed: ${detail} [provider=${provider}, model=${modelName(env)}]`),
    );
  }

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
    if (isLocalOllama(env)) {
      return isNonEmpty(env.KANBAN_ASK_DAILY_CAP) ? intFrom(env.KANBAN_ASK_DAILY_CAP, Infinity) : Infinity;
    }
    return intFrom(env.KANBAN_ASK_DAILY_CAP, 50);
  }

  function perIpHourlyLimit() {
    if (isLocalOllama(env)) {
      return isNonEmpty(env.KANBAN_ASK_PER_IP_PER_HOUR) ? intFrom(env.KANBAN_ASK_PER_IP_PER_HOUR, Infinity) : Infinity;
    }
    return intFrom(env.KANBAN_ASK_PER_IP_PER_HOUR, 3);
  }

  function checkLimits(ip) {
    const daily = dailyCap();
    const hourly = perIpHourlyLimit();
    if (!Number.isFinite(daily) && !Number.isFinite(hourly)) {
      return null;
    }
    pruneGlobal();
    if (Number.isFinite(daily) && globalTimestamps.length >= daily) return 'daily_cap_reached';
    const list = pruneIp(ip);
    if (Number.isFinite(hourly) && list.length >= hourly) return 'ip_limit_reached';
    return null;
  }

  function consume(ip) {
    const daily = dailyCap();
    const hourly = perIpHourlyLimit();
    if (!Number.isFinite(daily) && !Number.isFinite(hourly)) {
      return;
    }
    const ts = now();
    if (Number.isFinite(daily)) globalTimestamps.push(ts);
    if (Number.isFinite(hourly)) {
      if (!ipTimestamps.has(ip)) ipTimestamps.set(ip, []);
      ipTimestamps.get(ip).push(ts);
    }
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
    const scoped = snapshotProjects(env);
    res.json({
      enabled: true,
      gated: true,
      provider,
      model: modelName(env),
      // v3.9.2: 'all' means the password is an owner credential over the whole
      // board; a list means this deployment deliberately narrowed the snapshot.
      scope: scoped ? scoped : 'all',
    });
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
    // v3.10.4: commit-level history (public GitHub API, cached) so questions
    // about "what changed recently in the code" are answered from fact.
    const recentCommits = await gatherRecentCommits({ fetchImpl: deps.commitsFetch });
    const snapshot = gatherSnapshot(store, { projects: snapshotProjects(env) });
    const fallback = !snapshot || snapshot.available === false;
    if (fallback) {
      console.warn('[kanban ask] live board snapshot unavailable; answering from the static knowledge pack');
    }
    const systemPrompt = buildSystemPrompt({
      snapshot,
      retrieved,
      recentCommits,
      maxTokens: maxPromptTokens,
    });
    const model = modelName(env);
    // 1500, not 600: a question spanning every project produced a table that
    // was cut off mid-sentence. The budget is a ceiling, not a reservation —
    // a short answer still costs what it costs.
    const maxOutputTokens = intFrom(env.KANBAN_ASK_MAX_OUTPUT_TOKENS, 1500);
    const timeoutMs = intFrom(env.KANBAN_ASK_TIMEOUT_MS, 45000);

    // 5. Call upstream model provider (OpenRouter or Ollama).
    let upstream;
    const startedAt = now();
    const isOllama = provider === 'ollama';
    const targetUrl = isOllama
      ? `${ollamaHost(env)}/v1/chat/completions`
      : OPENROUTER_URL;

    const headers = {
      'Content-Type': 'application/json',
    };

    if (isOllama) {
      // Option 1 (Cloudflare Tunnel) or custom auth gateway support
      if (isNonEmpty(env.KANBAN_ASK_OLLAMA_AUTH_HEADER)) {
        const authVal = env.KANBAN_ASK_OLLAMA_AUTH_HEADER.trim();
        headers['Authorization'] = authVal.startsWith('Bearer ') ? authVal : `Bearer ${authVal}`;
      }
    } else {
      headers['Authorization'] = `Bearer ${env.KANBAN_ASK_OPENROUTER_API_KEY}`;
      headers['HTTP-Referer'] = OPENROUTER_REFERER;
      headers['X-Title'] = OPENROUTER_TITLE;
    }

    const providerLabel = isOllama ? 'Ollama' : 'OpenRouter';

    const reqBody = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ],
      temperature: 0.2,
    };
    if (isOllama) {
      reqBody.keep_alive = -1;
    }
    // For OpenRouter: clamp output tokens to prevent runaway credit spend.
    // For Ollama (local): do not impose a token limit unless explicitly set
    // in KANBAN_ASK_MAX_OUTPUT_TOKENS, so thinking/reasoning models (qwen3.6)
    // are not truncated during their thought chain.
    if (!isOllama) {
      reqBody.max_tokens = maxOutputTokens;
    } else if (isNonEmpty(env.KANBAN_ASK_MAX_OUTPUT_TOKENS)) {
      reqBody.max_tokens = maxOutputTokens;
    }

    const maxAttempts = isOllama ? 3 : 1;
    let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastErr = null;
      try {
        upstream = await fetchImpl(targetUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(reqBody),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        lastErr = err;
        const aborted =
          err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR');
        // The upstream BODY is still never logged — only the shape of the
        // failure, which is what an operator needs and a visitor cannot abuse.
        if (aborted) {
          // Cold-start: a local Ollama is slow to load the model, so a bare
          // timeout on attempt 1-of-3 is exactly the transient it should retry
          // (deep-review). Only give up when attempts are exhausted.
          if (attempt < maxAttempts) {
            if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
            continue;
          }
          logFailure('timeout', `timed out after ${now() - startedAt}ms (KANBAN_ASK_TIMEOUT_MS=${timeoutMs})`);
          return res.status(503).json({ error: 'timeout' });
        }
        if (attempt < maxAttempts) {
          if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
        }
        // Final attempt: fall out with lastErr set so the network-log branch
        // below reports the errno (do NOT clear it here).
        continue;
      }
      // Deep-review: an HTTP 5xx (model loading / Ollama capacity) is also the
      // transient a local provider should retry — previously only thrown
      // transport errors did.
      if (upstream && !upstream.ok && upstream.status >= 500 && attempt < maxAttempts) {
        upstream = null;
        if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      break;
    }

    if (lastErr) {
      // `fetch` reports a transport failure as a bare `TypeError` whose
      // MESSAGE and `cause` carry the only useful part — the errno. Logging
      // just the name (v3.6.1) produced "TypeError" and nothing else, which
      // narrowed nothing: DNS failure, refused connection, unreachable
      // network and a TLS error all look identical from the name alone.
      const cause = lastErr?.cause;
      const detail = [
        lastErr?.name,
        lastErr?.message,
        cause?.code || cause?.errno,
        cause?.message && cause.message !== lastErr?.message ? cause.message : null,
        cause?.hostname ? `host=${cause.hostname}` : null,
      ]
        .filter(Boolean)
        .join(' | ');
      logFailure('network', `could not reach ${providerLabel}: ${safeLogValue(detail || 'unknown', 400)}`);
      return res.status(502).json({ error: 'gateway_error' });
    }

    if (!upstream || !upstream.ok) {
      const status = upstream?.status ?? 0;
      logFailure(`http_${status}`, `${providerLabel} answered ${status} — ${hintForUpstreamStatus(status, provider)}`);
      return res.status(502).json({ error: 'gateway_error' });
    }

    let data;
    try {
      data = await upstream.json();
    } catch {
      logFailure('unparseable', `${providerLabel} returned a 2xx that was not JSON`);
      return res.status(502).json({ error: 'gateway_error' });
    }

    const answer = data?.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || answer.trim().length === 0) {
      // A 2xx with no content is the shape an upstream refusal or a
      // length/filter stop takes, so surface the reason the API gives.
      const why = data?.choices?.[0]?.finish_reason || data?.error?.code || 'no content';
      logFailure('empty', `${providerLabel} returned 200 with an empty answer (${safeLogValue(why)})`);
      return res.status(502).json({ error: 'gateway_error' });
    }

    // Only a fully successful answer spends the cap/IP budget.
    consume(ip);

    res.json(fallback ? { answer, model, provider, fallback: true } : { answer, model, provider });
  });

  return router;
}
