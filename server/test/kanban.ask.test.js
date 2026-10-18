/**
 * Ask-the-Board (v3.4.0) — end-to-end over real HTTP (createApp + an injected
 * fake `fetch`, an injected `env`, and an injected store; never the network).
 *
 * Covers the fail-closed feature gate, the password gate + wrong-password
 * backoff, question validation, the happy path (asserting the OpenRouter
 * request carries the configured model AND a system prompt), upstream failure
 * mapping (502/503), the per-IP/daily rate limits (counted only on success),
 * and the guarantee that no secret ever reaches a response body.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { ASK_REPO_URL, GUARDRAIL_INSTRUCTION, readSourceExcerpt, readSourceFile, rankSourceFiles, gatherSourceContext, excerptWindow, gatherSnapshot, formatSnapshot } from '../askKnowledge.js';
import { hintForUpstreamStatus, looksLikeOpenRouterKey } from '../routes/ask.js';

/** Collects log lines instead of printing them, so a test that simulates a
 *  failure can assert on the output rather than scribbling on the run. */
function fakeLogger() {
  const lines = [];
  return { lines, warn: (l) => lines.push(String(l)), error: (l) => lines.push(String(l)) };
}

const FAKE_KEY = 'sk-or-v1-test-key-DO-NOT-LEAK';
const FAKE_PASSWORD = 'test-password-DO-NOT-LEAK';
const DEFAULT_MODEL = 'openai/gpt-oss-20b';
const OPENROUTER_URL_FOR_TEST = 'https://openrouter.ai/api/v1/chat/completions';

/** A fully-enabled environment; overrides patch or clear a key. */
function baseEnv(overrides = {}) {
  return {
    KANBAN_ASK_OPENROUTER_API_KEY: FAKE_KEY,
    KANBAN_ASK_PASSWORD: FAKE_PASSWORD,
    ...overrides,
  };
}

function fakeStore(tasks = []) {
  return {
    getTasks: () => tasks,
    isStoreLoaded: () => true,
    isReaperEnabled: () => true,
    isReaperRunning: () => true,
  };
}

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null },
  };
}

function okAnswerBody(content = 'The reaper resets a reclaimed card to READY.') {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

/**
 * An injectable fetch that only answers OpenRouter. `handler(callCount, opts)`
 * scripts per-call behaviour; every call is recorded in `.calls`. A thrown
 * Error simulates a network/abort failure.
 */
function makeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    assert.ok(String(url).includes('openrouter.ai'), `unexpected fetch url: ${url}`);
    calls.push({ url: String(url), opts });
    if (!handler) return fakeResponse(200, okAnswerBody());
    const out = handler(calls.length, opts);
    if (out instanceof Error) throw out;
    return out;
  };
  fn.calls = calls;
  return fn;
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

