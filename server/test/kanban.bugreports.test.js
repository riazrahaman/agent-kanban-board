/**
 * In-app "Report a Bug/Request a feature" -> ONE private Telegram message
 * (v2.16.0 filed a GitHub issue; switched to Telegram, card
 * bug-report-to-telegram).
 *
 * Covers routes/bugReports.js end to end over real HTTP (createApp + a fake
 * injected `fetch`, never the real network): the feature's off-by-default
 * gate (Turnstile + bot token + resolvable chat id), the bot/chat resolution
 * order, the honeypot, validation limits, Turnstile outcomes, the per-IP/
 * daily rate limits (incl. an X-Forwarded-For spoof attempt), Telegram
 * delivery (429 retry honouring retry_after, upstream failures), message
 * formatting/escaping and the 4096-char fit, and secret-free logging. Also
 * guards that mounting this unauthenticated route does not weaken auth on
 * any other route and that a report creates no board card.
 */
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import {
  REPORT_HEADER,
  cleanMultiline,
  cleanOneLine,
  escapeWithin,
  formatReportMessage,
  hintForTelegramStatus,
  ignoredLocalOverrides,
  looksLikeTurnstileSiteKey,
  neutralizeEntities,
  reportTelegramTarget,
  safeLogValue,
  stripControlChars,
  turnstileSiteverifyUrl,
} from '../routes/bugReports.js';
import {
  TELEGRAM_TEXT_LIMIT,
  isProductionRuntime,
  resetTelegramPause,
  scrubSecret,
  sendTelegramMessage,
  telegramPausedUntil,
} from '../telegramSend.js';

// The 429 pause is module-level (shared by every report send in the
// process), so each test starts unpaused.
beforeEach(() => resetTelegramPause());

// Telegram-shaped dummy bot token (never a real one).
const DUMMY_BOT_TOKEN = '123456789:AAFakeBotTokenForTestsOnly_abcdefghijk';
const ALERT_CHAT = '-1001111111111';
const REPORT_CHAT = '-1002222222222';

const ENV_KEYS = [
  'KANBAN_TELEGRAM_BOT_TOKEN',
  'KANBAN_TELEGRAM_CHAT_ID',
  'KANBAN_REPORT_TELEGRAM_CHAT_ID',
  'KANBAN_REPORT_TELEGRAM_API_URL',
  'KANBAN_BOARD_URL',
  'TURNSTILE_SECRET',
  'TURNSTILE_SITE_KEY',
  'TURNSTILE_HOSTNAMES',
  'TURNSTILE_SITEVERIFY_URL',
  'KANBAN_REPORT_DAILY_CAP',
  'KANBAN_REPORT_PER_IP_PER_HOUR',
  // Pre-Telegram variables: no longer read; listed so a value in the shell
  // cannot leak in, and so the "GitHub variables are ignored" tests can set
  // them explicitly.
  'KANBAN_REPORT_GITHUB_TOKEN',
  'KANBAN_REPORT_REPO',
  'KANBAN_REPORT_GITHUB_API_URL',
  'KANBAN_AUTH_TOKEN',
  'KANBAN_TRUST_PROXY',
  'KANBAN_ALLOWED_ORIGIN',
  'NODE_ENV',
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_PROJECT_ID',
];

function configureEnv(overrides = {}) {
  process.env.KANBAN_TELEGRAM_BOT_TOKEN = DUMMY_BOT_TOKEN;
  process.env.KANBAN_TELEGRAM_CHAT_ID = ALERT_CHAT;
  process.env.TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
  process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function saveEnv() {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  return saved;
}

function restoreEnv(saved) {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function jsonRequest(baseUrl, route, options = {}) {
  const res = await fetch(`${baseUrl}${route}`, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}

const REPORT_TITLE = 'Board shows blank column';
const REPORT_DESCRIPTION = 'Steps: open the board, switch project, column X is blank for no reason.';

function postBody(overrides = {}) {
  return JSON.stringify({
    title: REPORT_TITLE,
    description: REPORT_DESCRIPTION,
    turnstileToken: 'test-token',
    website: '',
    ...overrides,
  });
}

function post(baseUrl, overrides = {}, headers = {}) {
  return jsonRequest(baseUrl, '/api/bug-reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: postBody(overrides),
  });
}

function fakeResponse(status, body, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (k) => lower[k.toLowerCase()] ?? null },
  };
}

function okTurnstileBody(overrides = {}) {
  return { success: true, action: 'bug-report', hostname: 'board.example.test', ...overrides };
}

function okTelegram() {
  return fakeResponse(200, { ok: true, result: { message_id: 7 } });
}

function telegramError(status, description, extra = {}) {
  return fakeResponse(status, { ok: false, error_code: status, description, ...extra });
}

/**
 * Builds an injectable fetch that dispatches on URL: Turnstile siteverify vs
 * the Telegram sendMessage endpoint. Each handler is a function of the call
 * count FOR THAT endpoint (1-based) so tests can script "fail once, then
 * succeed". Every call is recorded in `.calls`; Telegram calls also in
 * `.telegram` with the parsed JSON body. Any other URL (GitHub included)
 * throws, so a stray outbound call fails the test.
 */
function makeFetch({ turnstile, telegram } = {}) {
  let turnstileCalls = 0;
  let telegramCalls = 0;
  const calls = [];
  const telegramBodies = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('challenges.cloudflare.com')) {
      turnstileCalls += 1;
      if (!turnstile) return fakeResponse(200, okTurnstileBody());
      const out = turnstile(turnstileCalls, opts);
      if (out instanceof Error) throw out;
      return out;
    }
    if (String(url).endsWith('/sendMessage')) {
      telegramCalls += 1;
      telegramBodies.push({ url: String(url), body: JSON.parse(opts.body) });
      if (!telegram) return okTelegram();
      const out = telegram(telegramCalls, opts);
      if (out instanceof Error) throw out;
      return out;
    }
    throw new Error(`unexpected fetch url in test: ${url}`);
  };
  fn.calls = calls;
  fn.telegram = telegramBodies;
  return fn;
}

function recordingSleep() {
  const waits = [];
  const fn = async (ms) => {
    waits.push(ms);
  };
  fn.waits = waits;
  return fn;
}

async function withApp(bugReportsDeps, fn) {
  const deps = { sleep: async () => {}, ...bugReportsDeps };
  const app = createApp({ bugReports: deps });
  const { server, baseUrl } = await startTestServer(app);
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Swaps the given console methods for recording stubs, runs `fn`, restores
 * the originals even on throw, and returns `{ warn, error, info, log }`
 * arrays of the args joined per call. */
async function captureConsole(fn) {
  const originals = { warn: console.warn, error: console.error, info: console.info, log: console.log };
  const lines = { warn: [], error: [], info: [], log: [] };
  console.warn = (...args) => lines.warn.push(args.join(' '));
  console.error = (...args) => lines.error.push(args.join(' '));
  console.info = (...args) => lines.info.push(args.join(' '));
  console.log = (...args) => lines.log.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.warn = originals.warn;
    console.error = originals.error;
    console.info = originals.info;
    console.log = originals.log;
  }
  return lines;
}

function allLines(lines) {
  return [...lines.warn, ...lines.error, ...lines.info, ...lines.log].join('\n');
}

/** Asserts every <b>/<i>/<pre> opened in `text` is closed, in order. */
function assertBalancedTags(text) {
  const stack = [];
  for (const m of text.matchAll(/<(\/?)(b|i|pre)>/g)) {
    if (m[1]) assert.equal(stack.pop(), m[2], `unbalanced </${m[2]}>`);
    else stack.push(m[2]);
  }
  assert.deepEqual(stack, [], 'every tag must be closed');
  // Any other '<' must be an escaped one.
  const stray = text.replace(/<\/?(b|i|pre)>/g, '');
  assert.doesNotMatch(stray, /[<>]/, 'no raw < or > outside the emitted tags');
}

