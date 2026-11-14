/**
 * Compressed SSE streams keep the stall and backlog bounds (single byte domain),
 * and composite-id scope parsing is limited to task routes.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createApp, liveSseStreamCount, resetSseStreams, drainSseStreams, sseTestOverrides, sseLastEndReason,
} from '../server.js';
import { compositePathProjects, conflictingProjectChannels } from '../middleware/projectScope.js';
import * as store from '../store.js';

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const noise = () => randomBytes(14_000).toString('base64'); // ~19 KB, barely compressible

function openGzip(baseUrl, query = '') {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/api/events${query}`, { agent: false, headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      res.on('data', () => {});
      resolve({ req, res });
    });
    req.on('error', reject);
  });
}

describe('compressed SSE bounds', () => {
  let tmpDir, server, baseUrl;
  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-gz-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_MAX_SSE_STREAMS = '-1';
    process.env.KANBAN_MAX_SSE_STREAMS_PER_IP = '-1';
    await store.loadStore();
    await new Promise((r) => { server = createApp().listen(0, '127.0.0.1', r); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    drainSseStreams();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    delete process.env.KANBAN_MAX_SSE_STREAMS;
    delete process.env.KANBAN_MAX_SSE_STREAMS_PER_IP;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('a gzip client that stops reading is ended by the no-progress check', async () => {
    resetSseStreams();
    sseTestOverrides.stallMs = 150;
    let s;
    try {
      s = await openGzip(baseUrl, '?prime=1');
      await tick(100);
      assert.equal(liveSseStreamCount(), 1);
      s.res.pause();
      s.res.socket.pause();
      await store.createTask({ id: 'gz-stall', title: 's', status: 'BACKLOG', round: 1 });
      let n = 0;
      for (; n < 1500 && liveSseStreamCount() > 0; n++) {
        await store.patchTask('gz-stall', { description: noise() });
      }
      await tick(600);
      assert.equal(liveSseStreamCount(), 0, `stalled compressed stream was not ended after ${n} patches`);
      assert.equal(sseLastEndReason(), 'no-progress');
    } finally {
      s?.req.destroy();
      sseTestOverrides.stallMs = null;
      resetSseStreams();
    }
  });

  it('the backlog cap still applies to a compressed stream', async () => {
    resetSseStreams();
    sseTestOverrides.maxBacklogBytes = 100 * 1024;
    sseTestOverrides.stallMs = 10 * 60_000;
    let s;
    try {
      s = await openGzip(baseUrl, '?prime=1');
      await tick(300);
      s.res.pause();
      s.res.socket.pause();
      let n = 0;
      for (; n < 1500 && liveSseStreamCount() > 0; n++) {
        await store.patchTask('gz-stall', { description: noise() });
      }
      assert.equal(liveSseStreamCount(), 0, `backlog cap did not end the stream within ${n} patches`);
      assert.equal(sseLastEndReason(), 'backlog-limit');
    } finally {
      s?.req.destroy();
      sseTestOverrides.maxBacklogBytes = null;
      sseTestOverrides.stallMs = null;
      resetSseStreams();
    }
  });

  it('Cache-Control carries no-transform on the SSE response', async () => {
    const s = await openGzip(baseUrl);
    assert.equal(s.res.headers['cache-control'], 'no-cache, no-transform');
    s.req.destroy();
    await tick();
    resetSseStreams();
  });
});

describe('composite project ids are parsed on task routes only', () => {
  const req = (path, extra = {}) => ({ baseUrl: '', path, query: {}, headers: {}, ...extra });
  it('agent ids with a colon are not project prefixes', () => {
    assert.equal(compositePathProjects(req('/api/agents/worker:1/heartbeat')).size, 0);
    assert.equal(conflictingProjectChannels(req('/api/agents/worker:1/heartbeat', { query: { project: 'main' } })), null);
    // inside the router (relative path + baseUrl), as the guard sees it
    assert.equal(compositePathProjects(req('/worker:1/heartbeat', { baseUrl: '/api/agents' })).size, 0);
  });
  it('task routes still parse a composite id and conflicts are detected', () => {
    assert.deepEqual([...compositePathProjects(req('/api/tasks/beta:t-1/claim'))], ['beta']);
    assert.deepEqual([...compositePathProjects(req('/t-1', { baseUrl: '/api/tasks' }))], []);
    assert.deepEqual([...compositePathProjects(req('/beta%3At-1', { baseUrl: '/api/tasks' }))], ['beta']);
    assert.deepEqual([...compositePathProjects(req('/trash/beta:t-1/restore', { baseUrl: '/api/tasks' }))], ['beta']);
    assert.ok(conflictingProjectChannels(req('/beta:t-1', { baseUrl: '/api/tasks', query: { project: 'alpha' } })));
    assert.equal(conflictingProjectChannels(req('/alpha:t-1', { baseUrl: '/api/tasks', query: { project: 'alpha' } })), null);
  });
});
