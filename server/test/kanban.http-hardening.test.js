/**
 * Batch 5 HTTP hardening: HSTS on secure requests only, conflicting project
 * channels, opt-in bound-credential mode, SSE content-coding, stream headroom.
 */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { createApp, pickSseEncoding, resetSseStreams, sseReservedForCredentialed } from '../server.js';
import { countUnboundCredentials, reportUnboundCredentials, parseProjectTokens } from '../middleware/auth.js';
import { resetAuthLimits, resetRateLimits } from '../middleware/rateLimit.js';
import * as store from '../store.js';

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () =>
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });

const H = (token, extra = {}) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'X-Agent-Role': 'builder',
  ...extra,
});

describe('batch 5 HTTP hardening', () => {
  let tmpDir, server, baseUrl;
  const envKeys = [
    'KANBAN_PROJECT_TOKENS', 'KANBAN_ADMIN_TOKEN', 'KANBAN_AUTH_TOKEN', 'KANBAN_TRUST_PROXY',
    'KANBAN_REQUIRE_BOUND_CREDENTIALS', 'KANBAN_MAX_SSE_STREAMS', 'KANBAN_MAX_SSE_STREAMS_PER_IP',
  ];

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-http5-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
  });
  afterEach(() => {
    for (const k of envKeys) delete process.env[k];
    resetRateLimits();
    resetAuthLimits();
    resetSseStreams();
  });
  after(async () => {
    server?.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function start() {
    server?.closeAllConnections?.();
    server?.close();
    ({ server, baseUrl } = await listen(createApp()));
  }

  it('A6: no HSTS over plain http, even with a spoofed forwarded proto', async () => {
    await start();
    let res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.headers.get('strict-transport-security'), null);
    res = await fetch(`${baseUrl}/api/health`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(res.headers.get('strict-transport-security'), null, 'untrusted proxy header is ignored');
  });

  it('A6: HSTS is sent when the proxy is trusted and reports https', async () => {
    process.env.KANBAN_TRUST_PROXY = '1';
    await start();
    const res = await fetch(`${baseUrl}/api/health`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
    const plain = await fetch(`${baseUrl}/api/health`, { headers: { 'X-Forwarded-Proto': 'http' } });
    assert.equal(plain.headers.get('strict-transport-security'), null);
  });

  it('SEC-101: conflicting project channels are rejected with 400', async () => {
    process.env.KANBAN_ADMIN_TOKEN = 'adm';
    await start();
    const get = (qs, headers = {}) => fetch(`${baseUrl}/api/tasks${qs}`, { headers });
    assert.equal((await get('?project=alpha&workspace=beta')).status, 400);
    assert.equal((await get('?project=alpha', { 'X-Kanban-Project': 'beta' })).status, 400);
    assert.equal((await get('?project=alpha&workspace=alpha')).status, 200);
    assert.equal((await get('?project=alpha&workspace=')).status, 200, 'blank means absent');
    assert.equal((await get('?project=alpha', { 'X-Kanban-Project': '  ' })).status, 200);
    const body = await fetch(`${baseUrl}/api/tasks?project=alpha`, {
      method: 'POST', headers: H('adm', { 'X-Agent-Role': 'orchestrator' }),
      body: JSON.stringify({ title: 't', project: 'beta' }),
    });
    assert.equal(body.status, 400);
    const composite = await fetch(`${baseUrl}/api/tasks/beta:t-1?project=alpha`);
    assert.equal(composite.status, 400);
    const same = await fetch(`${baseUrl}/api/tasks/alpha:t-1?project=alpha`);
    assert.notEqual(same.status, 400);
  });

  it('A7: counts unbound credentials without exposing values', () => {
    const parsed = parseProjectTokens(JSON.stringify({
      alpha: 'legacy-secret',
      beta: { token: 'tok-b', role: 'builder' },
      gamma: { token: 'tok-c', role: 'builder', agent_id: 'agent-7' },
    }));
    assert.deepEqual(countUnboundCredentials(parsed, undefined), { total: 3, unbound: 2 });
    assert.deepEqual(countUnboundCredentials(parsed, 'single'), { total: 4, unbound: 3 });
    const lines = [];
    reportUnboundCredentials({ warn: (m) => lines.push(m) }, parsed);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /2 of 3 credential/);
    assert.ok(!/legacy-secret|tok-b|tok-c/.test(lines[0]));
  });

  it('A7: strict mode rejects unbound writes with 403; default mode and bound credentials are unaffected', async () => {
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({
      alpha: 'unbound-tok',
      beta: { token: 'bound-tok', role: 'builder', agent_id: 'agent-b' },
    });
    await start();
    const post = (token, project) => fetch(`${baseUrl}/api/tasks?project=${project}`, {
      method: 'POST', headers: H(token, { 'X-Agent-Id': 'someone' }), body: JSON.stringify({ id: 'x-' + Math.random().toString(36).slice(2, 8), title: 'x', status: 'BACKLOG', round: 1 }),
    });
    assert.equal((await post('unbound-tok', 'alpha')).status, 201, 'default off: no behaviour change');
    process.env.KANBAN_REQUIRE_BOUND_CREDENTIALS = '1';
    const denied = await post('unbound-tok', 'alpha');
    assert.equal(denied.status, 403);
    assert.equal((await post('bound-tok', 'beta')).status, 201);
    process.env.KANBAN_ADMIN_TOKEN = 'adm';
    const adm = await fetch(`${baseUrl}/api/tasks?project=alpha`, {
      method: 'POST', headers: H('adm', { 'X-Agent-Role': 'orchestrator' }), body: JSON.stringify({ id: 'y-1', title: 'y', status: 'BACKLOG', round: 1 }),
    });
    assert.equal(adm.status, 201);
  });

  it('A7: strict mode also covers the legacy single token', async () => {
    process.env.KANBAN_AUTH_TOKEN = 'legacy';
    process.env.KANBAN_REQUIRE_BOUND_CREDENTIALS = '1';
    await start();
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST', headers: H('legacy'), body: JSON.stringify({ id: 'x-' + Math.random().toString(36).slice(2, 8), title: 'x', status: 'BACKLOG', round: 1 }),
    });
    assert.equal(res.status, 403);
  });

  it('B9: encoding negotiation', () => {
    assert.equal(pickSseEncoding(undefined), null);
    assert.equal(pickSseEncoding('gzip, deflate, br'), 'gzip');
    assert.equal(pickSseEncoding('deflate'), 'deflate');
    assert.equal(pickSseEncoding('gzip;q=0, deflate'), 'deflate');
    assert.equal(pickSseEncoding('identity'), null);
    assert.equal(pickSseEncoding('br'), null);
  });

  // Raw http so the body is NOT auto-decoded and byte counts are real.
  function rawSse(url, acceptEncoding, onChunk) {
    return new Promise((resolve) => {
      const headers = acceptEncoding ? { 'Accept-Encoding': acceptEncoding } : {};
      const req = http.get(url, { headers }, (res) => {
        resolve({ req, res });
        res.on('data', onChunk);
      });
    });
  }

  it('B9: gzip stream flushes every frame promptly and shrinks the prime frame', async () => {
    process.env.KANBAN_ADMIN_TOKEN = 'adm';
    const tasks = [];
    for (let i = 0; i < 200; i++) tasks.push(store.createTask({ id: `bulk-${i}`, status: 'BACKLOG', round: 1, title: `bulk task ${i}`, description: 'lorem ipsum dolor sit amet '.repeat(8), project: 'bulkp' }));
    await Promise.all(tasks);
    await start();

    const measure = async (enc) => {
      let bytes = 0;
      const chunks = [];
      const { req, res } = await rawSse(`${baseUrl}/api/events?prime=1&project=bulkp`, enc, (c) => { bytes += c.length; chunks.push(c); });
      await new Promise((r) => setTimeout(r, 600));
      req.destroy();
      return { bytes, res, body: Buffer.concat(chunks) };
    };
    const plain = await measure(null);
    const gz = await measure('gzip');
    assert.equal(plain.res.headers['content-encoding'], undefined);
    assert.equal(gz.res.headers['content-encoding'], 'gzip');
    assert.equal(gz.res.headers['x-accel-buffering'], 'no');
    assert.match(gz.res.headers['cache-control'], /no-cache/);
    console.log(`# prime frame @200 tasks: plain=${plain.bytes}B gzip=${gz.bytes}B`);
    assert.ok(gz.bytes < plain.bytes / 3, `gzip ${gz.bytes} vs plain ${plain.bytes}`);
    const text = zlib.gunzipSync(gz.body, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString();
    assert.match(text, /^event: tasks\ndata: \[/);
  });

  it('B9: a mutation event arrives through the gzip stream without waiting for more data', async () => {
    process.env.KANBAN_ADMIN_TOKEN = 'adm';
    await start();
    const gunzip = zlib.createGunzip();
    let seen = '';
    gunzip.on('data', (d) => { seen += d.toString(); });
    const { req, res } = await rawSse(`${baseUrl}/api/events`, 'gzip', (c) => gunzip.write(c));
    assert.equal(res.headers['content-encoding'], 'gzip');
    await fetch(`${baseUrl}/api/tasks?project=live5`, {
      method: 'POST', headers: H('adm', { 'X-Agent-Role': 'orchestrator' }), body: JSON.stringify({ id: 'live-1', title: 'live-event', status: 'BACKLOG', round: 1 }),
    });
    const deadline = Date.now() + 3000;
    while (!/live-event/.test(seen) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    req.destroy();
    assert.match(seen, /event: task\.created/);
    assert.match(seen, /live-event/);
  });

  it('A9: anonymous streams cannot take the reserved headroom; credentialed callers can', async () => {
    assert.equal(sseReservedForCredentialed(100), 20);
    assert.equal(sseReservedForCredentialed(5), 1);
    assert.equal(sseReservedForCredentialed(4), 0);
    process.env.KANBAN_ADMIN_TOKEN = 'adm';
    process.env.KANBAN_MAX_SSE_STREAMS = '5';
    process.env.KANBAN_MAX_SSE_STREAMS_PER_IP = '-1';
    await start();
    const open = [];
    const statusOf = async (headers) => {
      const { req, res } = await rawSse(`${baseUrl}/api/events`, null, () => {});
      open.push(req);
      return res.statusCode;
    };
    // cap 5, reserve 1 -> anonymous limit 4
    for (let i = 0; i < 4; i++) assert.equal(await statusOf(), 200);
    assert.equal(await statusOf(), 503);
    const auth = await new Promise((resolve) => {
      const req = http.get(`${baseUrl}/api/events`, { headers: { Authorization: 'Bearer adm' } }, (res) => { open.push(req); resolve(res.statusCode); });
    });
    assert.equal(auth, 200);
    open.forEach((r) => r.destroy());
  });
});
