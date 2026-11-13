/**
 * SSE hardening: keepalive ping (B9), single-serialisation wire frames without
 * `prev` (PERF-01), write-backlog cutoff (PERF-04), per-IP stream cap (A9).
 */
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createApp, liveSseStreamCount, resetSseStreams, drainSseStreams,
  SSE_PING_INTERVAL_MS, SSE_DEFAULT_MAX_STREAMS_PER_IP, sseTestOverrides,
} from '../server.js';
import * as store from '../store.js';

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

function openStream(baseUrl, query = '') {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/api/events${query}`, { agent: false }, (res) => {
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (c) => chunks.push(c));
      resolve({ req, res, text: () => chunks.join('') });
    });
    req.on('error', reject);
  });
}

describe('SSE hardening', () => {
  let tmpDir, server, baseUrl;
  before(async () => {
    delete process.env.KANBAN_MAX_SSE_STREAMS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-sse-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    await new Promise((r) => { server = createApp().listen(0, '127.0.0.1', r); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    drainSseStreams();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('wire frame omits prev but carries kind/task/project, shared across streams', async () => {
    await store.createTask({ id: 'sse-prime', title: 'prime diff layer', status: 'BACKLOG', round: 1 }); // first notify only seeds the diff baseline
    const a = await openStream(baseUrl);
    const b = await openStream(baseUrl);
    await tick();
    const seen = [];
    const off = store.onDiff((e) => seen.push(e));
    await store.createTask({ id: 'sse-wire', title: 'sse wire', status: 'BACKLOG', round: 1 });
    await tick(100);
    off();
    const frames = (s) => s.text().split('\n\n').filter((f) => f.startsWith('event: task.'));
    assert.ok(frames(a).length >= 1);
    assert.deepEqual(frames(a), frames(b));
    for (const f of frames(a)) {
      const data = JSON.parse(f.split('\ndata: ')[1]);
      assert.ok(!('prev' in data));
      assert.ok(data.kind && data.task && 'project' in data);
    }
    // in-process listeners still receive prev
    assert.ok(seen.every((e) => 'prev' in e));
    a.req.destroy(); b.req.destroy();
    await tick();
  });

  it('writes a ": ping" comment frame on the keepalive interval and clears it on close', async () => {
    assert.equal(SSE_PING_INTERVAL_MS, 20_000);
    mock.timers.enable({ apis: ['setInterval'] });
    let s;
    try {
      s = await openStream(baseUrl);
      await tick();
      mock.timers.tick(SSE_PING_INTERVAL_MS);
      await tick();
      assert.match(s.text(), /: ping\n\n/);
    } finally {
      mock.timers.reset();
    }
    s.req.destroy();
    await tick();
    assert.equal(liveSseStreamCount(), 0);
  });

  it('caps concurrent streams per client IP and releases slots exactly once', async () => {
    const SSE_MAX_STREAMS_PER_IP = 10;
    process.env.KANBAN_MAX_SSE_STREAMS_PER_IP = String(SSE_MAX_STREAMS_PER_IP);
    const open = [];
    for (let i = 0; i < SSE_MAX_STREAMS_PER_IP; i++) open.push(await openStream(baseUrl));
    await tick();
    assert.equal(liveSseStreamCount(), SSE_MAX_STREAMS_PER_IP);
    const over = await openStream(baseUrl);
    assert.equal(over.res.statusCode, 503);
    assert.equal(liveSseStreamCount(), SSE_MAX_STREAMS_PER_IP);
    // close one -> a new one fits
    open.pop().req.destroy();
    await tick();
    const again = await openStream(baseUrl);
    assert.equal(again.res.statusCode, 200);
    open.push(again);
    // drain then client close must not double-release
    assert.equal(drainSseStreams(), SSE_MAX_STREAMS_PER_IP);
    for (const s of open) s.req.destroy();
    await tick(100);
    assert.equal(liveSseStreamCount(), 0);
    const fresh = [];
    for (let i = 0; i < SSE_MAX_STREAMS_PER_IP; i++) {
      const s = await openStream(baseUrl);
      assert.equal(s.res.statusCode, 200);
      fresh.push(s);
    }
    for (const s of fresh) s.req.destroy();
    await tick(100);
    resetSseStreams();
    delete process.env.KANBAN_MAX_SSE_STREAMS_PER_IP;
  });

  it('per-IP cap defaults to 20, honours override, and is disabled by a negative value', async () => {
    assert.equal(SSE_DEFAULT_MAX_STREAMS_PER_IP, 20);
    const openN = async (n) => { const a = []; for (let i = 0; i < n; i++) a.push(await openStream(baseUrl)); return a; };
    const closeAll = async (a) => { for (const s of a) s.req.destroy(); await tick(100); };
    delete process.env.KANBAN_MAX_SSE_STREAMS_PER_IP;
    let open = await openN(20);
    assert.equal((await openStream(baseUrl)).res.statusCode, 503, 'default cap is 20');
    await closeAll(open);
    process.env.KANBAN_MAX_SSE_STREAMS_PER_IP = '2';
    open = await openN(2);
    assert.equal((await openStream(baseUrl)).res.statusCode, 503, 'override applies');
    await closeAll(open);
    process.env.KANBAN_MAX_SSE_STREAMS_PER_IP = '-1';
    open = await openN(25);
    assert.equal(liveSseStreamCount(), 25, 'negative disables the per-IP cap');
    await closeAll(open);
    delete process.env.KANBAN_MAX_SSE_STREAMS_PER_IP;
    resetSseStreams();
  });

  it('ends a reader that stops completely after the no-progress timeout and frees its slot', async () => {
    sseTestOverrides.stallMs = 150;
    try {
      const s = await openStream(baseUrl);
      await tick();
      assert.equal(liveSseStreamCount(), 1);
      s.res.pause();
      s.res.socket.pause();
      const big = 'x'.repeat(19_000);
      for (let i = 0; i < 400; i++) {
        await store.createTask({ id: `sse-big-${i}`, title: 'big', description: big, status: 'BACKLOG', round: 1 });
      }
      await tick(700);
      assert.equal(liveSseStreamCount(), 0, 'stalled stream was ended and released');
      s.req.destroy();
      await tick();
      assert.equal(liveSseStreamCount(), 0);
    } finally {
      sseTestOverrides.stallMs = null;
    }
  });

  it('ends a crawling reader once the backlog queued after the prime exceeds the limit', async () => {
    resetSseStreams();
    sseTestOverrides.maxBacklogBytes = 100 * 1024;
    try {
      const s = await openStream(baseUrl, '?prime=1');
      await tick(500);
      s.res.pause();
      s.res.socket.pause();
      const big = 'q'.repeat(19_000);
      for (let i = 0; i < 400 && liveSseStreamCount() > 0; i++) {
        await store.createTask({ id: `sse-crawl-${i}`, title: 'c', description: big, status: 'BACKLOG', round: 1 });
      }
      assert.equal(liveSseStreamCount(), 0, 'backlog limit ended the stream long before the stall timeout');
      s.req.destroy();
      await tick();
    } finally {
      sseTestOverrides.maxBacklogBytes = null;
    }
  });

  it('a >2MB priming frame does not end a fast reader, which keeps receiving diffs', async () => {
    resetSseStreams();
    sseTestOverrides.maxBacklogBytes = 256 * 1024; // far below the prime size: the prime must not count
    const big = 'y'.repeat(19_000);
    for (let i = 0; i < 200; i++) {
      await store.createTask({ id: `sse-prime-big-${i}`, title: 'p', description: big, status: 'BACKLOG', round: 1 });
    }
    const s = await openStream(baseUrl, '?prime=1');
    await tick(1500);
    assert.equal(liveSseStreamCount(), 1, 'stream survives the large priming frame');
    assert.ok(s.text().length > 2 * 1024 * 1024, 'priming frame was larger than the byte threshold');
    await store.createTask({ id: 'sse-after-prime', title: 'after', status: 'BACKLOG', round: 1 });
    await tick(300);
    assert.match(s.text(), /"id":"sse-after-prime"/);
    assert.equal(liveSseStreamCount(), 1);
    sseTestOverrides.maxBacklogBytes = null;
    s.req.destroy();
    await tick();
    assert.equal(liveSseStreamCount(), 0);
  });

  it('a 19MB prime followed by a diff, read slowly but steadily, stays open and gets the diff', async () => {
    resetSseStreams();
    sseTestOverrides.stallMs = 1000;
    try {
      const big = 'z'.repeat(19_000);
      // Bulk-seed in memory (no persistence, one baseline notify) instead of
      // 1,100 sequential createTask calls.
      const tpl = store.getTasks().find((x) => x.id === 'sse-wire');
      for (let i = 0; i < 1100; i++) store.setTaskInMemory({ ...tpl, id: `sse-huge-${i}`, description: big });
      store.notify();
      let received = '';
      let total = 0;
      const { req, res } = await new Promise((resolve, reject) => {
        const rq = http.get(`${baseUrl}/api/events?prime=1`, { agent: false }, (rs) => resolve({ req: rq, res: rs }));
        rq.on('error', reject);
      });
      res.setEncoding('latin1');
      let timer = setInterval(() => {
        const c = res.read();
        if (c) { total += c.length; received = (received + c).slice(-4096); }
      }, 5);
      await tick(100);
      await store.createTask({ id: 'sse-after-huge', title: 'after', status: 'BACKLOG', round: 1 });
      const deadline = Date.now() + 40_000;
      while (!received.includes('sse-after-huge') && Date.now() < deadline && !res.destroyed) await tick(100);
      clearInterval(timer);
      assert.ok(total > 19 * 1024 * 1024, `prime was >19MB (got ${total})`);
      assert.ok(received.includes('sse-after-huge'), 'diff event eventually received');
      assert.equal(liveSseStreamCount(), 1, 'slow steady reader was never cut off');
      req.destroy();
      await tick();
      assert.equal(liveSseStreamCount(), 0);
    } finally {
      sseTestOverrides.stallMs = null;
    }
  });
});
