import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import * as store from '../store.js';
import {
  CONTENT_SECURITY_POLICY,
  INLINE_THEME_SCRIPT_SHA256,
  PERMISSIONS_POLICY,
  SECURITY_HEADERS,
} from '../middleware/securityHeaders.js';
import {
  HTML_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  STATIC_CACHE_CONTROL,
  staticCacheControl,
} from '../utils/staticCache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function cspDirectives(policy) {
  const out = {};
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    out[tokens[0]] = tokens.slice(1).join(' ');
  }
  return out;
}

/**
 * Reads an SSE body until the first complete frame (`\n\n`) arrives, or rejects
 * after `ms`. Every wait is wrapped in `Promise.race` against a timer that the
 * `finally` clears, and a losing `read()` is settled by the caller's abort, so
 * the test cannot leave a timer or a socket behind.
 */
async function readFirstSseFrame(reader, ms = 1500) {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + ms;
  while (!buffer.includes('\n\n')) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`no SSE frame within ${ms}ms`);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no SSE frame within ${ms}ms`)), remaining);
    });
    try {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    } finally {
      clearTimeout(timer);
    }
  }
  return buffer;
}

describe('A6 — security headers (v3.12.4)', () => {
  let tmpDir;
  let distDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-headers-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();

    // CI runs the server suite BEFORE the client build, so `client/dist` does
    // not exist there. A temp dist keeps `GET /` and the fallback testable
    // without one (and without depending on the real build).
    distDir = path.join(tmpDir, 'dist');
    await mkdir(path.join(distDir, 'assets'), { recursive: true });
    await writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>board shell</title><div id="root"></div>');
    await writeFile(path.join(distDir, 'assets', 'app-abc123.js'), 'console.log("asset")');
    await writeFile(path.join(distDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

    ({ server, baseUrl } = await startTestServer(createApp({ clientDist: distDir })));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
  });

  it('1. sends the four base headers on an API response', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(res.headers.get('permissions-policy'), PERMISSIONS_POLICY);
  });

  it('2. sends the same headers on the SPA shell', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /board shell/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
  });

  it('3. sends the shipped CSP verbatim on API and SPA responses', async () => {
    for (const route of ['/api/health', '/']) {
      const res = await fetch(`${baseUrl}${route}`);
      assert.equal(
        res.headers.get('content-security-policy'),
        CONTENT_SECURITY_POLICY,
        `${route} must carry the exact shipped policy`
      );
    }
    const d = cspDirectives(CONTENT_SECURITY_POLICY);
    // The fail-closed directives: no plugins, no <base> hijack, no off-site
    // form posts, no framing, and no third-party script origin beyond the ones
    // the client genuinely loads.
    assert.equal(d['object-src'], "'none'");
    assert.equal(d['base-uri'], "'none'");
    assert.equal(d['form-action'], "'self'");
    assert.equal(d['frame-ancestors'], "'none'");
    assert.equal(d['default-src'], "'self'");
    assert.ok(!CONTENT_SECURITY_POLICY.includes('*'), 'the policy must never contain a wildcard');
    // No scheme-wide escape hatch: an `https:` source would allow every remote
    // origin, which is exactly what pinning the two real origins avoids. This
    // covers EVERY directive and every scheme, not just `https:` on two of them.
    // A bare scheme token (optionally with its trailing colon) is a whole-scheme
    // wildcard, whether it was added deliberately or by a typo.
    const bareScheme = /^(?:[a-z][a-z0-9+.-]*|\*):?$/i;
    for (const [directive, value] of Object.entries(d)) {
      for (const token of value.split(/\s+/).filter(Boolean)) {
        assert.ok(
          !bareScheme.test(token),
          `${directive} must not admit the bare scheme wildcard "${token}"`
        );
      }
      assert.ok(!value.includes('*'), `${directive} must not contain a wildcard source`);
    }
    // Pin the EXACT source sets the client needs, so appending one more (evil)
    // origin to a directive fails here even though it is a concrete URL.
    assert.deepEqual(
      d['script-src'].split(/\s+/).sort(),
      ["'self'", INLINE_THEME_SCRIPT_SHA256, 'https://challenges.cloudflare.com'].sort(),
      'script-src must carry exactly the shipped sources'
    );
    assert.deepEqual(
      d['connect-src'].split(/\s+/).sort(),
      [
        "'self'",
        'https://abacus-production-cbb0.up.railway.app',
        'https://challenges.cloudflare.com',
      ].sort(),
      'connect-src must carry exactly the shipped sources'
    );
  });

  it("4. allows the inline theme bootstrap by hash — not 'unsafe-inline'", async () => {
    const html = await readFile(path.join(repoRoot, 'client', 'index.html'), 'utf8');
    const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
      (m) => m[1]
    );
    assert.equal(inlineScripts.length, 1, 'client/index.html should have exactly one inline script');
    const hash = `'sha256-${createHash('sha256').update(inlineScripts[0], 'utf8').digest('base64')}'`;

    assert.equal(INLINE_THEME_SCRIPT_SHA256, hash, 'CSP hash is stale: update INLINE_THEME_SCRIPT_SHA256');
    assert.ok(CONTENT_SECURITY_POLICY.includes(hash));

    const scriptSrc = cspDirectives(CONTENT_SECURITY_POLICY)['script-src'];
    assert.ok(scriptSrc.includes(hash));
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), 'script-src must not be loosened to unsafe-inline');
    assert.ok(!scriptSrc.includes("'unsafe-eval'"));

    // The BUILT shell, when it exists, must still carry the byte-identical
    // inline bootstrap: Vite copies inline <head> scripts through, but a build
    // plugin or a manual edit could reformat it and silently break the theme
    // bootstrap (CSP drops the script, the page still renders). CI runs the
    // server suite before the client build, so skip when dist is absent.
    let builtHtml = null;
    try {
      builtHtml = await readFile(path.join(repoRoot, 'client', 'dist', 'index.html'), 'utf8');
    } catch {
      builtHtml = null;
    }
    if (builtHtml !== null) {
      const builtScripts = [
        ...builtHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g),
      ].map((m) => m[1]);
      assert.equal(builtScripts.length, 1, 'the built shell should have exactly one inline script');
      const builtHash = `'sha256-${createHash('sha256')
        .update(builtScripts[0], 'utf8')
        .digest('base64')}'`;
      assert.equal(
        builtHash,
        INLINE_THEME_SCRIPT_SHA256,
        'client/dist/index.html drifted from client/index.html: rebuild the client'
      );
    }
  });

  it('5. allows exactly the remote origins the client actually loads', async () => {
    const d = cspDirectives(CONTENT_SECURITY_POLICY);
    // Google Fonts: the <link> stylesheet in index.html + the font files it pulls.
    assert.match(d['style-src'], /https:\/\/fonts\.googleapis\.com/);
    assert.match(d['font-src'], /https:\/\/fonts\.gstatic\.com/);
    // Turnstile: script, iframe and challenge traffic (bug reports).
    assert.match(d['script-src'], /https:\/\/challenges\.cloudflare\.com/);
    assert.equal(d['frame-src'], 'https://challenges.cloudflare.com');
    assert.match(d['connect-src'], /https:\/\/challenges\.cloudflare\.com/);
    // Visit counter (client/src/lib/useVisitCount.ts).
    assert.match(d['connect-src'], /https:\/\/abacus-production-cbb0\.up\.railway\.app/);
    // Same-origin API + SSE.
    assert.match(d['connect-src'], /'self'/);
    // `data:` is only admitted where something actually needs it — and nothing
    // does: images (About tour plates) and media are same-origin paths, and the
    // fonts come from Google. The client's one data: URI is a JSON download
    // link, which no CSP fetch directive governs.
    assert.equal(d['img-src'], "'self'");
    assert.equal(d['font-src'], "'self' https://fonts.gstatic.com");
    assert.ok(!/(^|\s)data:(\s|$)/.test(d['img-src']), 'img-src must not allow data:');
    assert.ok(!/(^|\s)data:(\s|$)/.test(d['font-src']), 'font-src must not allow data:');
  });

  it('6. still sets the headers on a 404', async () => {
    const res = await fetch(`${baseUrl}/api/definitely-not-a-route`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    // Express's finalhandler emits its own, stricter `default-src 'none'` CSP
    // for the stock 404 page and overwrites ours there; what matters is that a
    // policy is present, never absent.
    assert.ok(res.headers.get('content-security-policy'));
  });

  it('7. exports a stable header map', () => {
    assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
    assert.equal(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
    assert.equal(SECURITY_HEADERS['Referrer-Policy'], 'no-referrer');
    assert.equal(SECURITY_HEADERS['Cross-Origin-Opener-Policy'], 'same-origin');
    assert.equal(SECURITY_HEADERS['Content-Security-Policy'], CONTENT_SECURITY_POLICY);
  });
});