async function withApp(askDeps, fn) {
  const app = createApp({ ask: askDeps });
  const { server, baseUrl } = await startTestServer(app);
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function askRequest(overrides = {}) {
  const { pass = FAKE_PASSWORD, body, headers = {}, ...rest } = overrides;
  const h = { 'Content-Type': 'application/json', ...headers };
  if (pass !== null) h['x-ask-pass'] = pass;
  return {
    method: 'POST',
    headers: h,
    body: body === undefined ? JSON.stringify({ question: 'How does the reaper reclaim a card?' }) : body,
    ...rest,
  };
}

describe('ask: feature gate', () => {
  it('is off when the API key is missing: config reports disabled, POST 404s', async () => {
    await withApp({ env: baseEnv({ KANBAN_ASK_OPENROUTER_API_KEY: undefined }), fetch: makeFetch() }, async (baseUrl) => {
      const cfg = await jsonRequest(baseUrl, '/api/ask/config');
      assert.equal(cfg.res.status, 200);
      assert.deepEqual(cfg.body, { enabled: false });

      const post = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(post.res.status, 404);
      assert.equal(post.body.error, 'not_found');
    });
  });

  it('is off when the password is missing: config reports disabled, POST 404s', async () => {
    await withApp({ env: baseEnv({ KANBAN_ASK_PASSWORD: undefined }), fetch: makeFetch() }, async (baseUrl) => {
      const cfg = await jsonRequest(baseUrl, '/api/ask/config');
      assert.deepEqual(cfg.body, { enabled: false });
      const post = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(post.res.status, 404);
    });
  });

  it('is on when both are present; config never leaks the key or password', async () => {
    await withApp({ env: baseEnv(), fetch: makeFetch(), store: fakeStore() }, async (baseUrl) => {
      const cfg = await jsonRequest(baseUrl, '/api/ask/config');
      assert.equal(cfg.res.status, 200);
      assert.deepEqual(cfg.body, { enabled: true, gated: true, model: DEFAULT_MODEL });
      const raw = JSON.stringify(cfg.body);
      assert.doesNotMatch(raw, new RegExp(FAKE_KEY));
      assert.doesNotMatch(raw, new RegExp(FAKE_PASSWORD));
    });
  });

  it('config reports the configured model when overridden', async () => {
    await withApp(
      { env: baseEnv({ KANBAN_ASK_MODEL: 'anthropic/claude-3.5-haiku' }), fetch: makeFetch(), store: fakeStore() },
      async (baseUrl) => {
        const cfg = await jsonRequest(baseUrl, '/api/ask/config');
        assert.equal(cfg.body.model, 'anthropic/claude-3.5-haiku');
      },
    );
  });
});

describe('ask: password gate', () => {
  it('a missing x-ask-pass header is 401 invalid_pass and never calls upstream', async () => {
    const fetchImpl = makeFetch();
    await withApp({ env: baseEnv(), fetch: fetchImpl, store: fakeStore() }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/ask', askRequest({ pass: null }));
      assert.equal(res.res.status, 401);
      assert.deepEqual(res.body, { error: 'invalid_pass' });
      assert.equal(fetchImpl.calls.length, 0);
    });
  });

  it('a wrong x-ask-pass header is 401 invalid_pass and never calls upstream', async () => {
    const fetchImpl = makeFetch();
    await withApp({ env: baseEnv(), fetch: fetchImpl, store: fakeStore() }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/ask', askRequest({ pass: 'nope' }));
      assert.equal(res.res.status, 401);
      assert.deepEqual(res.body, { error: 'invalid_pass' });
      assert.equal(fetchImpl.calls.length, 0);
    });
  });
});

describe('ask: question validation', () => {
  it('a non-string question is 400 invalid_question', async () => {
    await withApp({ env: baseEnv(), fetch: makeFetch(), store: fakeStore() }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/ask', askRequest({ body: JSON.stringify({ question: 42 }) }));
      assert.equal(res.res.status, 400);
      assert.equal(res.body.error, 'invalid_question');
    });
  });

  it('a question shorter than 3 chars is 400 invalid_question', async () => {
    await withApp({ env: baseEnv(), fetch: makeFetch(), store: fakeStore() }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/ask', askRequest({ body: JSON.stringify({ question: 'hi' }) }));
      assert.equal(res.res.status, 400);
      assert.equal(res.body.error, 'invalid_question');
    });
  });

  it('a question longer than 500 chars is 400 invalid_question', async () => {
    await withApp({ env: baseEnv(), fetch: makeFetch(), store: fakeStore() }, async (baseUrl) => {
      const res = await jsonRequest(
        baseUrl,
        '/api/ask',
        askRequest({ body: JSON.stringify({ question: 'x'.repeat(501) }) }),
      );
      assert.equal(res.res.status, 400);
      assert.equal(res.body.error, 'invalid_question');
    });
  });
});

