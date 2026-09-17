import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'pi03-events-token';

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

async function jsonRequest(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  let body = null;
  try {
    body = await response.json();
    } catch {
      body = null;
    }
  return { response, body };
}

/**
 * Minimal SSE client over fetch's byte stream. Deliberately not `EventSource`:
 * the global is Node-version-dependent, and the stash's hardcoded `:3000`
 * rewrite is the cautionary tale for reaching outside the test's own server.
 */
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
      } catch {/* aborted on close() */}
    })();

  return {
    events,
    async close() {
      controller.abort();
      await pump;
      },
    /** Resolves with all matching events once at least `min` have arrived. */
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

/** Lets the stream settle so "should NOT have received X" assertions are real. */
const settle = () => new Promise((r) => setTimeout(r, 150));

describe('§2.2 scoped + diff SSE', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-events-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));

    // The diff layer seeds `prevTaskMap` on its first dispatch and emits
    // nothing for it. Burn that priming pass here so every assertion below
    // observes a real diff rather than depending on fixture contents.
    store.notify();
   });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
   });

  it('1. legacy path still emits a full `tasks` snapshot on connect and on mutation', async () => {
    const stream = await openStream(baseUrl, '/api/events');
    try {
      const [initial] = await stream.waitFor((e) => e.event === 'tasks');
      assert.ok(Array.isArray(initial.data), 'initial frame is the full task array');

      const created = await jsonRequest(baseUrl, '/api/tasks?project=legacyproj', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ id: 'legacy-a', title: 'Legacy', status: 'BACKLOG', round: 1 }),
        });
      assert.equal(created.response.status, 201);

      const frames = await stream.waitFor((e) => e.event === 'tasks', { min: 2 });
      const latest = frames.at(-1).data;
      assert.ok(Array.isArray(latest));
      assert.ok(
        latest.some((t) => t.id === 'legacy-a' && t.project === 'legacyproj'),
        'unscoped snapshot carries every project',
        );
      } finally {
      await stream.close();
      }
    });

  it('2. a project-scoped snapshot sub sees only its own project', async () => {
    const stream = await openStream(baseUrl, '/api/events?project=alpha');
    try {
      await stream.waitFor((e) => e.event === 'tasks');

      // A mutation in a different project must not leak into alpha's frames.
      await jsonRequest(baseUrl, '/api/tasks?project=beta', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ id: 'beta-1', title: 'Beta card', status: 'BACKLOG', round: 1 }),
        });
      await jsonRequest(baseUrl, '/api/tasks?project=alpha', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ id: 'alpha-1', title: 'Alpha card', status: 'BACKLOG', round: 1 }),
        });

      await stream.waitFor(
        (e) => e.event === 'tasks' && e.data.some((t) => t.id === 'alpha-1'),
        );
      await settle();

      const everySeenTask = stream.events.flatMap((e) => e.data);
      assert.ok(everySeenTask.length > 0, 'saw at least one task');
      assert.ok(
        everySeenTask.every((t) => t.project === 'alpha'),
        'no frame ever carried a task outside project alpha',
        );
      assert.ok(
        !everySeenTask.some((t) => t.id === 'beta-1'),
        'the beta mutation never leaked into the alpha stream',
        );
      } finally {
      await stream.close();
      }
    });

  it('3. diff mode emits task.created / task.updated / task.claimed, scoped to the project', async () => {
    const stream = await openStream(baseUrl, '/api/events?project=gamma&mode=diff');
    try {
      await settle();
      assert.equal(
        stream.events.length, 0,
        'diff mode sends no priming snapshot — only per-task events',
        );

      await jsonRequest(baseUrl, '/api/tasks?project=gamma', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ id: 'gamma-1', title: 'Gamma card', status: 'BACKLOG', round: 1 }),
        });
      const [createdEvt] = await stream.waitFor((e) => e.event === 'task.created');
      assert.equal(createdEvt.data.task.id, 'gamma-1');
      assert.equal(createdEvt.data.project, 'gamma');
      assert.equal(createdEvt.data.prev, null, 'a creation has no previous revision');

      await jsonRequest(baseUrl, '/api/tasks/gamma-1?project=gamma', {
        method: 'PATCH', headers: headers(),
        body: JSON.stringify({ title: 'Gamma card v2' }),
        });
      const [updatedEvt] = await stream.waitFor((e) => e.event === 'task.updated');
      assert.equal(updatedEvt.data.task.title, 'Gamma card v2');
      assert.equal(updatedEvt.data.prev.title, 'Gamma card', 'carries the previous revision');

      const claim = await jsonRequest(baseUrl, '/api/tasks/gamma-1/claim?project=gamma', {
        method: 'POST', headers: headers('builder', 'agent-x'),
        body: JSON.stringify({ agent_id: 'agent-x' }),
        });
      assert.equal(claim.response.status, 200);
      const [claimedEvt] = await stream.waitFor((e) => e.event === 'task.claimed');
      assert.equal(claimedEvt.data.actor, 'agent-x', 'the claiming agent is the actor');
      assert.equal(
        stream.events.filter((e) => e.event === 'task.claimed').length, 1,
        'a claim surfaces as exactly one claimed event, not a claimed plus an updated',
        );

      // Scoping: a mutation elsewhere produces no frame on the gamma stream.
      await settle();
      const before = stream.events.length;
      await jsonRequest(baseUrl, '/api/tasks?project=delta', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ id: 'delta-1', title: 'Delta card', status: 'BACKLOG', round: 1 }),
        });
      await settle();
      const leaked = stream.events.slice(before);
      assert.deepEqual(
        leaked.map((e) => `${e.event}:${e.data.project}/${e.data.task?.id}`), [],
        'no cross-project diff leaked in',
        );
      } finally {
      await stream.close();
      }
    });

  it('4. an archive sweep surfaces as task.archived, not a bare task.removed', async () => {
    await jsonRequest(baseUrl, '/api/tasks?project=sweepproj', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ id: 'sweep-1', title: 'Old card', status: 'BACKLOG', round: 1 }),
      });
    const steps = [
      { role: 'builder', status: 'BUILDING' },
      { role: 'builder', status: 'IN_REVIEW' },
      { role: 'reviewer', status: 'IN_TEST' },
      { role: 'tester', status: 'DONE' },
      ];
    for (const { role, status } of steps) {
      const r = await jsonRequest(baseUrl, '/api/tasks/sweep-1?project=sweepproj', {
        method: 'PATCH', headers: headers(role), body: JSON.stringify({ status }),
        });
      assert.equal(r.response.status, 200, `${status} transition`);
      }

    // Backdate the completion anchor so the row is immediately eligible.
    const task = store.getTask('sweep-1', 'sweepproj');
    const past = new Date(Date.now() - 90 * 86400000).toISOString();
    task.completed_at = past;
    task.created_at = task.created_at || past;
    await store.getStorage('sweepproj').saveTask(task, store.getProjectBucket('sweepproj'));

    const stream = await openStream(baseUrl, '/api/events?project=sweepproj&mode=diff');
    try {
      process.env.KANBAN_ARCHIVE_AFTER_DAYS = '7';
      const moved = await store.runArchiveSweep();
      assert.equal(moved, 1, 'the sweep moved exactly the backdated card');

      const [archivedEvt] = await stream.waitFor((e) => e.event === 'task.archived');
      assert.equal(archivedEvt.data.task.id, 'sweep-1');
      assert.equal(archivedEvt.data.actor, 'system');
      assert.equal(archivedEvt.data.reason, 'archived');
      assert.ok(archivedEvt.data.task.archived_at, 'the event carries the archived revision');
      assert.equal(
        stream.events.filter((e) => e.event === 'task.removed').length, 0,
        'archiving never degrades to a bare removed event',
        );
      } finally {
      delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
      await stream.close();
      }
    });

  it('5. onAudit unsubscribe detaches cleanly', async () => {
    const seen = [];
    const off = store.onAudit((entry) => seen.push(entry));
    await jsonRequest(baseUrl, '/api/tasks?project=auditproj', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ id: 'audit-1', title: 'Audited', status: 'BACKLOG', round: 1 }),
      });
    assert.ok(seen.length > 0, 'the audit sink received the mutation');

    // Regression: the unsubscribe reassigns the listener array, so declaring it
    // `const` made every detach throw `Assignment to constant variable`.
    assert.doesNotThrow(() => off());

    const countAfterDetach = seen.length;
    await jsonRequest(baseUrl, '/api/tasks?project=auditproj', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ id: 'audit-2', title: 'Unaudited', status: 'BACKLOG', round: 1 }),
      });
    assert.equal(seen.length, countAfterDetach, 'no entries arrive after detach');
    });
});