describe('B6 — compression (v3.12.4)', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-compression-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp({ clientDist: tmpDir })));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
  });

  it('8. gzips /api/health when the client advertises gzip', async () => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-encoding') || '', /gzip/);
    assert.match(res.headers.get('vary') || '', /Accept-Encoding/i);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.tasks_total, 'number');
  });

  it('9. SSE stream is compressed only through its own sync-flushing encoder', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, {
      headers: { 'accept-encoding': 'gzip' },
      signal: controller.signal,
    });
    try {
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
      // B9: the SSE handler gzips with Z_SYNC_FLUSH per frame (the generic
      // compression middleware still skips it), so frames are never buffered.
      assert.equal(res.headers.get('content-encoding'), 'gzip');
      assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
      // The framing headers arrive immediately: proof the stream was not held
      // back inside the compression middleware's buffer.
      assert.equal(res.headers.get('connection'), 'keep-alive');
    } finally {
      controller.abort();
      await res.body?.cancel().catch(() => {});
    }
  });

  it('10. never buffers ANY spelling of the SSE path', async () => {
    // Express 5's default routing is BOTH non-strict (`/api/events/`) and
    // case-INsensitive (`/API/EVENTS`), so all four spellings below reach the
    // same SSE handler. If the compression filter compared the raw path, a
    // variant would be gzipped and every frame would sit in the compression
    // buffer — the stream would open, never flush, and look healthy to the
    // browser. Assert BOTH halves for EACH spelling: no encoding, and a real
    // frame on the wire within the timeout.
    const variants = ['/api/events', '/api/events/', '/API/EVENTS', '/API/EVENTS/'];
    for (const variant of variants) {
      const controller = new AbortController();
      let res;
      let reader;
      try {
        res = await fetch(`${baseUrl}${variant}?prime=1`, {
          headers: { 'accept-encoding': 'gzip' },
          signal: controller.signal,
        });
        assert.equal(res.status, 200, `${variant} must reach the SSE handler`);
        assert.match(res.headers.get('content-type') || '', /text\/event-stream/, variant);
        assert.equal(
          res.headers.get('content-encoding'),
          'gzip',
          `${variant} must use the sync-flushing SSE encoder, not the buffering middleware`
        );
        reader = res.body.getReader();
        // `?prime=1` makes the diff stream write one `tasks` snapshot on connect
        // (a `settings` frame follows), so a frame proves the write reached the
        // wire instead of being parked inside the compression middleware.
        const frame = await readFirstSseFrame(reader);
        assert.match(
          frame,
          /^event: (tasks|settings)\ndata: /,
          `${variant}: unexpected first frame: ${frame}`
        );
      } finally {
        controller.abort();
        await reader?.cancel().catch(() => {});
        await res?.body?.cancel().catch(() => {});
      }
    }
  });
});