describe('ask: source-code retrieval', () => {
  it('rankSourceFiles finds server/store.js for the reaper question', () => {
    const files = rankSourceFiles('how does the reaper reclaim a stalled card').map((f) => f.path);
    assert.ok(files.includes('server/store.js'), `expected server/store.js, got ${JSON.stringify(files)}`);
  });

  it('gatherSourceContext returns verbatim excerpts with real store symbols', () => {
    const ctx = gatherSourceContext('how does the reaper reclaim a stalled card');
    assert.ok(ctx.files.includes('server/store.js'), `expected server/store.js, got ${JSON.stringify(ctx.files)}`);
    // The window must reach the reaper body (~92k into server/store.js), not just the head.
    assert.match(ctx.text, /reapExpiredClaims/);
  });

  it('rankSourceFiles finds a file by a precise symbol name absent from the map note', () => {
    const files = rankSourceFiles('what does renewAllLeasesInner do').map((f) => f.path);
    assert.ok(files.includes('server/store.js'), `expected server/store.js, got ${JSON.stringify(files)}`);
  });

  it('gatherSourceContext reaches a symbol found only in file contents', () => {
    const ctx = gatherSourceContext('what does renewAllLeasesInner do');
    assert.ok(ctx.files.includes('server/store.js'), `expected server/store.js, got ${JSON.stringify(ctx.files)}`);
    assert.match(ctx.text, /renewAllLeasesInner/);
  });

  it('gatherSourceContext window reaches the concurrency lock for a mutex question', () => {
    const ctx = gatherSourceContext('how does the mutex serialise writes');
    assert.ok(ctx.files.includes('server/store.js'), `expected server/store.js, got ${JSON.stringify(ctx.files)}`);
    assert.match(ctx.text, /withMutationLock/);
  });

  it('an off-topic question selects nothing', () => {
    const ctx = gatherSourceContext('what is the weather tomorrow');
    assert.equal(ctx.text, '');
    assert.deepEqual(rankSourceFiles('what is the weather tomorrow'), []);
  });

  it('excerptWindow falls back to the file head when the question has no keyword hits', () => {
    assert.equal(excerptWindow('line1\nline2', 'weather'), 'line1\nline2');
  });

  it('readSourceFile returns the full text (store.js) and null for a missing file', () => {
    const text = readSourceFile('server/store.js');
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 1000, `expected a long string, got ${text && text.length}`);
    assert.match(text, /withMutationLock/);
    assert.equal(readSourceFile('nope-xyz.js'), null);
  });

  it('readSourceExcerpt returns null for a missing file', () => {
    assert.equal(readSourceExcerpt('server/does-not-exist-xyz.js'), null);
  });
});

describe('ask: happy path', () => {
  it('returns 200 { answer, model } and sends the model plus a system guardrail message', async () => {
    const fetchImpl = makeFetch();
    await withApp({ env: baseEnv(), fetch: fetchImpl, store: fakeStore() }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(res.res.status, 200);
      assert.equal(res.body.answer, 'The reaper resets a reclaimed card to READY.');
      assert.equal(res.body.model, DEFAULT_MODEL);

      assert.equal(fetchImpl.calls.length, 1);
      const sent = JSON.parse(fetchImpl.calls[0].opts.body);
      assert.equal(sent.model, DEFAULT_MODEL);
      assert.equal(sent.temperature, 0.2);
      assert.equal(sent.messages[0].role, 'system');
      assert.equal(sent.messages[1].role, 'user');
      assert.equal(sent.messages[1].content, 'How does the reaper reclaim a card?');
      // The guardrail + repo pointer are actually present in the system prompt.
      assert.match(sent.messages[0].content, /SCOPE/);
      assert.match(sent.messages[0].content, new RegExp(ASK_REPO_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      // The retrieved source excerpts are injected verbatim for code questions.
      assert.match(sent.messages[0].content, /SOURCE-CODE EXCERPTS/);
      assert.match(sent.messages[0].content, /store\.js \(excerpt\)/);
      // The Authorization header carries the key — but only upstream, never back.
      assert.equal(fetchImpl.calls[0].opts.headers.Authorization, `Bearer ${FAKE_KEY}`);
    });
  });

  it('honours the configured model in the upstream request', async () => {
    const fetchImpl = makeFetch();
    await withApp(
      { env: baseEnv({ KANBAN_ASK_MODEL: 'google/gemini-flash-1.5' }), fetch: fetchImpl, store: fakeStore() },
      async (baseUrl) => {
        const res = await jsonRequest(baseUrl, '/api/ask', askRequest());
        assert.equal(res.body.model, 'google/gemini-flash-1.5');
        assert.equal(JSON.parse(fetchImpl.calls[0].opts.body).model, 'google/gemini-flash-1.5');
      },
    );
  });

  it('an empty completion is treated as a gateway error', async () => {
    const fetchImpl = makeFetch(() => fakeResponse(200, { choices: [{ message: { content: '   ' } }] }));
    await withApp({ env: baseEnv(), fetch: fetchImpl, store: fakeStore() }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(res.res.status, 502);
      assert.equal(res.body.error, 'gateway_error');
    });
  });

  it('the live snapshot is included in the system prompt', async () => {
    const fetchImpl = makeFetch();
    const tasks = [
      { id: 'a', status: 'DONE', project: 'default' },
      { id: 'b', status: 'IN_PROGRESS', project: 'default' },
    ];
    await withApp({ env: baseEnv(), fetch: fetchImpl, store: fakeStore(tasks) }, async (baseUrl) => {
      await jsonRequest(baseUrl, '/api/ask', askRequest());
      const sent = JSON.parse(fetchImpl.calls[0].opts.body);
      assert.match(sent.messages[0].content, /LIVE BOARD SNAPSHOT/);
      assert.match(sent.messages[0].content, /cards: 2 total/);
    });
  });

  it('marks the response fallback:true when the live snapshot cannot be read', async () => {
    const fetchImpl = makeFetch();
    // An injected store with no getTasks() makes gatherSnapshot return { available: false }.
    await withApp({ env: baseEnv(), fetch: fetchImpl, store: {} }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(res.res.status, 200);
      assert.equal(res.body.answer, 'The reaper resets a reclaimed card to READY.');
      assert.equal(res.body.model, DEFAULT_MODEL);
      assert.equal(res.body.fallback, true);
      assert.match(JSON.parse(fetchImpl.calls[0].opts.body).messages[0].content, /snapshot: unavailable|unavailable right now/i);
    });
  });
});