describe('bug reports: feature gate and bot/chat resolution', () => {
  let saved;
  before(() => {
    saved = saveEnv();
  });
  afterEach(() => restoreEnv(saved));

  it('is off when unconfigured: config reports disabled, POST 404s', async () => {
    clearEnv();
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const cfg = await jsonRequest(baseUrl, '/api/bug-reports/config');
      assert.equal(cfg.res.status, 200);
      assert.deepEqual(cfg.body, { enabled: false });
      const res = await post(baseUrl);
      assert.equal(res.res.status, 404);
      assert.equal(fetchImpl.calls.length, 0);
    });
  });

  it('is off when Turnstile is set but there is no bot token', async () => {
    clearEnv();
    configureEnv({ KANBAN_TELEGRAM_BOT_TOKEN: undefined });
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const cfg = await jsonRequest(baseUrl, '/api/bug-reports/config');
      assert.deepEqual(cfg.body, { enabled: false });
      assert.equal((await post(baseUrl)).res.status, 404);
      assert.equal(fetchImpl.calls.length, 0);
    });
  });

  it('is off when there is a bot token but no chat id of either kind', async () => {
    clearEnv();
    configureEnv({ KANBAN_TELEGRAM_CHAT_ID: undefined });
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const cfg = await jsonRequest(baseUrl, '/api/bug-reports/config');
      assert.deepEqual(cfg.body, { enabled: false });
    });
  });

  it('is off when the bot and chat are set but Turnstile is not', async () => {
    clearEnv();
    configureEnv({ TURNSTILE_SECRET: undefined });
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const cfg = await jsonRequest(baseUrl, '/api/bug-reports/config');
      assert.deepEqual(cfg.body, { enabled: false });
    });
  });

  it('is on with only the report chat override (no alert chat)', async () => {
    clearEnv();
    configureEnv({ KANBAN_TELEGRAM_CHAT_ID: undefined, KANBAN_REPORT_TELEGRAM_CHAT_ID: REPORT_CHAT });
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const cfg = await jsonRequest(baseUrl, '/api/bug-reports/config');
      assert.equal(cfg.body.enabled, true);
      assert.equal((await post(baseUrl)).res.status, 201);
      assert.equal(fetchImpl.telegram[0].body.chat_id, REPORT_CHAT);
    });
  });

  it('KANBAN_REPORT_TELEGRAM_CHAT_ID wins over KANBAN_TELEGRAM_CHAT_ID; the bot is always KANBAN_TELEGRAM_BOT_TOKEN', async () => {
    clearEnv();
    configureEnv({ KANBAN_REPORT_TELEGRAM_CHAT_ID: REPORT_CHAT });
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      assert.equal((await post(baseUrl)).res.status, 201);
    });
    assert.equal(fetchImpl.telegram.length, 1);
    assert.equal(fetchImpl.telegram[0].body.chat_id, REPORT_CHAT);
    assert.equal(fetchImpl.telegram[0].url, `https://api.telegram.org/bot${DUMMY_BOT_TOKEN}/sendMessage`);
  });

  it('falls back to KANBAN_TELEGRAM_CHAT_ID when no report chat is set (blank counts as unset)', async () => {
    clearEnv();
    configureEnv({ KANBAN_REPORT_TELEGRAM_CHAT_ID: '   ' });
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      assert.equal((await post(baseUrl)).res.status, 201);
    });
    assert.equal(fetchImpl.telegram[0].body.chat_id, ALERT_CHAT);
  });

  it('reportTelegramTarget resolves in the documented order', () => {
    const before = saveEnv();
    try {
      clearEnv();
      assert.equal(reportTelegramTarget().enabled, false);
      process.env.KANBAN_TELEGRAM_BOT_TOKEN = DUMMY_BOT_TOKEN;
      assert.equal(reportTelegramTarget().enabled, false, 'a bot alone has nowhere to send');
      process.env.KANBAN_TELEGRAM_CHAT_ID = ALERT_CHAT;
      let t = reportTelegramTarget();
      assert.equal(t.enabled, true);
      assert.equal(t.chatId, ALERT_CHAT);
      assert.equal(t.chatSource, 'KANBAN_TELEGRAM_CHAT_ID');
      assert.equal(t.apiUrl, 'https://api.telegram.org');
      process.env.KANBAN_REPORT_TELEGRAM_CHAT_ID = REPORT_CHAT;
      t = reportTelegramTarget();
      assert.equal(t.chatId, REPORT_CHAT);
      assert.equal(t.chatSource, 'KANBAN_REPORT_TELEGRAM_CHAT_ID');
      assert.equal(t.botToken, DUMMY_BOT_TOKEN);
      delete process.env.KANBAN_TELEGRAM_BOT_TOKEN;
      assert.equal(reportTelegramTarget().enabled, false, 'no override exists for the bot token');
    } finally {
      restoreEnv(before);
    }
  });

  it('GitHub variables alone do not enable the feature', async () => {
    clearEnv();
    configureEnv({
      KANBAN_TELEGRAM_BOT_TOKEN: undefined,
      KANBAN_TELEGRAM_CHAT_ID: undefined,
      KANBAN_REPORT_GITHUB_TOKEN: `ghp_${'a'.repeat(36)}`,
      KANBAN_REPORT_REPO: 'owner/repo',
      KANBAN_REPORT_GITHUB_API_URL: 'http://127.0.0.1:1',
    });
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const cfg = await jsonRequest(baseUrl, '/api/bug-reports/config');
      assert.deepEqual(cfg.body, { enabled: false });
      assert.equal((await post(baseUrl)).res.status, 404);
    });
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('GitHub variables are ignored when set alongside Telegram: no GitHub call, one Telegram message', async () => {
    clearEnv();
    configureEnv({
      KANBAN_REPORT_GITHUB_TOKEN: `ghp_${'a'.repeat(36)}`,
      KANBAN_REPORT_REPO: 'owner/repo',
      KANBAN_REPORT_GITHUB_API_URL: 'http://127.0.0.1:1',
    });
    const fetchImpl = makeFetch();
    const lines = await captureConsole(() =>
      withApp({ fetch: fetchImpl }, async (baseUrl) => {
        const res = await post(baseUrl);
        assert.equal(res.res.status, 201);
        assert.deepEqual(res.body, { ok: true });
      }),
    );
    assert.equal(fetchImpl.calls.filter((c) => /github|127\.0\.0\.1:1/.test(c.url)).length, 0);
    assert.equal(fetchImpl.telegram.length, 1);
    assert.doesNotMatch(allLines(lines), /GITHUB|REPORT_REPO/);
  });

  it('config never leaks the bot token, chat id or Turnstile secret, only the public site key', async () => {
    clearEnv();
    configureEnv({ KANBAN_REPORT_TELEGRAM_CHAT_ID: REPORT_CHAT });
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const cfg = await jsonRequest(baseUrl, '/api/bug-reports/config');
      assert.equal(cfg.res.status, 200);
      assert.deepEqual(cfg.body, { enabled: true, siteKey: process.env.TURNSTILE_SITE_KEY });
      const raw = JSON.stringify(cfg.body);
      assert.ok(!raw.includes(DUMMY_BOT_TOKEN));
      assert.ok(!raw.includes(REPORT_CHAT));
      assert.ok(!raw.includes(process.env.TURNSTILE_SECRET));
    });
  });

  it('unauthenticated route does not weaken auth on other routes, and a report creates no board card', async () => {
    clearEnv();
    configureEnv({ KANBAN_AUTH_TOKEN: 'board-token' });
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const before = await jsonRequest(baseUrl, '/api/tasks');
      // The bug-report route itself needs no token.
      const report = await post(baseUrl);
      assert.equal(report.res.status, 201);

      // No card appeared anywhere as a side effect.
      const afterTasks = await jsonRequest(baseUrl, '/api/tasks');
      assert.equal(afterTasks.res.status, 200);
      assert.equal(JSON.stringify(afterTasks.body).length, JSON.stringify(before.body).length);
      assert.ok(!JSON.stringify(afterTasks.body).includes(REPORT_TITLE));

      // Every other mutating route is still fail-closed without it.
      const createTask = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 't-1', project: 'default', title: 'x', round: 1, status: 'BACKLOG' }),
      });
      assert.equal(createTask.res.status, 401);
    });
  });
});

describe('bug reports: honeypot + validation', () => {
  let saved;
  before(() => {
    saved = saveEnv();
    clearEnv();
    configureEnv();
  });
  after(() => restoreEnv(saved));

  it('a filled honeypot returns a quiet fake success and never calls Telegram or Turnstile', async () => {
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl, { website: 'http://spam.example' });
      assert.equal(res.res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.equal(fetchImpl.calls.length, 0, 'honeypot must short-circuit before any outbound call');
    });
  });

  it('a non-string honeypot value is treated as filled, not thrown on', async () => {
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl, { website: ['not-a-string'] });
      assert.equal(res.res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.equal(fetchImpl.calls.length, 0);
    });
  });

  it('rejects non-string title/description/turnstileToken as invalid_payload', async () => {
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const res = await post(baseUrl, { title: 42 });
      assert.equal(res.res.status, 400);
      assert.equal(res.body.error, 'invalid_payload');
    });
  });

  it('rejects an empty (post-trim) title', async () => {
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const res = await post(baseUrl, { title: '   ' });
      assert.equal(res.res.status, 400);
      assert.equal(res.body.error, 'invalid_title');
    });
  });

  it('rejects a title over 120 chars', async () => {
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const res = await post(baseUrl, { title: 'x'.repeat(121) });
      assert.equal(res.res.status, 400);
      assert.equal(res.body.error, 'invalid_title');
    });
  });

  it('accepts a title at exactly 120 chars', async () => {
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const res = await post(baseUrl, { title: 'x'.repeat(120) });
      assert.equal(res.res.status, 201);
    });
  });

  it('rejects a description under 10 chars', async () => {
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const res = await post(baseUrl, { description: 'too short' });
      assert.equal(res.res.status, 400);
      assert.equal(res.body.error, 'invalid_description');
    });
  });

  it('rejects a description over 5000 chars', async () => {
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const res = await post(baseUrl, { description: 'x'.repeat(5001) });
      assert.equal(res.res.status, 400);
      assert.equal(res.body.error, 'invalid_description');
    });
  });
});

