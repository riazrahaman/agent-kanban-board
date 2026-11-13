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
  SSE_PING_INTERVAL_MS, SSE_MAX_STREAMS_PER_IP,
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
  });

  it('ends a stream whose unread write backlog exceeds the threshold and frees its slot', async () => {
    const s = await openStream(baseUrl);
    await tick();
    assert.equal(liveSseStreamCount(), 1);
    s.res.pause();
    s.res.socket.pause();
    const big = 'x'.repeat(19_000);
    for (let i = 0; i < 600 && liveSseStreamCount() > 0; i++) {
      await store.createTask({ id: `sse-big-${i}`, title: 'big', description: big, status: 'BACKLOG', round: 1 });
    }
    assert.equal(liveSseStreamCount(), 0, 'slow stream was ended and released');
    s.req.destroy();
    await tick();
    assert.equal(liveSseStreamCount(), 0);
  });
});