describe('ask: upstream failures', () => {
  it('a non-2xx upstream is 502 gateway_error with no upstream body leaked', async () => {
    const fetchImpl = makeFetch(() => fakeResponse(500, { error: `internal ${FAKE_KEY}` }));
    await withApp({ env: baseEnv(), fetch: fetchImpl, store: fakeStore() }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(res.res.status, 502);
      assert.equal(res.body.error, 'gateway_error');
      assert.doesNotMatch(JSON.stringify(res.body), new RegExp(FAKE_KEY));
    });
  });

  it('an abort/timeout is 503 timeout', async () => {
    const fetchImpl = makeFetch(() => Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    await withApp({ env: baseEnv(), fetch: fetchImpl, store: fakeStore() }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(res.res.status, 503);
      assert.equal(res.body.error, 'timeout');
    });
  });

  it('a network error is 502 gateway_error', async () => {
    const fetchImpl = makeFetch(() => new Error('ECONNRESET'));
    await withApp({ env: baseEnv(), fetch: fetchImpl, store: fakeStore() }, async (baseUrl) => {
      const res = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(res.res.status, 502);
      assert.equal(res.body.error, 'gateway_error');
    });
  });
});

describe('ask: rate limits', () => {
  it('enforces the per-IP hourly cap (429 after the limit)', async () => {
    const fetchImpl = makeFetch();
    const env = baseEnv({ KANBAN_ASK_PER_IP_PER_HOUR: '2', KANBAN_ASK_DAILY_CAP: '100' });
    await withApp({ env, fetch: fetchImpl, store: fakeStore() }, async (baseUrl) => {
      const statuses = [];
      for (let i = 0; i < 3; i++) {
        statuses.push((await jsonRequest(baseUrl, '/api/ask', askRequest())).res.status);
      }
      assert.deepEqual(statuses, [200, 200, 429]);
      const third = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(third.body.error, 'ip_limit_reached');
      assert.ok(Number.isFinite(third.body.retry_after_ms) && third.body.retry_after_ms > 0);
      assert.ok(third.res.headers.get('retry-after'));
    });
  });

  it('enforces the global daily cap', async () => {
    const fetchImpl = makeFetch();
    const env = baseEnv({ KANBAN_ASK_PER_IP_PER_HOUR: '100', KANBAN_ASK_DAILY_CAP: '1' });
    await withApp({ env, fetch: fetchImpl, store: fakeStore() }, async (baseUrl) => {
      const first = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(first.res.status, 200);
      const second = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(second.res.status, 429);
      assert.equal(second.body.error, 'daily_cap_reached');
    });
  });

  it('a failed answer does not spend the cap (only success consumes)', async () => {
    const fetchImpl = makeFetch((n) =>
      n === 1 ? fakeResponse(500, { error: 'down' }) : fakeResponse(200, okAnswerBody()),
    );
    const env = baseEnv({ KANBAN_ASK_PER_IP_PER_HOUR: '100', KANBAN_ASK_DAILY_CAP: '1' });
    await withApp({ env, fetch: fetchImpl, store: fakeStore() }, async (baseUrl) => {
      const failed = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(failed.res.status, 502);
      const succeeded = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(succeeded.res.status, 200, 'the cap of 1 must still be available after a failure');
    });
  });

  it('a wrong-password burst is throttled: 401 up to the limit, then 429 too_many_attempts (backoff)', async () => {
    const fetchImpl = makeFetch();
    const env = baseEnv({ KANBAN_AUTH_RATE_LIMIT_PER_MIN: '2' });
    await withApp({ env, fetch: fetchImpl, store: fakeStore() }, async (baseUrl) => {
      // The first `N` attempts (N = the configured auth limit of 2) are generic 401s.
      const first = await jsonRequest(baseUrl, '/api/ask', askRequest({ pass: 'wrong' }));
      const second = await jsonRequest(baseUrl, '/api/ask', askRequest({ pass: 'wrong' }));
      assert.equal(first.res.status, 401);
      assert.equal(first.body.error, 'invalid_pass');
      assert.equal(second.res.status, 401);
      assert.equal(second.body.error, 'invalid_pass');

      // The next attempt exceeds the per-IP limit and is throttled.
      const third = await jsonRequest(baseUrl, '/api/ask', askRequest({ pass: 'wrong' }));
      assert.equal(third.res.status, 429);
      assert.equal(third.body.error, 'too_many_attempts');
      assert.ok(Number.isFinite(third.body.retry_after_ms) && third.body.retry_after_ms > 0);
      assert.ok(third.res.headers.get('retry-after'), 'over-limit wrong-password attempts set Retry-After');

      assert.equal(fetchImpl.calls.length, 0, 'a guessing burst must never spend OpenRouter quota');
    });
  });
});