describe('bug reports: Turnstile outcomes', () => {
  let saved;
  before(() => {
    saved = saveEnv();
  });
  afterEach(() => restoreEnv(saved));

  it('success:false (fail or already-spent/replayed token) -> 403 invalid_captcha, nothing sent', async () => {
    clearEnv();
    configureEnv();
    const fetchImpl = makeFetch({
      turnstile: () => fakeResponse(200, { success: false, 'error-codes': ['invalid-input-response'] }),
    });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl);
      assert.equal(res.res.status, 403);
      assert.equal(res.body.error, 'invalid_captcha');
      assert.equal(fetchImpl.telegram.length, 0, 'must not send on a failed captcha');
    });
  });

  it('wrong action -> 403 invalid_captcha_action', async () => {
    clearEnv();
    configureEnv();
    const fetchImpl = makeFetch({ turnstile: () => fakeResponse(200, okTurnstileBody({ action: 'login' })) });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl);
      assert.equal(res.res.status, 403);
      assert.equal(res.body.error, 'invalid_captcha_action');
    });
  });

  it('hostname outside the allow-list -> 403 invalid_captcha_hostname', async () => {
    clearEnv();
    configureEnv({ TURNSTILE_HOSTNAMES: 'allowed.example.test' });
    const fetchImpl = makeFetch({
      turnstile: () => fakeResponse(200, okTurnstileBody({ hostname: 'evil.example.test' })),
    });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl);
      assert.equal(res.res.status, 403);
      assert.equal(res.body.error, 'invalid_captcha_hostname');
      assert.equal(fetchImpl.telegram.length, 0);
    });
  });

  it('hostname IS in the allow-list -> passes through to sending', async () => {
    clearEnv();
    configureEnv({ TURNSTILE_HOSTNAMES: 'allowed.example.test,other.example.test' });
    const fetchImpl = makeFetch({
      turnstile: () => fakeResponse(200, okTurnstileBody({ hostname: 'allowed.example.test' })),
    });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl);
      assert.equal(res.res.status, 201);
    });
  });

  it('TURNSTILE_HOSTNAMES unset skips the hostname check entirely', async () => {
    clearEnv();
    configureEnv({ TURNSTILE_HOSTNAMES: undefined });
    const fetchImpl = makeFetch({
      turnstile: () => fakeResponse(200, okTurnstileBody({ hostname: 'anything.example.test' })),
    });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl);
      assert.equal(res.res.status, 201);
    });
  });

  it('TURNSTILE_SITEVERIFY_URL redirects siteverify (local stub), default is Cloudflare', async () => {
    clearEnv();
    configureEnv({ TURNSTILE_SITEVERIFY_URL: 'http://127.0.0.1:9/turnstile/v0/siteverify' });
    const seen = [];
    const fetchImpl = async (url, opts) => {
      seen.push(String(url));
      if (String(url).endsWith('/siteverify')) return fakeResponse(200, okTurnstileBody());
      return okTelegram();
    };
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      assert.equal((await post(baseUrl)).res.status, 201);
    });
    assert.equal(seen[0], 'http://127.0.0.1:9/turnstile/v0/siteverify');
  });

  it('a Turnstile network error fails closed: 502 verification_unavailable', async () => {
    clearEnv();
    configureEnv();
    const fetchImpl = makeFetch({ turnstile: () => new Error('ECONNRESET') });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl);
      assert.equal(res.res.status, 502);
      assert.equal(res.body.error, 'verification_unavailable');
    });
  });

  it('a Turnstile network failure does NOT consume the daily cap (retry is free)', async () => {
    clearEnv();
    configureEnv({ KANBAN_REPORT_DAILY_CAP: '1' });
    let fail = true;
    const fetchImpl = makeFetch({
      turnstile: () => (fail ? new Error('ECONNRESET') : fakeResponse(200, okTurnstileBody())),
    });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      assert.equal((await post(baseUrl)).res.status, 502);
      fail = false;
      const second = await post(baseUrl);
      assert.equal(second.res.status, 201, 'the failed attempt must not have spent the cap of 1');
    });
  });
});

describe('bug reports: rate limits', () => {
  let saved;
  before(() => {
    saved = saveEnv();
  });
  afterEach(() => restoreEnv(saved));

  it('enforces the per-IP hourly cap', async () => {
    clearEnv();
    configureEnv({ KANBAN_REPORT_PER_IP_PER_HOUR: '2', KANBAN_REPORT_DAILY_CAP: '100' });
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await post(baseUrl)).res.status);
      assert.deepEqual(statuses, [201, 201, 429]);
    });
  });

  it('enforces the global daily cap across different IPs', async () => {
    clearEnv();
    configureEnv({ KANBAN_REPORT_PER_IP_PER_HOUR: '100', KANBAN_REPORT_DAILY_CAP: '1' });
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const first = await post(baseUrl, {}, { 'X-Forwarded-For': '203.0.113.9' });
      assert.equal(first.res.status, 201);
      // A different reported IP — the daily cap is global, not per-IP.
      const second = await post(baseUrl, {}, { 'X-Forwarded-For': '203.0.113.200' });
      assert.equal(second.res.status, 429);
      assert.equal(second.body.error, 'daily_cap_reached');
    });
  });

  it('a spoofed X-Forwarded-For prefix cannot dodge the per-IP limit beyond the trusted hop', async () => {
    clearEnv();
    // KANBAN_TRUST_PROXY=1: only the hop nearest the server is trusted, so
    // Express reads the RIGHTMOST X-Forwarded-For entry as the client.
    configureEnv({ KANBAN_REPORT_PER_IP_PER_HOUR: '2', KANBAN_REPORT_DAILY_CAP: '100', KANBAN_TRUST_PROXY: '1' });
    await withApp({ fetch: makeFetch() }, async (baseUrl) => {
      const realIp = '198.51.100.7';
      const chains = [`9.9.9.9, ${realIp}`, `1.2.3.4, 5.6.7.8, ${realIp}`, `${Math.random()}, ${realIp}`];
      const statuses = [];
      for (const chain of chains) statuses.push((await post(baseUrl, {}, { 'X-Forwarded-For': chain })).res.status);
      assert.deepEqual(statuses, [201, 201, 429], 'every spoofed prefix must still collapse onto the one real-IP bucket');
    });
  });

  it('a report Telegram rejects does not consume the per-IP or daily budget (same app instance)', async () => {
    clearEnv();
    configureEnv({ KANBAN_REPORT_DAILY_CAP: '1', KANBAN_REPORT_PER_IP_PER_HOUR: '1' });
    let shouldFail = true;
    const fetchImpl = makeFetch({
      telegram: () => (shouldFail ? telegramError(400, 'Bad Request: chat not found') : okTelegram()),
    });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const failed = await post(baseUrl);
      assert.equal(failed.res.status, 502);
      const failedAgain = await post(baseUrl);
      assert.equal(failedAgain.res.status, 502, 'a second failure is still not rate limited');

      shouldFail = false;
      const succeeded = await post(baseUrl);
      assert.equal(succeeded.res.status, 201, 'the budget of 1 must still be available after the failures');

      const third = await post(baseUrl);
      assert.equal(third.res.status, 429, 'the budget IS spent once a report actually arrives');
    });
  });

  it('a Telegram network failure does not consume the budget either', async () => {
    clearEnv();
    configureEnv({ KANBAN_REPORT_DAILY_CAP: '1' });
    let fail = true;
    const fetchImpl = makeFetch({ telegram: () => (fail ? new Error('ECONNREFUSED') : okTelegram()) });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      assert.equal((await post(baseUrl)).res.status, 502);
      fail = false;
      assert.equal((await post(baseUrl)).res.status, 201);
    });
  });
});