describe('B6 — static cache policy (v3.12.4)', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-static-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();

    const distDir = path.join(tmpDir, 'dist');
    await mkdir(path.join(distDir, 'assets'), { recursive: true });
    await writeFile(path.join(distDir, 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(path.join(distDir, 'assets', 'index-CoxX6heE.js'), 'console.log(1)');
    await writeFile(path.join(distDir, 'favicon.svg'), '<svg/>');

    ({ server, baseUrl } = await startTestServer(createApp({ clientDist: distDir })));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
  });

  it('11. treats content-hashed /assets/* as immutable', () => {
    assert.equal(
      staticCacheControl('/srv/app/client/dist/assets/index-CoxX6heE.js'),
      IMMUTABLE_CACHE_CONTROL
    );
    assert.equal(IMMUTABLE_CACHE_CONTROL, 'public, max-age=31536000, immutable');
    // Windows separators resolve the same way.
    assert.equal(
      staticCacheControl('C:\\app\\client\\dist\\assets\\index-abc.css'),
      IMMUTABLE_CACHE_CONTROL
    );
  });

  it('12. never lets the HTML shell (or the SPA fallback) be cached', () => {
    assert.equal(staticCacheControl('/srv/app/client/dist/index.html'), HTML_CACHE_CONTROL);
    assert.equal(HTML_CACHE_CONTROL, 'no-cache');
    // The SPA fallback sends exactly this file, so it inherits `no-cache`
    // however the path is assembled.
    assert.equal(staticCacheControl(path.join('/srv/app/client/dist', 'index.html')), 'no-cache');
    // An ANCESTOR directory named `assets` must not mark the shell immutable —
    // `.html` is decided before the `assets` segment test.
    assert.equal(staticCacheControl('/opt/assets/kanban/client/dist/index.html'), HTML_CACHE_CONTROL);
    assert.equal(
      staticCacheControl(path.join('/opt/assets/kanban/client/dist', 'index.html')),
      'no-cache'
    );
  });

  it('13. gives unhashed static files a short lifetime', () => {
    assert.equal(staticCacheControl('/srv/app/client/dist/favicon.svg'), STATIC_CACHE_CONTROL);
    assert.equal(staticCacheControl('/srv/app/client/dist/media/kanban-video.mp4'), STATIC_CACHE_CONTROL);
    // A directory merely NAMED "assets-ish" must not be treated as build output.
    assert.equal(staticCacheControl('/srv/app/client/dist/myassets/x.js'), STATIC_CACHE_CONTROL);
  });

  it('14. serves hashed assets over HTTP with the immutable header', async () => {
    const res = await fetch(`${baseUrl}/assets/index-CoxX6heE.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), IMMUTABLE_CACHE_CONTROL);
    assert.equal(await res.text(), 'console.log(1)');
  });

  it('15. serves the shell and the SPA fallback with no-cache', async () => {
    for (const route of ['/', '/board/deep/link']) {
      const res = await fetch(`${baseUrl}${route}`);
      assert.equal(res.status, 200, `${route} should fall back to the shell`);
      assert.equal(res.headers.get('cache-control'), HTML_CACHE_CONTROL, route);
      assert.match(await res.text(), /id="root"/);
    }
    // API paths still bypass the fallback.
    const api = await fetch(`${baseUrl}/api/definitely-not-a-route`);
    assert.equal(api.status, 404);
  });
});