describe('ask: no secrets in responses', () => {
  it('never returns the key or the password in any body', async () => {
    const fetchImpl = makeFetch(() => fakeResponse(500, { error: `${FAKE_KEY} ${FAKE_PASSWORD}` }));
    await withApp({ env: baseEnv(), fetch: fetchImpl, store: fakeStore() }, async (baseUrl) => {
      for (const req of [askRequest(), askRequest({ pass: 'wrong' }), askRequest({ body: JSON.stringify({ question: '' }) })]) {
        const res = await jsonRequest(baseUrl, '/api/ask', req);
        const raw = JSON.stringify(res.body);
        assert.doesNotMatch(raw, new RegExp(FAKE_KEY));
        assert.doesNotMatch(raw, new RegExp(FAKE_PASSWORD));
      }
      const cfg = await jsonRequest(baseUrl, '/api/ask/config');
      assert.doesNotMatch(JSON.stringify(cfg.body), new RegExp(FAKE_KEY));
      assert.doesNotMatch(JSON.stringify(cfg.body), new RegExp(FAKE_PASSWORD));
    });
  });
});

// ---------------------------------------------------------------------------
// Failure diagnostics (v3.6.1)
//
// Until v3.6.1 this path logged NOTHING on an upstream failure, so a dead key,
// an exhausted balance and a real outage were indistinguishable from each
// other — and from a working feature — in the deploy log. The client maps both
// 502 and 503 to one message, so the UI cannot tell them apart either.
// ---------------------------------------------------------------------------

describe('ask: the outgoing request must actually be sendable', () => {
  // THE GAP THAT LET THE BUG SHIP. Every other test here injects a fake
  // `fetch`, which happily accepts any object as `headers` — so a header value
  // that the real platform rejects sails through all of them. Ask-the-Board
  // was broken in production from v3.4.0 to v3.6.3 by an em dash in X-Title,
  // with 600+ passing tests, because nothing ever ran the real validator.
  //
  // These assertions take the headers the route ACTUALLY built (recorded by
  // the fake fetch) and push them through the platform's own `Headers` and
  // `Request` constructors, which perform the ByteString check without any
  // network access.
  it('builds headers the platform will accept (no character above 255)', async () => {
    const fetchImpl = makeFetch(() => fakeResponse(200, okAnswerBody()));
    await withApp({ env: baseEnv(), store: fakeStore(), fetch: fetchImpl }, async (baseUrl) => {
      const { res } = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(res.status, 200);
    });
    const { opts } = fetchImpl.calls[0];

    for (const [name, value] of Object.entries(opts.headers)) {
      const offending = [...String(value)].findIndex((ch) => ch.codePointAt(0) > 255);
      assert.equal(
        offending,
        -1,
        `header ${name} carries a non-ByteString character at index ${offending}: ` +
          `${JSON.stringify([...String(value)][offending] ?? '')} — an em dash or smart quote ` +
          'here makes fetch throw before the request is sent',
      );
    }

    // The real validator, not our own loop: this is what actually threw.
    assert.doesNotThrow(() => new Headers(opts.headers), 'Headers must accept what the route built');
    assert.doesNotThrow(
      () => new Request(OPENROUTER_URL_FOR_TEST, { method: 'POST', headers: opts.headers, body: opts.body }),
      'the whole request must be constructible',
    );
  });
});