describe('bug reports: Telegram delivery', () => {
  let saved;
  before(() => {
    saved = saveEnv();
  });
  afterEach(() => restoreEnv(saved));

  it('a valid report is sent as exactly ONE sendMessage with HTML parse mode and no link preview', async () => {
    clearEnv();
    configureEnv();
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl, { meta: { viewport: '1280x720' } }, { 'User-Agent': 'TestAgent/1.0' });
      assert.equal(res.res.status, 201);
      assert.deepEqual(res.body, { ok: true });
    });
    assert.equal(fetchImpl.telegram.length, 1);
    const { url, body } = fetchImpl.telegram[0];
    assert.equal(url, `https://api.telegram.org/bot${DUMMY_BOT_TOKEN}/sendMessage`);
    assert.equal(body.chat_id, ALERT_CHAT);
    assert.equal(body.parse_mode, 'HTML');
    assert.equal(body.disable_web_page_preview, true);
    assert.ok(body.text.startsWith(REPORT_HEADER));
    assert.ok(body.text.includes(`<b>${REPORT_TITLE}</b>`));
    assert.ok(body.text.includes(`<pre>${REPORT_DESCRIPTION.replace(/&/g, '&amp;')}</pre>`));
    assert.match(body.text, /viewport 1280x720/);
    assert.match(body.text, /UA: TestAgent\/1\.0/);
    assertBalancedTags(body.text);
  });

  it('posts to KANBAN_REPORT_TELEGRAM_API_URL when set (local stub override, trailing slash tolerated)', async () => {
    clearEnv();
    configureEnv({ KANBAN_REPORT_TELEGRAM_API_URL: 'http://127.0.0.1:3457/' });
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      assert.equal((await post(baseUrl)).res.status, 201);
    });
    assert.equal(fetchImpl.telegram[0].url, `http://127.0.0.1:3457/bot${DUMMY_BOT_TOKEN}/sendMessage`);
  });

  it('the visitor IP never appears in the message (even behind a trusted proxy)', async () => {
    clearEnv();
    configureEnv({ KANBAN_TRUST_PROXY: '1' });
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      assert.equal((await post(baseUrl, {}, { 'X-Forwarded-For': '198.51.100.77' })).res.status, 201);
    });
    const sent = JSON.stringify(fetchImpl.telegram[0].body);
    assert.ok(!sent.includes('198.51.100.77'));
    assert.ok(!sent.includes('127.0.0.1'));
    // Turnstile still receives it as remoteip (that is its purpose).
    const verify = fetchImpl.calls.find((c) => c.url.includes('siteverify'));
    assert.match(verify.opts.body, /remoteip=198\.51\.100\.77/);
  });

  it('the board URL appears in the footer only when KANBAN_BOARD_URL is set', async () => {
    clearEnv();
    configureEnv();
    let fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      await post(baseUrl);
    });
    assert.doesNotMatch(fetchImpl.telegram[0].body.text, /Board: /);

    configureEnv({ KANBAN_BOARD_URL: 'https://board.example.test/' });
    fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      await post(baseUrl);
    });
    assert.match(fetchImpl.telegram[0].body.text, /<i>Board: https:\/\/board\.example\.test<\/i>/);
  });

  it('a 429 is retried ONCE after the retry_after Telegram asked for, then succeeds', async () => {
    clearEnv();
    configureEnv();
    const sleep = recordingSleep();
    const fetchImpl = makeFetch({
      telegram: (n) =>
        n === 1 ? telegramError(429, 'Too Many Requests: retry after 3', { parameters: { retry_after: 3 } }) : okTelegram(),
    });
    await withApp({ fetch: fetchImpl, sleep }, async (baseUrl) => {
      assert.equal((await post(baseUrl)).res.status, 201);
    });
    assert.equal(fetchImpl.telegram.length, 2);
    assert.deepEqual(sleep.waits, [3000]);
    assert.equal(fetchImpl.telegram[0].body.text, fetchImpl.telegram[1].body.text, 'the retry resends the same message');
  });

  it('a retry_after over 10s is not sat out in the request: 502 at once, one attempt, no sleep', async () => {
    clearEnv();
    configureEnv();
    const sleep = recordingSleep();
    const fetchImpl = makeFetch({
      telegram: (n) => (n === 1 ? telegramError(429, 'Too Many Requests', { parameters: { retry_after: 3600 } }) : okTelegram()),
    });
    await withApp({ fetch: fetchImpl, sleep }, async (baseUrl) => {
      const res = await post(baseUrl);
      assert.equal(res.res.status, 502);
      assert.equal(res.body.error, 'could_not_send');
    });
    assert.deepEqual(sleep.waits, []);
    assert.equal(fetchImpl.telegram.length, 1);
  });

  it('a second 429 is not retried again: 502 could_not_send after exactly two attempts', async () => {
    clearEnv();
    configureEnv();
    const sleep = recordingSleep();
    const fetchImpl = makeFetch({
      telegram: () => telegramError(429, 'Too Many Requests', { parameters: { retry_after: 1 } }),
    });
    await withApp({ fetch: fetchImpl, sleep }, async (baseUrl) => {
      const res = await post(baseUrl);
      assert.equal(res.res.status, 502);
      assert.equal(res.body.error, 'could_not_send');
    });
    assert.equal(fetchImpl.telegram.length, 2);
    assert.deepEqual(sleep.waits, [1000]);
  });

  it('a 5xx is not retried and returns 502 with no upstream detail', async () => {
    clearEnv();
    configureEnv();
    const fetchImpl = makeFetch({ telegram: () => telegramError(500, 'Internal Server Error') });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl);
      assert.equal(res.res.status, 502);
      assert.deepEqual(res.body, { error: 'could_not_send' });
    });
    assert.equal(fetchImpl.telegram.length, 1);
  });

  it('a 403 (bot not in the channel) returns 502 could_not_send', async () => {
    clearEnv();
    configureEnv();
    const fetchImpl = makeFetch({ telegram: () => telegramError(403, 'Forbidden: bot is not a member of the channel chat') });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl);
      assert.equal(res.res.status, 502);
      assert.deepEqual(res.body, { error: 'could_not_send' });
    });
  });

  it('a network error reaching Telegram returns 502 could_not_send', async () => {
    clearEnv();
    configureEnv();
    const fetchImpl = makeFetch({ telegram: () => new Error('getaddrinfo ENOTFOUND') });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl);
      assert.equal(res.res.status, 502);
      assert.equal(res.body.error, 'could_not_send');
    });
  });

  it('an HTTP 200 whose body is not ok:true is treated as a failure, not a success', async () => {
    clearEnv();
    configureEnv();
    const fetchImpl = makeFetch({ telegram: () => fakeResponse(200, { ok: false, description: 'weird' }) });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      assert.equal((await post(baseUrl)).res.status, 502);
    });
  });

  it('a failure response never echoes the bot token or the upstream description', async () => {
    clearEnv();
    configureEnv();
    const fetchImpl = makeFetch({ telegram: () => telegramError(502, `bad gateway for bot${DUMMY_BOT_TOKEN}`) });
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl);
      const raw = JSON.stringify(res.body);
      assert.ok(!raw.includes(DUMMY_BOT_TOKEN));
      assert.ok(!raw.includes('bad gateway'));
    });
  });
});

