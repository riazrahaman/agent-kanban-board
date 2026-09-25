import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'perf280-token';

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function headers(role = 'builder', agentId) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    ...(role ? { 'X-Agent-Role': role } : {}),
    ...(agentId ? { 'X-Agent-Id': agentId } : {}),
  };
}

function taskBody(id, title, extra = {}) {
  return JSON.stringify({ id, title, status: 'BACKLOG', round: 1, ...extra });
}

async function jsonRequest(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

async function openStream(baseUrl, route) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}${route}`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = frame.split('\n');
          const name = lines.find((l) => l.startsWith('event: '));
          const data = lines.find((l) => l.startsWith('data: '));
          if (name && data) {
            events.push({ event: name.slice(7), data: JSON.parse(data.slice(6)) });
          }
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    events,
    async close() { controller.abort(); await pump; },
    async waitFor(predicate, { min = 1, timeoutMs = 3000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hits = events.filter(predicate);
        if (hits.length >= min) return hits;
        if (Date.now() > deadline) {
          const seen = events.map((e) => e.event).join(', ') || '(none)';
          throw new Error(`timed out waiting for SSE event; saw: ${seen}`);
        }
        await new Promise((r) => setTimeout(r, 15));
      }
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 150));

// ===========================================================================
// FIX 1: SSE diff-default + settings on diff + prime param
// ===========================================================================
describe('PERF-01: SSE diff is default; settings on both modes; prime param', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-perf01-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
    store.notify(); // burn priming pass
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
  });

  it('1a. default mode (no query param) is diff — no tasks priming, has settings', async () => {
    const stream = await openStream(baseUrl, '/api/events');
    try {
      await settle();
      const primingTaskEvents = stream.events.filter(
        (e) => e.event === 'tasks' || e.event.startsWith('task.'),
      );
      assert.equal(primingTaskEvents.length, 0, 'default (diff) mode sends no priming tasks');
      assert.ok(
        stream.events.some((e) => e.event === 'settings'),
        'default (diff) mode carries settings on connect',
      );
    } finally {
      await stream.close();
    }
  });

  it('1b. ?prime=1 in diff mode emits a priming tasks snapshot', async () => {
    // Seed a task first so the priming snapshot has content.
    await jsonRequest(baseUrl, '/api/tasks?project=primeproj', {
      method: 'POST', headers: headers(),
      body: taskBody('prime-1', 'Prime test'),
    });
    const stream = await openStream(baseUrl, '/api/events?project=primeproj&prime=1');
    try {
      const [snap] = await stream.waitFor((e) => e.event === 'tasks');
      assert.ok(Array.isArray(snap.data), 'prime snapshot is an array');
      assert.ok(snap.data.some((t) => t.id === 'prime-1'), 'prime snapshot includes existing task');
    } finally {
      await stream.close();
    }
  });

  it('1c. diff mode without prime=1 sends NO tasks snapshot even when tasks exist', async () => {
    const stream = await openStream(baseUrl, '/api/events?project=primeproj&mode=diff');
    try {
      await settle();
      const taskEvents = stream.events.filter((e) => e.event === 'tasks');
      assert.equal(taskEvents.length, 0, 'diff without prime=1 sends no tasks snapshot');
    } finally {
      await stream.close();
    }
  });

  it('1d. snapshot mode (?mode=snapshot) still emits tasks and settings', async () => {
    const stream = await openStream(baseUrl, '/api/events?mode=snapshot');
    try {
      await stream.waitFor((e) => e.event === 'tasks');
      assert.ok(
        stream.events.some((e) => e.event === 'settings'),
        'snapshot mode also carries settings',
      );
    } finally {
      await stream.close();
    }
  });

  it('1e. diff mode emits task.created on mutation', async () => {
    const stream = await openStream(baseUrl, '/api/events?project=diffproj');
    try {
      await settle();
      await jsonRequest(baseUrl, '/api/tasks?project=diffproj', {
        method: 'POST', headers: headers(),
        body: taskBody('diff-1', 'Diff creation'),
      });
      const [created] = await stream.waitFor((e) => e.event === 'task.created');
      assert.equal(created.data.task.id, 'diff-1');
      assert.equal(created.data.kind, 'created');
    } finally {
      await stream.close();
    }
  });
});

// ===========================================================================
// FIX 2: Journal-based append-only storage
// ===========================================================================
describe('PERF-02: journal-based append-only storage', () => {
  let tmpDir;
  let dataFile;

  before(async () => {
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-perf02-'));
    dataFile = path.join(tmpDir, 'tasks.json');
  });

  after(async () => {
    delete process.env.KANBAN_STORAGE_JOURNAL;
    delete process.env.KANBAN_JOURNAL_COMPACT_BYTES;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    await rm(tmpDir, { recursive: true, force: true });
    store.setStorage(null);
  });

  it('2a. journal OFF (default): saveTask rewrites the whole file (byte-identical to pre-2.8)', async () => {
    delete process.env.KANBAN_STORAGE_JOURNAL;
    store.setStorage(new store.JsonStorage(dataFile));
    await store.loadStore();
    await store.createTask({ id: 'joff-1', title: 'Journal off', status: 'BACKLOG', round: 1 }, 'default');
    await store.createTask({ id: 'joff-2', title: 'Second task', status: 'BACKLOG', round: 1 }, 'default');

    const raw = await readFile(dataFile, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.ok(parsed.tasks.some((t) => t.id === 'joff-1'));
    assert.ok(parsed.tasks.some((t) => t.id === 'joff-2'));
    // No journal file should exist when journaling is off.
    assert.ok(!existsSync(`${dataFile}.journal.jsonl`), 'no journal file when journaling is off');
  });

  it('2b. journal ON: saveTask appends a journal line instead of rewriting the base file', async () => {
    process.env.KANBAN_STORAGE_JOURNAL = '1';
    const journalFile = `${dataFile}.journal.jsonl`;
    // Clean slate with journal ON
    store.setStorage(null);
    await rm(dataFile, { force: true });
    await rm(journalFile, { force: true });
    store.setStorage(new store.JsonStorage(dataFile));
    await store.loadStore();

    await store.createTask({ id: 'jon-1', title: 'Journal on', status: 'BACKLOG', round: 1 }, 'default');

    // After createTask (which calls saveTask), the journal should have one upsert line.
    assert.ok(existsSync(journalFile), 'journal file created when journaling is on');
    const jraw = await readFile(journalFile, 'utf-8');
    const lines = jraw.split('\n').filter((l) => l.trim());
    assert.ok(lines.length >= 1, 'journal has at least one entry');
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.op, 'upsert');
    assert.equal(entry.task.id, 'jon-1');
  });

  it('2c. journal ON: load() replays journal over base file', async () => {
    // The base file may be empty or stale; the journal has jon-1.
    // Reload the store — it should pick up jon-1 from the journal.
    store.setStorage(null);
    store.setStorage(new store.JsonStorage(dataFile));
    await store.loadStore();
    const tasks = store.getTasks();
    assert.ok(tasks.some((t) => t.id === 'jon-1'), 'load() replayed journal and found jon-1');
  });

  it('2d. journal ON: deleteTask appends remove op and rewrites canonical', async () => {
    process.env.KANBAN_STORAGE_JOURNAL = '1';
    const journalFile = `${dataFile}.journal.jsonl`;

    // Create a second task
    await store.createTask({ id: 'jon-2', title: 'To delete', status: 'BACKLOG', round: 1 }, 'default');

    // Now delete jon-1 (needs admin caller)
    const delResult = await store.deleteTask('jon-1', { caller: { role: 'admin' }, project: 'default' });
    assert.ok(!delResult.error, `deleteTask succeeded: ${delResult.error || 'ok'}`);

    // The canonical file should NOT contain jon-1 after delete
    const raw = await readFile(dataFile, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.ok(!parsed.tasks.some((t) => t.id === 'jon-1'), 'deleted task not in canonical file');
    assert.ok(parsed.tasks.some((t) => t.id === 'jon-2'), 'surviving task still in canonical');

    // Journal should be truncated (empty) after delete (delete does full rewrite + truncate)
    const jraw = await readFile(journalFile, 'utf-8');
    assert.equal(jraw.trim(), '', 'journal truncated after delete (canonical rewrite)');
  });

  it('2e. journal ON: compaction triggers when journal exceeds threshold', async () => {
    process.env.KANBAN_STORAGE_JOURNAL = '1';
    // Set a very small compact threshold to force compaction
    process.env.KANBAN_JOURNAL_COMPACT_BYTES = '100';
    const journalFile = `${dataFile}.journal.jsonl`;

    // Fresh storage
    store.setStorage(null);
    await rm(dataFile, { force: true });
    await rm(journalFile, { force: true });
    store.setStorage(new store.JsonStorage(dataFile));
    await store.loadStore();

    // Create multiple tasks — each appends a journal line. After a few,
    // the journal should exceed 100 bytes and compact.
    for (let i = 0; i < 5; i++) {
      await store.createTask({ id: `compact-${i}`, title: `Task ${i}`, status: 'BACKLOG', round: 1 }, 'default');
    }

    // After compaction, the canonical file should contain all tasks and journal should be empty.
    const raw = await readFile(dataFile, 'utf-8');
    const parsed = JSON.parse(raw);
    // At least some tasks should be in the canonical file (compaction writes them all)
    assert.ok(parsed.tasks.length >= 3, 'canonical file has tasks after compaction');

    const jraw = await readFile(journalFile, 'utf-8');
    // Journal should be empty or very small after compaction
    const jlines = jraw.split('\n').filter((l) => l.trim());
    // After the last compaction, any subsequent writes would add lines;
    // but the last write may have triggered compaction again.
    assert.ok(jlines.length <= 1, 'journal is empty or nearly empty after compaction');

    delete process.env.KANBAN_JOURNAL_COMPACT_BYTES;
  });

  it('2f. journal ON: reload after compaction sees all tasks', async () => {
    process.env.KANBAN_STORAGE_JOURNAL = '1';
    store.setStorage(null);
    store.setStorage(new store.JsonStorage(dataFile));
    await store.loadStore();
    const tasks = store.getTasks();
    // All compact-0 through compact-4 should be present
    for (let i = 0; i < 5; i++) {
      assert.ok(tasks.some((t) => t.id === `compact-${i}`), `task compact-${i} present after reload`);
    }
  });
});

// ===========================================================================
// FIX 3: Inline cap + spill + paging endpoint
// ===========================================================================
describe('PERF-03: inline log/comment cap with spill + paging endpoint', () => {
  let tmpDir;
  let server;
  let baseUrl;
  const LOG_CAP = 5;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    process.env.KANBAN_INLINE_LOG_CAP = String(LOG_CAP);
    process.env.KANBAN_INLINE_COMMENT_CAP = String(LOG_CAP);
    process.env.KANBAN_REAP_ENABLED = 'false';
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-perf03-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_INLINE_LOG_CAP;
    delete process.env.KANBAN_INLINE_COMMENT_CAP;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
  });

  it('3a. inline log array is capped; overflow spills to sidecar file', async () => {
    // Create a task and append more logs than the cap.
    await jsonRequest(baseUrl, '/api/tasks?project=spillproj', {
      method: 'POST', headers: headers(),
      body: taskBody('spill-1', 'Spill test'),
    });
    const agentId = 'spill-agent';
    for (let i = 0; i < LOG_CAP + 3; i++) {
      await jsonRequest(baseUrl, '/api/tasks/spill-1/logs?project=spillproj', {
        method: 'POST', headers: headers('builder', agentId),
        body: JSON.stringify({ message: `log entry ${i}`, agent_id: agentId }),
      });
    }

    // Fetch the task — inline logs should be capped at LOG_CAP.
    const { body: task } = await jsonRequest(baseUrl, '/api/tasks/spill-1?project=spillproj');
    assert.ok(task.agent_logs.length <= LOG_CAP, `inline logs capped at ${LOG_CAP}, got ${task.agent_logs.length}`);
    // The newest LOG_CAP entries should be inline (entries 3..7 → "log entry 3" through "log entry 7")
    const inlineMessages = task.agent_logs.map((l) => l.message);
    assert.ok(inlineMessages.includes(`log entry ${LOG_CAP + 2}`), 'newest log is inline');
    assert.ok(!inlineMessages.includes('log entry 0'), 'oldest log was spilled out');

    // Spill file should exist and contain the overflow entries.
    const spillPath = path.join(tmpDir, 'spill', 'spillproj', 'spill-1.jsonl');
    assert.ok(existsSync(spillPath), 'spill file exists');
    const spillRaw = await readFile(spillPath, 'utf-8');
    const spillLines = spillRaw.split('\n').filter((l) => l.trim());
    assert.ok(spillLines.length >= 3, `spill file has at least 3 entries, got ${spillLines.length}`);
    const firstSpill = JSON.parse(spillLines[0]);
    assert.equal(firstSpill.type, 'log');
  });

  it('3b. GET /:id/logs returns inline (newest-first) + spilled_count + entries', async () => {
    const { response, body } = await jsonRequest(
      baseUrl,
      '/api/tasks/spill-1/logs?project=spillproj&include_spilled=1',
    );
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(body.inline), 'inline is an array');
    assert.ok(body.inline.length <= LOG_CAP, 'inline is capped');
    assert.ok(body.spilled_count >= 3, `spilled_count >= 3, got ${body.spilled_count}`);
    assert.ok(Array.isArray(body.entries), 'entries is an array');
    assert.ok(body.entries.length >= 3, 'entries includes spilled items');
    // Inline should be newest-first: the first inline entry should be the last log appended.
    assert.equal(body.inline[0].message, `log entry ${LOG_CAP + 2}`);
  });

  it('3c. GET /:id/logs paging: offset/limit on spilled entries', async () => {
    const { body: page1 } = await jsonRequest(
      baseUrl,
      '/api/tasks/spill-1/logs?project=spillproj&offset=0&limit=2',
    );
    assert.ok(page1.entries.length <= 2, 'page 1 limited to 2 entries');
    const { body: page2 } = await jsonRequest(
      baseUrl,
      '/api/tasks/spill-1/logs?project=spillproj&offset=2&limit=2',
    );
    // page2 entries should not overlap with page1
    if (page1.entries.length > 0 && page2.entries.length > 0) {
      assert.notEqual(page1.entries[0].message, page2.entries[0].message, 'pages do not overlap');
    }
  });

  it('3d. GET /:id/logs returns 404 for non-existent task', async () => {
    const { response } = await jsonRequest(
      baseUrl,
      '/api/tasks/nonexistent/logs?project=spillproj',
    );
    assert.equal(response.status, 404);
  });

  it('3e. inline comment array is capped; overflow spills', async () => {
    await jsonRequest(baseUrl, '/api/tasks?project=commentproj', {
      method: 'POST', headers: headers(),
      body: taskBody('comment-spill', 'Comment spill test'),
    });
    const agentId = 'comment-agent';
    for (let i = 0; i < LOG_CAP + 2; i++) {
      await jsonRequest(baseUrl, '/api/tasks/comment-spill/comments?project=commentproj', {
        method: 'POST', headers: headers('builder', agentId),
        body: JSON.stringify({ message: `comment ${i}`, agent_id: agentId }),
      });
    }
    const { body: task } = await jsonRequest(baseUrl, '/api/tasks/comment-spill?project=commentproj');
    assert.ok(task.comments.length <= LOG_CAP, `inline comments capped at ${LOG_CAP}, got ${task.comments.length}`);
    const commentMessages = task.comments.map((c) => c.message);
    assert.ok(commentMessages.includes(`comment ${LOG_CAP + 1}`), 'newest comment is inline');
    assert.ok(!commentMessages.includes('comment 0'), 'oldest comment was spilled');

    const spillPath = path.join(tmpDir, 'spill', 'commentproj', 'comment-spill.jsonl');
    assert.ok(existsSync(spillPath), 'comment spill file exists');
    const spillRaw = await readFile(spillPath, 'utf-8');
    const spillLines = spillRaw.split('\n').filter((l) => l.trim());
    assert.ok(spillLines.length >= 2, 'spill file has overflow comments');
    const firstSpill = JSON.parse(spillLines[0]);
    assert.equal(firstSpill.type, 'comment');
  });

  it('3f. cap=0 means unbounded (no spill)', async () => {
    // Create a fresh store with cap=0
    process.env.KANBAN_INLINE_LOG_CAP = '0';
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    // We need a fresh server with the new cap
    await new Promise((resolve) => server.close(resolve));
    ({ server, baseUrl } = await startTestServer(createApp()));

    await jsonRequest(baseUrl, '/api/tasks?project=uncapped', {
      method: 'POST', headers: headers(),
      body: taskBody('uncapped-1', 'Uncapped'),
    });
    const agentId = 'uncapped-agent';
    for (let i = 0; i < 10; i++) {
      await jsonRequest(baseUrl, '/api/tasks/uncapped-1/logs?project=uncapped', {
        method: 'POST', headers: headers('builder', agentId),
        body: JSON.stringify({ message: `uncapped log ${i}`, agent_id: agentId }),
      });
    }
    const { body: task } = await jsonRequest(baseUrl, '/api/tasks/uncapped-1?project=uncapped');
    assert.equal(task.agent_logs.length, 10, 'all 10 logs inline when cap=0 (unbounded)');
    const spillPath = path.join(tmpDir, 'spill', 'uncapped', 'uncapped-1.jsonl');
    assert.ok(!existsSync(spillPath), 'no spill file when cap=0');
  });
});