describe('ask: upstream failure diagnostics', () => {
  it('maps each upstream status to an operator-actionable hint', () => {
    assert.match(hintForUpstreamStatus(401), /invalid, revoked or a placeholder/);
    assert.match(hintForUpstreamStatus(402), /credit exhausted/i);
    assert.match(hintForUpstreamStatus(404), /not found/i);
    assert.match(hintForUpstreamStatus(429), /rate limit/i);
    assert.match(hintForUpstreamStatus(400), /KANBAN_ASK_MAX_PROMPT_TOKENS/);
    assert.match(hintForUpstreamStatus(500), /outage/i);
  });

  it('recognises an OpenRouter key by shape, so a placeholder is caught at boot', () => {
    assert.equal(looksLikeOpenRouterKey('sk-or-v1-0123456789abcdef0123'), true);
    assert.equal(looksLikeOpenRouterKey('changeme'), false);
    assert.equal(looksLikeOpenRouterKey('ghp_not_an_openrouter_key'), false);
    assert.equal(looksLikeOpenRouterKey(''), false);
    assert.equal(looksLikeOpenRouterKey(undefined), false);
  });

  it('warns at boot when the configured key does not look like one', () => {
    const logger = fakeLogger();
    createApp({ ask: { env: baseEnv({ KANBAN_ASK_OPENROUTER_API_KEY: 'placeholder' }), logger } });
    assert.ok(
      logger.lines.some((l) => /KANBAN_ASK_OPENROUTER_API_KEY does not look like/.test(l)),
      `expected a placeholder warning, got: ${JSON.stringify(logger.lines)}`,
    );
  });

  it('does not warn at boot when the key has the right shape', () => {
    const logger = fakeLogger();
    createApp({ ask: { env: baseEnv(), logger } });
    assert.deepEqual(logger.lines, []);
  });

  it('logs the upstream STATUS and its hint on a failure, and never a secret', async () => {
    const logger = fakeLogger();
    const fetchImpl = makeFetch(() => fakeResponse(401, { error: { message: 'No auth credentials found' } }));
    await withApp({ env: baseEnv(), store: fakeStore(), fetch: fetchImpl, logger }, async (baseUrl) => {
      const { res } = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(res.status, 502);
    });
    const line = logger.lines.find((l) => l.includes('request failed'));
    assert.ok(line, `expected a failure line, got: ${JSON.stringify(logger.lines)}`);
    assert.match(line, /401/);
    assert.match(line, /invalid, revoked or a placeholder/);
    assert.match(line, /model=openai\/gpt-oss-20b/);
    // The whole point of the original "log nothing" rule was secret safety;
    // that guarantee has to survive the new logging.
    assert.ok(!line.includes(FAKE_KEY), 'the API key must never reach the log');
    assert.ok(!line.includes(FAKE_PASSWORD), 'the password must never reach the log');
  });

  it('logs the errno behind a transport failure, not just "TypeError"', async () => {
    // What `fetch` throws on a transport failure is a bare TypeError; the only
    // useful part is its cause. v3.6.1 logged the NAME, which produced the
    // word "TypeError" and narrowed nothing — DNS failure, refused connection
    // and an unreachable network are indistinguishable from it.
    const logger = fakeLogger();
    const err = new TypeError('fetch failed');
    err.cause = Object.assign(new Error('getaddrinfo ENOTFOUND openrouter.ai'), {
      code: 'ENOTFOUND',
      hostname: 'openrouter.ai',
    });
    const fetchImpl = makeFetch(() => err);
    await withApp({ env: baseEnv(), store: fakeStore(), fetch: fetchImpl, logger }, async (baseUrl) => {
      const { res } = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(res.status, 502);
    });
    const line = logger.lines.find((l) => l.includes('request failed'));
    assert.ok(line, 'a transport failure must be logged');
    assert.match(line, /ENOTFOUND/, 'the errno is the whole point of the line');
    assert.match(line, /host=openrouter\.ai/);
    assert.ok(!line.includes(FAKE_KEY) && !line.includes(FAKE_PASSWORD));
  });

  it('distinguishes a timeout from a gateway error in the log', async () => {
    const logger = fakeLogger();
    const abort = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const fetchImpl = makeFetch(() => abort);
    await withApp({ env: baseEnv(), store: fakeStore(), fetch: fetchImpl, logger }, async (baseUrl) => {
      const { res } = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(res.status, 503);
    });
    const line = logger.lines.find((l) => l.includes('request failed'));
    assert.ok(line, 'a timeout must be logged');
    assert.match(line, /timed out after \d+ms/);
    assert.match(line, /KANBAN_ASK_TIMEOUT_MS=/);
  });

  it('reports a 200 that carries no answer, instead of failing silently', async () => {
    const logger = fakeLogger();
    const fetchImpl = makeFetch(() =>
      fakeResponse(200, { choices: [{ finish_reason: 'length', message: { content: '' } }] }),
    );
    await withApp({ env: baseEnv(), store: fakeStore(), fetch: fetchImpl, logger }, async (baseUrl) => {
      const { res } = await jsonRequest(baseUrl, '/api/ask', askRequest());
      assert.equal(res.status, 502);
    });
    const line = logger.lines.find((l) => l.includes('request failed'));
    assert.ok(line, 'an empty 200 must be logged');
    assert.match(line, /empty answer/);
    assert.match(line, /length/);
  });

  it('de-duplicates repeated failures of the same kind, so an outage cannot fill the log', async () => {
    const logger = fakeLogger();
    let t = 1_000_000;
    const fetchImpl = makeFetch(() => fakeResponse(503, {}));
    await withApp(
      { env: baseEnv(), store: fakeStore(), fetch: fetchImpl, logger, now: () => t },
      async (baseUrl) => {
        for (let i = 0; i < 4; i += 1) {
          await jsonRequest(baseUrl, '/api/ask', askRequest());
        }
        const within = logger.lines.filter((l) => l.includes('request failed')).length;
        assert.equal(within, 1, 'four identical failures inside the window log once');
        t += 61_000; // past LOG_WINDOW_MS
        await jsonRequest(baseUrl, '/api/ask', askRequest());
        const after = logger.lines.filter((l) => l.includes('request failed')).length;
        assert.equal(after, 2, 'the next window logs again');
      },
    );
  });
});