describe('bug reports: Telegram message formatting', () => {
  const base = { title: 'A title', description: 'A description long enough', boardVersion: '9.9.9' };

  it('starts with the type marker header and puts the title in bold', () => {
    const text = formatReportMessage(base);
    assert.ok(text.startsWith('🐞 <b>Report a Bug/Request a feature</b>\n\n<b>A title</b>\n\n<pre>'));
    assert.match(text, /<i>Board v9\.9\.9<\/i>/);
    assertBalancedTags(text);
  });

  it('HTML injection in the title and description is escaped (only & < > are touched)', () => {
    const text = formatReportMessage({
      ...base,
      title: '<a href="https://evil.test">click</a> & "quotes"',
      description: '</pre><b>bold</b><a href="tg://x">x</a> & it\'s "fine"',
    });
    assert.ok(text.includes('&lt;a href="https:\u200B//evil.test"&gt;click&lt;/a&gt; &amp; "quotes"'));
    assert.ok(text.includes('<pre>&lt;/pre&gt;&lt;b&gt;bold&lt;/b&gt;&lt;a href="tg://x"&gt;x&lt;/a&gt; &amp; it\'s "fine"</pre>'));
    assert.ok(!text.includes('&quot;'), 'quotes are not entity-escaped (Telegram shows &quot; literally)');
    assertBalancedTags(text);
  });

  it('@mentions and scheme:// links in the title and user agent are neutralised; the <pre> description is left verbatim', () => {
    const text = formatReportMessage({
      ...base,
      title: 'ping @admin see https://evil.test',
      description: 'hello @everyone visit https://evil.test',
      userAgent: 'Bot @owner https://x.test',
    });
    assert.ok(text.includes('<b>ping @\u200Badmin see https:\u200B//evil.test</b>'));
    assert.ok(text.includes('UA: Bot @\u200Bowner https:\u200B//x.test'));
    assert.ok(text.includes('<pre>hello @everyone visit https://evil.test</pre>'), 'pre is not entity-parsed by Telegram');
    assert.ok(!/@admin|@owner/.test(text));
  });

  it('control characters are stripped; newlines in the title collapse, in the description survive', () => {
    const text = formatReportMessage({
      ...base,
      title: 'line1\nline2\u0007\u0000end',
      description: 'para one\r\n\u0001para two\tTabbed\u007f\u0085',
      userAgent: 'UA\r\nInjected: header',
    });
    assert.ok(text.includes('<b>line1 line2 end</b>'));
    assert.ok(text.includes('<pre>para one\npara two\tTabbed</pre>'));
    assert.ok(text.includes('UA: UA Injected: header'));
    assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it('emoji and right-to-left text survive; bidi override controls are removed', () => {
    const text = formatReportMessage({
      ...base,
      title: 'تقرير 🐛 خطأ',
      description: 'שלום עולם 👋🏽 and \u202Egnirts desrever\u202C here',
    });
    assert.ok(text.includes('<b>تقرير 🐛 خطأ</b>'));
    assert.ok(text.includes('שלום עולם 👋🏽 and gnirts desrever here'));
    assert.doesNotMatch(text, /[\u202A-\u202E\u2066-\u2069]/);
  });

  it('a very long title AND a 5000-char markup-heavy description fit in 4096 with balanced tags and whole entities', () => {
    const text = formatReportMessage({
      ...base,
      title: '<&>'.repeat(40),
      description: '<&>'.repeat(1667),
      userAgent: 'U'.repeat(500),
      viewport: '1x1',
      boardUrl: 'https://board.example.test',
    });
    assert.ok(text.length <= TELEGRAM_TEXT_LIMIT, `length ${text.length}`);
    assertBalancedTags(text);
    const pre = text.slice(text.indexOf('<pre>') + 5, text.indexOf('</pre>'));
    assert.match(pre, /^(?:&lt;|&amp;|&gt;)+$/, 'the cut never lands inside an entity');
    assert.match(text, /… description shortened \(\d+ more characters\)/);
    assert.ok(text.includes('<i>Board: https://board.example.test</i>'), 'the footer survives truncation');
    assert.ok(text.includes('UA: ' + 'U'.repeat(200) + '</i>'), 'user agent is capped at 200 chars');
  });

  it('the cut never splits an emoji surrogate pair', () => {
    for (let pad = 0; pad < 4; pad++) {
      const text = formatReportMessage({ ...base, description: 'x'.repeat(pad) + '😀'.repeat(2500) });
      assert.ok(text.length <= TELEGRAM_TEXT_LIMIT);
      assert.ok(text.isWellFormed(), 'no lone surrogate at the cut');
    }
  });

  it('a description that fits is never shortened', () => {
    const description = 'y'.repeat(3500);
    const text = formatReportMessage({ ...base, description });
    assert.ok(text.includes(`<pre>${description}</pre>`));
    assert.doesNotMatch(text, /shortened/);
  });

  it('escapeWithin stops at a whole character and reports how much was left out', () => {
    assert.deepEqual(escapeWithin('a&b', 5), { text: 'a', omitted: 2 });
    assert.deepEqual(escapeWithin('a&b', 6), { text: 'a&amp;', omitted: 1 });
    assert.deepEqual(escapeWithin('ab', 10), { text: 'ab', omitted: 0 });
  });

  it('drops a viewport that is not WxH digits', () => {
    const text = formatReportMessage({ ...base, viewport: '1x1\n<b>x</b>' });
    assert.doesNotMatch(text, /viewport/);
    assert.match(formatReportMessage({ ...base, viewport: '390x844' }), /viewport 390x844/);
  });

  it('the helpers behave as documented', () => {
    assert.equal(neutralizeEntities('a@b c://d'), 'a@\u200Bb c:\u200B//d');
    assert.equal(cleanOneLine(' a\n\tb\u202E '), 'a b');
    assert.equal(cleanMultiline('a\r\nb\u0000\u2028c'), 'a\nbc');
    assert.equal(stripControlChars('line1\nline2\u0007 end'), 'line1\nline2 end');
  });
});

describe('bug reports: sendTelegramMessage transport', () => {
  it('never rejects when fetch throws, and scrubs the token from what it returns', async () => {
    const out = await sendTelegramMessage({
      botToken: DUMMY_BOT_TOKEN,
      chatId: '1',
      text: 'x',
      fetchImpl: async () => {
        const err = new Error(`connect failed https://api.telegram.org/bot${DUMMY_BOT_TOKEN}/sendMessage`);
        err.name = `Err${DUMMY_BOT_TOKEN}`;
        throw err;
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.networkError, true);
    assert.ok(!JSON.stringify(out).includes(DUMMY_BOT_TOKEN));
  });

  it('scrubs an echoed token from Telegram\'s description and tolerates a non-JSON body', async () => {
    const echo = await sendTelegramMessage({
      botToken: DUMMY_BOT_TOKEN,
      chatId: '1',
      text: 'x',
      fetchImpl: async () => telegramError(401, `Unauthorized ${DUMMY_BOT_TOKEN}`),
    });
    assert.equal(echo.status, 401);
    assert.equal(echo.description, 'Unauthorized [redacted]');
    const notJson = await sendTelegramMessage({
      botToken: DUMMY_BOT_TOKEN,
      chatId: '1',
      text: 'x',
      fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } }),
    });
    assert.equal(notJson.ok, false);
    assert.equal(notJson.status, 502);
  });

  it('a 429 without parameters waits the 1s default before its single retry', async () => {
    const waits = [];
    let n = 0;
    const out = await sendTelegramMessage({
      botToken: DUMMY_BOT_TOKEN,
      chatId: '1',
      text: 'x',
      sleep: async (ms) => waits.push(ms),
      fetchImpl: async () => (++n === 1 ? fakeResponse(429, { ok: false }) : okTelegram()),
    });
    assert.equal(out.ok, true);
    assert.equal(out.attempts, 2);
    assert.deepEqual(waits, [1000]);
  });

  it('scrubSecret removes raw, JSON-escaped and URL-encoded forms and ignores short secrets', () => {
    const secret = '12345:ab/c"d';
    assert.equal(scrubSecret(`x ${secret} y`, secret), 'x [redacted] y');
    assert.equal(scrubSecret(`x ${JSON.stringify(secret).slice(1, -1)} y`, secret), 'x [redacted] y');
    assert.equal(scrubSecret(`x ${encodeURIComponent(secret)} y`, secret), 'x [redacted] y');
    assert.equal(scrubSecret('short abc', 'abc'), 'short abc');
  });
});

// ---------------------------------------------------------------------
// Failure logging: a report that can't be delivered leaves exactly one
// diagnostic console line behind (rate-limited per kind), with the status,
// Telegram's own description and a hint — and never the token, the report
// text, the rendered message or the visitor's IP.
// ---------------------------------------------------------------------

describe('bug reports: Telegram failure logging', () => {
  let saved;
  before(() => {
    saved = saveEnv();
  });
  afterEach(() => restoreEnv(saved));

  // One case per status, unrolled into explicit `it(...)` calls (rather than
  // a loop over a CASES array) so the static test-case count the About page
  // asserts against (client/src/lib/about.test.mjs, counting literal
  // `it(`/`test(` declarations) matches the runner's actual count.
  async function assertFailureLogged({ status, description, hint }) {
    clearEnv();
    configureEnv({ KANBAN_TRUST_PROXY: '1' });
    const fetchImpl = makeFetch({ telegram: () => telegramError(status, description) });
    const lines = await captureConsole(() =>
      withApp({ fetch: fetchImpl }, async (baseUrl) => {
        const res = await post(baseUrl, {}, { 'X-Forwarded-For': '203.0.113.42' });
        assert.equal(res.res.status, 502);
      }),
    );
    const failureLine = lines.error.find((l) => l.includes('could_not_send'));
    assert.ok(failureLine, `expected a could_not_send log line, got: ${JSON.stringify(lines)}`);
    assert.match(failureLine, new RegExp(`status=${status}\\b`));
    assert.ok(failureLine.includes(description));
    assert.ok(failureLine.includes(hint), `hint ${hint} missing from ${failureLine}`);
    const everything = allLines(lines);
    assert.ok(!everything.includes(DUMMY_BOT_TOKEN));
    assert.ok(!everything.includes('203.0.113.42'));
    assert.ok(!everything.includes(REPORT_TITLE));
    assert.ok(!everything.includes('Steps: open the board'));
    assert.ok(!everything.includes('Report a Bug/Request a feature'), 'the rendered message is never logged');
  }

  it('a Telegram 400 logs status + description + hint, with no secret/title/description/IP', async () => {
    await assertFailureLogged({ status: 400, description: 'Bad Request: chat not found', hint: 'chat id wrong' });
  });

  it('a Telegram 401 logs status + description + hint, with no secret/title/description/IP', async () => {
    await assertFailureLogged({ status: 401, description: 'Unauthorized', hint: 'bot token invalid/revoked' });
  });

  it('a Telegram 403 logs status + description + hint, with no secret/title/description/IP', async () => {
    await assertFailureLogged({
      status: 403,
      description: 'Forbidden: bot is not a member of the channel chat',
      hint: 'make it a channel admin',
    });
  });

  it('a Telegram 500 logs status + description + hint, with no secret/title/description/IP', async () => {
    await assertFailureLogged({ status: 500, description: 'Internal Server Error', hint: 'Telegram outage' });
  });

  it('a 429 that survives its one retry logs the rate-limit hint and attempts=2', async () => {
    clearEnv();
    configureEnv();
    const fetchImpl = makeFetch({ telegram: () => telegramError(429, 'Too Many Requests', { parameters: { retry_after: 1 } }) });
    const lines = await captureConsole(() =>
      withApp({ fetch: fetchImpl }, async (baseUrl) => {
        await post(baseUrl);
      }),
    );
    const failureLines = lines.error.filter((l) => l.includes('could_not_send'));
    assert.equal(failureLines.length, 1, 'one line per failed request, not per attempt');
    assert.match(failureLines[0], /status=429/);
    assert.match(failureLines[0], /attempts=2/);
    assert.match(failureLines[0], /Telegram rate limit; retry later/);
  });

  it('a network error logs "network error" and the API-URL hint, never the URL (it carries the token)', async () => {
    clearEnv();
    configureEnv();
    const fetchImpl = makeFetch({
      telegram: () => new Error(`fetch failed for https://api.telegram.org/bot${DUMMY_BOT_TOKEN}/sendMessage`),
    });
    const lines = await captureConsole(() =>
      withApp({ fetch: fetchImpl }, async (baseUrl) => {
        await post(baseUrl);
      }),
    );
    const line = lines.error.find((l) => l.includes('could_not_send'));
    assert.ok(line);
    assert.match(line, /network error/);
    assert.match(line, /KANBAN_REPORT_TELEGRAM_API_URL/);
    assert.ok(!allLines(lines).includes(DUMMY_BOT_TOKEN));
    assert.ok(!allLines(lines).includes('api.telegram.org/bot'));
  });

  it('redacts the bot token if Telegram ever echoes it back in `description`, even across the 160-char cut', async () => {
    clearEnv();
    configureEnv();
    const longPrefix = 'x'.repeat(140);
    const fetchImpl = makeFetch({ telegram: () => telegramError(401, `${longPrefix}${DUMMY_BOT_TOKEN} tail`) });
    const lines = await captureConsole(() =>
      withApp({ fetch: fetchImpl }, async (baseUrl) => {
        await post(baseUrl);
      }),
    );
    const line = lines.error.find((l) => l.includes('could_not_send'));
    assert.ok(line);
    assert.ok(!line.includes(DUMMY_BOT_TOKEN));
    assert.ok(!line.includes(DUMMY_BOT_TOKEN.slice(0, 12)), 'not even a surviving prefix');
  });

  it('collapses a description with newline/CR/escape/line-separator into one control-char-free log line', async () => {
    clearEnv();
    configureEnv();
    const fetchImpl = makeFetch({ telegram: () => telegramError(400, 'Bad\nRequest\r\u001b[31m\u2028injected') });
    const lines = await captureConsole(() =>
      withApp({ fetch: fetchImpl }, async (baseUrl) => {
        await post(baseUrl);
      }),
    );
    const line = lines.error.find((l) => l.includes('could_not_send'));
    assert.ok(line);
    assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    assert.match(line, /Bad ?Request/);
  });

  it('a successful send logs only "delivered" — no title, description, message text, token or chat id', async () => {
    clearEnv();
    configureEnv({ KANBAN_REPORT_TELEGRAM_CHAT_ID: REPORT_CHAT });
    const lines = await captureConsole(() =>
      withApp({ fetch: makeFetch() }, async (baseUrl) => {
        assert.equal((await post(baseUrl)).res.status, 201);
      }),
    );
    assert.equal(lines.info.length, 1);
    assert.match(lines.info[0], /delivered 1 report to telegram/);
    const everything = allLines(lines);
    assert.ok(!everything.includes(REPORT_TITLE));
    assert.ok(!everything.includes('Steps: open the board'));
    assert.ok(!everything.includes(DUMMY_BOT_TOKEN));
    assert.ok(!everything.includes(REPORT_CHAT));
  });

  it('rate-limits repeated identical failures to one line per 60s, then logs again after the window', async () => {
    clearEnv();
    configureEnv({ KANBAN_REPORT_PER_IP_PER_HOUR: '100', KANBAN_REPORT_DAILY_CAP: '100' });
    const fetchImpl = makeFetch({ telegram: () => telegramError(401, 'Unauthorized') });
    let clock = 1_000_000;
    const lines = await captureConsole(() =>
      withApp({ fetch: fetchImpl, now: () => clock }, async (baseUrl) => {
        await post(baseUrl);
        clock += 1000; // well within the 60s window
        await post(baseUrl);
        clock += 61_000; // past the window
        await post(baseUrl);
      }),
    );
    const failureLines = lines.error.filter((l) => l.includes('could_not_send'));
    assert.equal(failureLines.length, 2, 'the second identical failure within 60s must be suppressed');
  });

  it('hintForTelegramStatus covers the statuses an operator will meet', () => {
    assert.match(hintForTelegramStatus(400), /chat not found/);
    assert.match(hintForTelegramStatus(401), /KANBAN_TELEGRAM_BOT_TOKEN/);
    assert.match(hintForTelegramStatus(403), /admin/);
    assert.match(hintForTelegramStatus(404), /API_URL/);
    assert.match(hintForTelegramStatus(503), /outage/);
    assert.match(hintForTelegramStatus(418), /unexpected/);
    assert.equal(safeLogValue('a\nb'), '"ab"');
  });
});

describe('bug reports: Turnstile failure logging', () => {
  let saved = {};
  before(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('logs the Cloudflare error-codes array on success:false', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    const fetchImpl = makeFetch({
      turnstile: () =>
        fakeResponse(200, { success: false, 'error-codes': ['invalid-input-response', 'timeout-or-duplicate'] }),
    });
    const lines = await captureConsole(() =>
      withApp({ fetch: fetchImpl }, async (baseUrl) => {
        await jsonRequest(baseUrl, '/api/bug-reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: postBody(),
        });
      }),
    );
    const line = lines.warn.find((l) => l.includes('turnstile check failed'));
    assert.ok(line);
    assert.match(line, /success=false/);
    assert.match(line, /invalid-input-response/);
    assert.match(line, /timeout-or-duplicate/);
  });

  it('logs which check failed on an action mismatch, without the token', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    const fetchImpl = makeFetch({ turnstile: () => fakeResponse(200, okTurnstileBody({ action: 'login' })) });
    const lines = await captureConsole(() =>
      withApp({ fetch: fetchImpl }, async (baseUrl) => {
        await jsonRequest(baseUrl, '/api/bug-reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: postBody({ turnstileToken: 'super-secret-captcha-response' }),
        });
      }),
    );
    const line = lines.warn.find((l) => l.includes('turnstile check failed'));
    assert.ok(line);
    assert.match(line, /action mismatch/);
    assert.match(line, /login/);
    assert.doesNotMatch(line, /super-secret-captcha-response/);
  });

  it('logs the offending hostname on a hostname mismatch', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv({ TURNSTILE_HOSTNAMES: 'allowed.example.test' });
    const fetchImpl = makeFetch({
      turnstile: () => fakeResponse(200, okTurnstileBody({ hostname: 'evil.example.test' })),
    });
    const lines = await captureConsole(() =>
      withApp({ fetch: fetchImpl }, async (baseUrl) => {
        await jsonRequest(baseUrl, '/api/bug-reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: postBody(),
        });
      }),
    );
    const line = lines.warn.find((l) => l.includes('turnstile check failed'));
    assert.ok(line);
    assert.match(line, /hostname mismatch/);
    assert.match(line, /evil\.example\.test/);
  });

  it('strips control characters embedded in a Cloudflare error-code before logging', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    const fetchImpl = makeFetch({
      turnstile: () => fakeResponse(200, { success: false, 'error-codes': ['bad\ncode\rinjected'] }),
    });
    const lines = await captureConsole(() =>
      withApp({ fetch: fetchImpl }, async (baseUrl) => {
        await jsonRequest(baseUrl, '/api/bug-reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: postBody(),
        });
      }),
    );
    const line = lines.warn.find((l) => l.includes('turnstile check failed'));
    assert.ok(line);
    assert.doesNotMatch(line, /[\r\n]/);
    assert.match(line, /bad.*code.*injected/);
  });

  it('strips control characters embedded in the siteverify hostname before logging', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv({ TURNSTILE_HOSTNAMES: 'allowed.example.test' });
    const fetchImpl = makeFetch({
      turnstile: () => fakeResponse(200, okTurnstileBody({ hostname: 'evil\n.example.test\rinjected' })),
    });
    const lines = await captureConsole(() =>
      withApp({ fetch: fetchImpl }, async (baseUrl) => {
        await jsonRequest(baseUrl, '/api/bug-reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: postBody(),
        });
      }),
    );
    const line = lines.warn.find((l) => l.includes('turnstile check failed'));
    assert.ok(line);
    assert.doesNotMatch(line, /[\r\n]/);
  });

  it('strips control characters embedded in a mismatched action before logging', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    configureEnv();
    const fetchImpl = makeFetch({
      turnstile: () => fakeResponse(200, okTurnstileBody({ action: 'login\ninjected' })),
    });
    const lines = await captureConsole(() =>
      withApp({ fetch: fetchImpl }, async (baseUrl) => {
        await jsonRequest(baseUrl, '/api/bug-reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: postBody(),
        });
      }),
    );
    const line = lines.warn.find((l) => l.includes('turnstile check failed'));
    assert.ok(line);
    assert.doesNotMatch(line, /[\r\n]/);
  });
});