describe('ask: snapshot project activity enrichment', () => {
  it('gatherSnapshot breaks down states and collects recent tasks per project', () => {
    const tasks = [
      { id: 't1', title: 'Setup auth', status: 'DONE', project: 'kanbann', updated: '2026-10-18T10:00:00Z' },
      { id: 't2', title: 'Implement SSE diff', status: 'IN_PROGRESS', project: 'kanbann', assigned_agent: 'builder-1', updated: '2026-10-18T10:05:00Z' },
      { id: 't3', title: 'Backlog item', status: 'BACKLOG', project: 'kanbann', updated: '2026-10-18T09:00:00Z' },
      { id: 't4', title: 'Blocked item', status: 'BLOCKED', project: 'kanbann', updated: '2026-10-18T08:00:00Z' },
      { id: 'tv1', title: 'AliExpress hardware docs', status: 'DONE', project: 'TokenTV', updated: '2026-10-18T10:10:00Z' },
    ];
    const snap = gatherSnapshot(fakeStore(tasks));
    assert.equal(snap.available, true);
    assert.equal(snap.by_project.kanbann.total, 4);
    assert.equal(snap.by_project.kanbann.done, 1);
    assert.equal(snap.by_project.kanbann.active, 1);
    assert.equal(snap.by_project.kanbann.backlog, 1);
    assert.equal(snap.by_project.kanbann.blocked, 1);
    assert.ok(Array.isArray(snap.by_project.kanbann.recent_tasks));
    assert.ok(snap.by_project.kanbann.recent_tasks.length >= 1);
    const inProgress = snap.by_project.kanbann.recent_tasks.find((t) => t.id === 't2');
    assert.ok(inProgress);
    assert.equal(inProgress.title, 'Implement SSE diff');
    assert.equal(inProgress.status, 'IN_PROGRESS');
    assert.equal(inProgress.assigned_agent, 'builder-1');
  });

  it('formatSnapshot includes recent project activity with titles and status breakdown', () => {
    const snap = {
      available: true,
      version: '3.6.3',
      tasks_total: 2,
      by_status: { DONE: 1, IN_PROGRESS: 1 },
      by_project: {
        TokenTV: {
          total: 2,
          done: 1,
          active: 1,
          backlog: 0,
          blocked: 0,
          recent_tasks: [
            { id: 'tv-1', title: 'Pillow 240x240 renderer', status: 'DONE', assigned_agent: null },
            { id: 'tv-2', title: 'Firmware HTTP client', status: 'IN_PROGRESS', assigned_agent: 'builder-2' },
          ],
        },
      },
      reaper: { enabled: true, running: true },
    };
    const formatted = formatSnapshot(snap);
    assert.match(formatted, /TokenTV \(2 cards, 1 done, 1 active\)/);
    assert.match(formatted, /recent activity by project|recent project activity/i);
    assert.match(formatted, /\[DONE\] tv-1: Pillow 240x240 renderer/);
    assert.match(formatted, /\[IN_PROGRESS\] tv-2: Firmware HTTP client \(@builder-2\)/);
  });

  it('end-to-end: prompt sent to OpenRouter contains project task titles and status details', async () => {
    const fetchImpl = makeFetch();
    const tasks = [
      { id: 'k-1', title: 'Add mutation lock', status: 'DONE', project: 'kanban' },
      { id: 'k-2', title: 'Add reaper tests', status: 'IN_PROGRESS', project: 'kanban', assigned_agent: 'tester-1' },
    ];
    await withApp({ env: baseEnv(), fetch: fetchImpl, store: fakeStore(tasks) }, async (baseUrl) => {
      await jsonRequest(baseUrl, '/api/ask', askRequest());
      const sent = JSON.parse(fetchImpl.calls[0].opts.body);
      const systemPrompt = sent.messages[0].content;
      assert.match(systemPrompt, /Add mutation lock/);
      assert.match(systemPrompt, /Add reaper tests/);
      assert.match(systemPrompt, /@tester-1/);
    });
  });
});