describe('bug reports: startup warnings', () => {
  let saved;
  before(() => {
    saved = saveEnv();
  });
  afterEach(() => restoreEnv(saved));

  it('looksLikeTurnstileSiteKey accepts an opaque key and rejects an obviously-wrong value', () => {
    assert.equal(looksLikeTurnstileSiteKey('1x00000000000000000000AA'), true);
    assert.equal(looksLikeTurnstileSiteKey('short'), false);
    assert.equal(looksLikeTurnstileSiteKey('has a space in it'), false);
    assert.equal(looksLikeTurnstileSiteKey(''), false);
  });

  it('Turnstile configured without KANBAN_TELEGRAM_BOT_TOKEN warns that the feature is disabled', async () => {
    clearEnv();
    configureEnv({ KANBAN_TELEGRAM_BOT_TOKEN: undefined });
    const lines = await captureConsole(() => withApp({ fetch: makeFetch() }, async () => {}));
    assert.ok(
      lines.warn.some((l) => l.includes('DISABLED') && l.includes('KANBAN_TELEGRAM_BOT_TOKEN is unset')),
      `expected a disabled warning, got: ${JSON.stringify(lines.warn)}`,
    );
  });

  it('Turnstile + bot but no chat id of either kind warns that the feature is disabled', async () => {
    clearEnv();
    configureEnv({ KANBAN_TELEGRAM_CHAT_ID: undefined });
    const lines = await captureConsole(() => withApp({ fetch: makeFetch() }, async () => {}));
    assert.ok(
      lines.warn.some((l) => l.includes('DISABLED') && l.includes('KANBAN_REPORT_TELEGRAM_CHAT_ID')),
      `expected a disabled warning, got: ${JSON.stringify(lines.warn)}`,
    );
    assert.ok(!allLines(lines).includes(DUMMY_BOT_TOKEN));
  });

  it('a fully configured feature emits no disabled warning', async () => {
    clearEnv();
    configureEnv({ TURNSTILE_HOSTNAMES: 'board.example.test' });
    const lines = await captureConsole(() => withApp({ fetch: makeFetch() }, async () => {}));
    assert.deepEqual(lines.warn, []);
  });

  it('a malformed TURNSTILE_SITE_KEY warns at startup; a real-shaped one does not', async () => {
    clearEnv();
    configureEnv({ TURNSTILE_SITE_KEY: 'x' });
    let lines = await captureConsole(() => withApp({ fetch: makeFetch() }, async () => {}));
    assert.ok(lines.warn.some((l) => l.includes('TURNSTILE_SITE_KEY does not look like')));

    clearEnv();
    configureEnv({ TURNSTILE_SITE_KEY: '1x00000000000000000000AA' });
    lines = await captureConsole(() => withApp({ fetch: makeFetch() }, async () => {}));
    assert.ok(!lines.warn.some((l) => l.includes('TURNSTILE_SITE_KEY does not look like')));
  });

  it('no warning fires when the feature is not wanted (no Turnstile keys), even with the bot configured for alerts', async () => {
    clearEnv();
    configureEnv({ TURNSTILE_SECRET: undefined, TURNSTILE_SITE_KEY: undefined });
    let lines = await captureConsole(() => withApp({ fetch: makeFetch() }, async () => {}));
    assert.deepEqual(lines.warn, []);
    clearEnv();
    lines = await captureConsole(() => withApp({ fetch: makeFetch() }, async () => {}));
    assert.deepEqual(lines.warn, []);
  });
});