// ---------------------------------------------------------------------------
// Answer quality (v3.6.4)
//
// The first real answer this feature ever produced was cut off mid-sentence and
// contradicted its own table — it printed "22 cards, 19 done" for a project and
// then wrote that every task was finished. The figures were right; the prose
// ignored them.
// ---------------------------------------------------------------------------

describe('ask: answer quality', () => {
  function tasksFor(project, n, status = 'DONE') {
    return Array.from({ length: n }, (_, i) => ({
      id: `${project}-${i}`,
      project,
      title: `${project} card ${i}`,
      status,
    }));
  }

  it('gives the model enough recent activity to say what was DONE, not just how many', () => {
    const snap = gatherSnapshot({ getTasks: () => tasksFor('alpha', 12) });
    assert.equal(snap.by_project.alpha.total, 12);
    assert.equal(
      snap.by_project.alpha.recent_tasks.length,
      8,
      'three titles per project was too thin to answer "what has been done"',
    );
    const text = formatSnapshot(snap);
    assert.match(text, /recent activity by project/);
    assert.match(text, /alpha card 0/, 'the titles must reach the prompt, not just the counts');
  });

  it('reports a project that is NOT fully done as not fully done', () => {
    // The exact shape the model got wrong: most cards done, a few not.
    const snap = gatherSnapshot({
      getTasks: () => [...tasksFor('tokentv', 19, 'DONE'), ...tasksFor('tokentv-x', 3, 'IN_PROGRESS').map((t) => ({ ...t, project: 'tokentv' }))],
    });
    const p = snap.by_project.tokentv;
    assert.equal(p.total, 22);
    assert.equal(p.done, 19);
    assert.equal(p.active, 3, 'the active count is present — the model had no excuse to say 0');
    assert.match(formatSnapshot(snap), /tokentv \(22 cards, 19 done, 3 active\)/);
  });

  it('instructs the model never to contradict the snapshot figures', () => {
    assert.match(GUARDRAIL_INSTRUCTION, /NEVER state a figure that contradicts the snapshot/);
    assert.match(GUARDRAIL_INSTRUCTION, /do not write "0 active" unless the snapshot says active=0/);
    assert.match(GUARDRAIL_INSTRUCTION, /Name the actual cards/);
  });

  it('defaults the answer budget high enough not to truncate a board-wide answer', async () => {
    const fetchImpl = makeFetch(() => fakeResponse(200, okAnswerBody()));
    await withApp({ env: baseEnv(), store: fakeStore(), fetch: fetchImpl }, async (baseUrl) => {
      await jsonRequest(baseUrl, '/api/ask', askRequest());
    });
    const body = JSON.parse(fetchImpl.calls[0].opts.body);
    assert.equal(body.max_tokens, 1500, '600 cut a twelve-project answer off mid-sentence');
  });
});