// ---------------------------------------------------------------------
// Round 2 follow-ups: production guard for the local-only overrides,
// validation of exactly the cleaned text, and the shared 429 pause.
// ---------------------------------------------------------------------

describe('bug reports: local-only overrides are ignored in production', () => {
  let saved;
  before(() => {
    saved = saveEnv();
  });
  afterEach(() => restoreEnv(saved));

  async function assertOverridesIgnored(prodEnv) {
    clearEnv();
    configureEnv({
      KANBAN_ALLOWED_ORIGIN: 'https://board.example.test',
      KANBAN_REPORT_TELEGRAM_API_URL: 'http://127.0.0.1:3457/secret-stub-path',
      TURNSTILE_SITEVERIFY_URL: 'http://127.0.0.1:3457/turnstile/v0/siteverify',
      ...prodEnv,
    });
    const fetchImpl = makeFetch();
    const lines = await captureConsole(() =>
      withApp({ fetch: fetchImpl }, async (baseUrl) => {
        assert.equal((await post(baseUrl)).res.status, 201);
      }),
    );
    const verify = fetchImpl.calls.find((c) => c.url.includes('siteverify'));
    assert.equal(verify.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify', 'real siteverify is used');
    assert.equal(fetchImpl.telegram[0].url, `https://api.telegram.org/bot${DUMMY_BOT_TOKEN}/sendMessage`, 'real Bot API is used');
    for (const name of ['KANBAN_REPORT_TELEGRAM_API_URL', 'TURNSTILE_SITEVERIFY_URL']) {
      assert.ok(
        lines.warn.some((l) => l.includes(`${name} is set but IGNORED`)),
        `expected a startup warning naming ${name}, got ${JSON.stringify(lines.warn)}`,
      );
    }
    assert.ok(!allLines(lines).includes('127.0.0.1:3457'), 'the override value is never logged');
    assert.ok(!allLines(lines).includes('secret-stub-path'));
  }

  it('NODE_ENV=production: both overrides are ignored and named in a startup warning (never their values)', async () => {
    await assertOverridesIgnored({ NODE_ENV: 'production' });
  });

  it('RAILWAY_ENVIRONMENT set: both overrides are ignored and named', async () => {
    await assertOverridesIgnored({ RAILWAY_ENVIRONMENT: 'production' });
  });

  it('RAILWAY_PROJECT_ID set: both overrides are ignored and named', async () => {
    await assertOverridesIgnored({ RAILWAY_PROJECT_ID: '00000000-0000-0000-0000-000000000000' });
  });

  it('outside production the overrides are honoured and no warning fires', async () => {
    clearEnv();
    configureEnv({
      KANBAN_REPORT_TELEGRAM_API_URL: 'http://127.0.0.1:3457',
      TURNSTILE_SITEVERIFY_URL: 'http://127.0.0.1:3457/turnstile/v0/siteverify',
      TURNSTILE_HOSTNAMES: 'board.example.test',
    });
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(String(url));
      return String(url).endsWith('/siteverify') ? fakeResponse(200, okTurnstileBody()) : okTelegram();
    };
    const lines = await captureConsole(() =>
      withApp({ fetch: fetchImpl }, async (baseUrl) => {
        assert.equal((await post(baseUrl)).res.status, 201);
      }),
    );
    assert.equal(seen[0], 'http://127.0.0.1:3457/turnstile/v0/siteverify');
    assert.equal(seen[1], `http://127.0.0.1:3457/bot${DUMMY_BOT_TOKEN}/sendMessage`);
    assert.deepEqual(lines.warn, []);
    assert.deepEqual(ignoredLocalOverrides(), []);
  });

  it('isProductionRuntime / turnstileSiteverifyUrl / reportTelegramTarget follow the guard', () => {
    assert.equal(isProductionRuntime({}), false);
    assert.equal(isProductionRuntime({ NODE_ENV: 'development' }), false);
    assert.equal(isProductionRuntime({ NODE_ENV: 'production' }), true);
    assert.equal(isProductionRuntime({ RAILWAY_ENVIRONMENT: 'staging' }), true);
    assert.equal(isProductionRuntime({ RAILWAY_PROJECT_ID: 'x' }), true);
    const before = saveEnv();
    try {
      clearEnv();
      process.env.TURNSTILE_SITEVERIFY_URL = 'http://127.0.0.1:1/sv';
      process.env.KANBAN_REPORT_TELEGRAM_API_URL = 'http://127.0.0.1:1';
      assert.equal(turnstileSiteverifyUrl(), 'http://127.0.0.1:1/sv');
      assert.equal(reportTelegramTarget().apiUrl, 'http://127.0.0.1:1');
      process.env.NODE_ENV = 'production';
      assert.equal(turnstileSiteverifyUrl(), 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      assert.equal(reportTelegramTarget().apiUrl, 'https://api.telegram.org');
      assert.deepEqual(ignoredLocalOverrides(), ['KANBAN_REPORT_TELEGRAM_API_URL', 'TURNSTILE_SITEVERIFY_URL']);
    } finally {
      restoreEnv(before);
    }
  });
});

describe('bug reports: validation sees exactly the cleaned text', () => {
  let saved;
  before(() => {
    saved = saveEnv();
    clearEnv();
    configureEnv({ KANBAN_REPORT_PER_IP_PER_HOUR: '100', KANBAN_REPORT_DAILY_CAP: '100' });
  });
  after(() => restoreEnv(saved));

  it('a title made only of RIGHT-TO-LEFT OVERRIDE characters is rejected as empty (400 invalid_title), nothing sent', async () => {
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl, { title: '\u202E\u202E\u202E' });
      assert.equal(res.res.status, 400);
      assert.equal(res.body.error, 'invalid_title');
    });
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('a title made only of zero-width / BOM / LRM / RLM / ALM characters is rejected as empty', async () => {
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl, { title: '\u200B‌‍⁠﻿\u200E\u200F؜' });
      assert.equal(res.res.status, 400);
      assert.equal(res.body.error, 'invalid_title');
    });
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('a description that is only invisible characters (well over 10 code units) is rejected (400 invalid_description)', async () => {
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl, { description: '\u200B\u202E﻿\u2028\u0085'.repeat(10) + 'short' });
      assert.equal(res.res.status, 400);
      assert.equal(res.body.error, 'invalid_description');
    });
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('length limits count visible characters: 120 visible + invisible padding is accepted and sent clean', async () => {
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(baseUrl, { title: 'x'.repeat(120) + '\u200B'.repeat(10) });
      assert.equal(res.res.status, 201);
    });
    assert.ok(fetchImpl.telegram[0].body.text.includes(`<b>${'x'.repeat(120)}</b>`));
  });

  it('what is rendered never contains LRM/RLM/ALM, zero-width, word joiner or BOM in the title or user agent', async () => {
    const fetchImpl = makeFetch();
    await withApp({ fetch: fetchImpl }, async (baseUrl) => {
      const res = await post(
        baseUrl,
        { title: 'Hid\u200Bden\u200E \u200Ftitle⁠﻿؜ here' },
        { 'User-Agent': 'UA/1.0' },
      );
      assert.equal(res.res.status, 201);
    });
    const text = fetchImpl.telegram[0].body.text;
    assert.ok(text.includes('<b>Hidden title here</b>'));
    assert.doesNotMatch(text.replace(/@\u200B|:\u200B\/\//g, ''), /[\u200B‌\u200E\u200F⁠﻿؜]/);
  });

  it('emoji ZWJ sequences survive; a stray ZWJ between letters is removed', () => {
    const technologist = '\u{1F469}\u{1F3FD}‍\u{1F4BB}';
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    assert.equal(cleanOneLine(`${technologist} and ${family}`), `${technologist} and ${family}`);
    assert.equal(cleanOneLine('a‍b'), 'ab');
    assert.equal(cleanOneLine('‍\u{1F4BB}'), '\u{1F4BB}', 'a leading ZWJ glues nothing');
    const text = formatReportMessage({ title: 'x', description: 'desc text here', userAgent: 'U\u200EA\u200B' });
    assert.ok(text.includes('<i>UA: UA</i>'));
  });
});

describe('bug reports: shared 429 pause', () => {
  let saved;
  before(() => {
    saved = saveEnv();
  });
  afterEach(() => restoreEnv(saved));

  it('a 429 pauses report sends: the next report fails fast with NO Telegram call and does not spend the budget', async () => {
    clearEnv();
    configureEnv({ KANBAN_REPORT_DAILY_CAP: '1', KANBAN_REPORT_PER_IP_PER_HOUR: '1' });
    let clock = 5_000_000;
    let throttled = true;
    const fetchImpl = makeFetch({
      telegram: () =>
        throttled ? telegramError(429, 'Too Many Requests', { parameters: { retry_after: 30 } }) : okTelegram(),
    });
    const lines = await captureConsole(() =>
      withApp({ fetch: fetchImpl, now: () => clock }, async (baseUrl) => {
        const first = await post(baseUrl);
        assert.equal(first.res.status, 502);
        assert.equal(fetchImpl.telegram.length, 1, 'retry_after 30 > 10: no in-request retry');
        assert.equal(telegramPausedUntil(), clock + 30_000);

        throttled = false;
        clock += 29_000; // still inside the pause
        const paused = await post(baseUrl);
        assert.equal(paused.res.status, 502);
        assert.equal(paused.body.error, 'could_not_send');
        assert.equal(fetchImpl.telegram.length, 1, 'no outbound call while paused');

        clock += 2_000; // pause over
        const ok = await post(baseUrl);
        assert.equal(ok.res.status, 201, 'neither failure spent the budget of 1');
        assert.equal(fetchImpl.telegram.length, 2);
      }),
    );
    const pausedLine = lines.error.find((l) => l.includes('paused (recent 429, no call made)'));
    assert.ok(pausedLine, JSON.stringify(lines.error));
    assert.ok(!allLines(lines).includes(DUMMY_BOT_TOKEN));
  });

  it('the pause is capped at 60s however large retry_after is', async () => {
    clearEnv();
    configureEnv();
    const clock = 7_000_000;
    const fetchImpl = makeFetch({
      telegram: () => telegramError(429, 'Too Many Requests', { parameters: { retry_after: 3600 } }),
    });
    await withApp({ fetch: fetchImpl, now: () => clock }, async (baseUrl) => {
      assert.equal((await post(baseUrl)).res.status, 502);
    });
    assert.equal(telegramPausedUntil(), clock + 60_000);
  });

  it('sendTelegramMessage refuses to call fetch while paused and resumes after the window', async () => {
    let clock = 1_000;
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return calls === 1 ? telegramError(429, 'slow down', { parameters: { retry_after: 20 } }) : okTelegram();
    };
    const first = await sendTelegramMessage({ botToken: DUMMY_BOT_TOKEN, chatId: '1', text: 'x', fetchImpl, now: () => clock, sleep: async () => {} });
    assert.equal(first.ok, false);
    assert.equal(first.status, 429);
    const blocked = await sendTelegramMessage({ botToken: DUMMY_BOT_TOKEN, chatId: '1', text: 'x', fetchImpl, now: () => clock });
    assert.equal(blocked.paused, true);
    assert.equal(blocked.attempts, 0);
    assert.equal(calls, 1);
    clock += 20_000;
    const resumed = await sendTelegramMessage({ botToken: DUMMY_BOT_TOKEN, chatId: '1', text: 'x', fetchImpl, now: () => clock });
    assert.equal(resumed.ok, true);
    assert.equal(calls, 2);
  });
});
