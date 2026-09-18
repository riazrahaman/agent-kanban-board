import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'pi03-concurrency-token';

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
  try {
    body = await response.json();
    } catch {
      body = null;
     }
  return { response, body };
}

describe('§2.6 optimistic-concurrency', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-oc-'));
      // Bind a fresh JSON store so the suite is hermetic.
    store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
    await store.loadStore();
   ({ server, baseUrl } = await startTestServer(createApp()));
   });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
    store.setStorage(null);
   });

  it('create assigns version 1', async () => {
    const created = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('oc-create', 'Create'),
      });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.version, 1, 'new task starts at version 1');

      // Re-reading the task confirms the version was persisted, not just
     // echoed in the create response.
    const got = await jsonRequest(baseUrl, '/api/tasks/oc-create');
    assert.equal(got.response.status, 200);
    assert.equal(got.body.version, 1);
   });

  it('a committed mutation bumps version via the nextVersionFor helper', async () => {
      // Directly exercise the centralized bump helper.
    assert.equal(store.nextVersionFor({ version: 1 }), 2, 'helper increments by one');
    assert.equal(store.nextVersionFor({ version: 42 }), 43, 'helper is monotonic');
    assert.equal(store.nextVersionFor({}), 2, 'missing version is treated as 1 -> 2');

      // A committed patch advances 1 -> 2.
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('oc-bump', 'Bump'),
       });
    const patched = await jsonRequest(baseUrl, '/api/tasks/oc-bump', {
      method: 'PATCH', headers: headers('builder'), body: JSON.stringify({ title: 'Bumped' }),
      });
    assert.equal(patched.response.status, 200);
    assert.equal(patched.body.version, 2, 'patch bumps version 1 -> 2');
   });

  it('PATCH with a matching If-Match succeeds and bumps', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('oc-match', 'Match'),
       });
    const ok = await jsonRequest(baseUrl, '/api/tasks/oc-match', {
      method: 'PATCH',
      headers: { ...headers('builder'), 'If-Match': '1' },
      body: JSON.stringify({ title: 'Moved to v2' }),
       });
    assert.equal(ok.response.status, 200, 'matching If-Match succeeds');
    assert.equal(ok.body.version, 2, 'version bumps to 2 on success');
    assert.equal(ok.body.title, 'Moved to v2');
   });

  it('PATCH with a stale If-Match -> 409 and no write', async () => {
      // Advance the task to v2.
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('oc-stale', 'Stale'),
       });
    const first = await jsonRequest(baseUrl, '/api/tasks/oc-stale', {
      method: 'PATCH',
      headers: { ...headers('builder'), 'If-Match': '1' },
      body: JSON.stringify({ title: 'First writer' }),
       });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.version, 2);

      // A second writer still holding version 1 must be rejected with 409 and
     // leave the task untouched (no write, version still 2).
    const stale = await jsonRequest(baseUrl, '/api/tasks/oc-stale', {
      method: 'PATCH',
      headers: { ...headers('builder'), 'If-Match': '1' },
      body: JSON.stringify({ title: 'Stale writer' }),
       });
    assert.equal(stale.response.status, 409, 'stale If-Match is rejected');
        // The version-conflict 409 is distinguishable and carries the current
     // version for a re-fetch + re-apply.
    assert.equal(stale.body.error, 'Version mismatch');
    assert.equal(stale.body.currentVersion, 2, '409 reports the current version');
    assert.deepEqual(stale.body.details, { expected: 2, provided: 1 }, '409 carries expected vs. provided');

      // The stale write did not land.
    const recheck = await jsonRequest(baseUrl, '/api/tasks/oc-stale');
    assert.equal(recheck.response.status, 200);
    assert.equal(recheck.body.title, 'First writer', 'stale write left the task untouched');
    assert.equal(recheck.body.version, 2, 'version unchanged after a rejected write');
   });

  it('expected_version body field is equivalent to the If-Match header', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('oc-body-expected', 'Body expected'),
       });
    const first = await jsonRequest(baseUrl, '/api/tasks/oc-body-expected', {
      method: 'PATCH',
      headers: headers('builder'),
      body: JSON.stringify({ title: 'Body v1', expected_version: 1 }),
       });
    assert.equal(first.response.status, 200, 'body expected_version matching succeeds');
    assert.equal(first.body.version, 2);

      // A stale body-supplied version yields the same 409 as a stale header.
    const stale = await jsonRequest(baseUrl, '/api/tasks/oc-body-expected', {
      method: 'PATCH',
      headers: headers('builder'),
      body: JSON.stringify({ title: 'Stale body', expected_version: 1 }),
       });
    assert.equal(stale.response.status, 409, 'stale body expected_version is rejected');
    assert.equal(stale.body.error, 'Version mismatch');
    assert.equal(stale.body.currentVersion, 2);
    assert.deepEqual(stale.body.details, { expected: 2, provided: 1 });
    const recheck = await jsonRequest(baseUrl, '/api/tasks/oc-body-expected');
    assert.equal(recheck.body.title, 'Body v1', 'stale body patch did not write');
    assert.equal(recheck.body.version, 2);
   });

  it('concurrent double-patch at the same version produces exactly one winner', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('oc-race', 'Race'),
       });
      // Both requests carry If-Match: '1' against a task the create just bumped to
     // version 1; they are fired together so the serializing mutation lock decides
     // the winner.
    const [a, b] = await Promise.all([
      jsonRequest(baseUrl, '/api/tasks/oc-race', {
        method: 'PATCH',
        headers: { ...headers('builder'), 'If-Match': '1' },
        body: JSON.stringify({ title: 'Writer A' }),
       }),
      jsonRequest(baseUrl, '/api/tasks/oc-race', {
        method: 'PATCH',
        headers: { ...headers('builder'), 'If-Match': '1' },
        body: JSON.stringify({ title: 'Writer B' }),
       }),
      ]);
      // Exactly one 200 and one 409, in any order.
    const statuses = [a.response.status, b.response.status].sort();
    assert.deepEqual(statuses, [200, 409], 'exactly one 200 and one 409');

    const winner = a.response.status === 200 ? a : b;
    const loser = a.response.status === 409 ? a : b;
    assert.equal(winner.body.version, 2, 'winner advances version to 2');
      // The loser observes the winner's version as the current one.
    assert.equal(loser.body.currentVersion, 2, '409 reports the winner version as current');
    assert.deepEqual(loser.body.details, { expected: 2, provided: 1 }, 'loser 409 carries expected vs provided');

      // The task reflects exactly the winning write.
    const final = await jsonRequest(baseUrl, '/api/tasks/oc-race');
    assert.equal(final.body.version, 2, 'final state is the single winner version');
    assert.ok(
      final.body.title === 'Writer A' || final.body.title === 'Writer B',
        'final title is a writer write',
        );
   });

  it('legacy records backfill to version 1 and are CAS-patchable', async () => {
    const legacyDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-oc-legacy-'));
       // Seed a record with NO version field (pre-§2.6 shape).
    const nowIso = new Date().toISOString();
    await writeFile(
      path.join(legacyDir, 'tasks.json'),
      JSON.stringify(
          {
          tasks: [
               {
              id: 'legacy-oc', title: 'Legacy no version', status: 'BACKLOG', round: 1,
              priority: 'medium', depends_on: [], issues: [], agent_logs: [],
              assigned_agent: null, metadata: {}, project: 'default',
              created_at: nowIso, updated: nowIso,
               },
               ],
              },
          null, 2,
          )
        );
    store.setStorage(new store.JsonStorage(path.join(legacyDir, 'tasks.json')));
    await store.loadStore();

       // The backfill must have made the version total at 1.
    const loaded = store.getTask('legacy-oc');
    assert.ok(loaded, 'legacy task loaded');
    assert.equal(loaded.version, 1, 'legacy record backfilled to version 1');

       // A first patch with the correct guard (1) bumps to 2 and lands.
    const patch = await store.patchTask('legacy-oc', { title: 'Legacy patched' });
    assert.equal(patch.status, 200);
    assert.equal(patch.task.version, 2, 'backfilled task bumps 1 -> 2 on first patch');

       // And a stale guard (1) is now rejected, proving the CAS is live.
       const stale = await store.patchTask('legacy-oc', { title: 'Stale', expected_version: 1 });
       assert.equal(stale.status, 409, 'stale guard on a backfilled task is rejected');
    assert.equal(stale.error, 'Version mismatch');
    assert.equal(stale.details.expected, 2);

       // Restore a fresh store so other suites stay hermetic.
    store.setStorage(null);
    await rm(legacyDir, { recursive: true, force: true });
    });

  it('claim with a stale version -> 409 distinct from claim-contention 409', async () => {
    await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('oc-claim', 'Claim race'),
       });

      // First claim (no version guard) succeeds and bumps to v2.
    const firstClaim = await jsonRequest(baseUrl, '/api/tasks/oc-claim/claim', {
      method: 'POST', headers: headers(undefined, 'alpha'), body: JSON.stringify({ agent_id: 'alpha' }),
       });
    assert.equal(firstClaim.response.status, 200);
    assert.equal(firstClaim.body.assigned_agent, 'alpha');
    assert.equal(firstClaim.body.version, 2, 'a committed claim bumps version to 2');

      // A second claim against the now-claimed task (stale version) is rejected
     // with a *version* 409, which is distinguishable from a *contention* 409.
    const staleClaim = await jsonRequest(baseUrl, '/api/tasks/oc-claim/claim', {
      method: 'POST',
      headers: { ...headers(undefined, 'beta'), 'If-Match': '1' },
      body: JSON.stringify({ agent_id: 'beta' }),
      });
    assert.equal(staleClaim.response.status, 409, 'stale-version claim is rejected');
    assert.equal(staleClaim.body.error, 'Version mismatch', 'version conflict error string');
    assert.equal(staleClaim.body.currentVersion, 2, 'version 409 reports the current version');
    assert.deepEqual(staleClaim.body.details, { expected: 2, provided: 1 }, 'version 409 carries expected vs provided');

      // Now exercise the contention 409 (no version guard, but the task is held):
     // it must read "… already claimed by …", NOT "Version mismatch", proving the
     // two 409 classes carry different error strings.
    const contention = await jsonRequest(baseUrl, '/api/tasks/oc-claim/claim', {
      method: 'POST', headers: headers(undefined, 'beta'), body: JSON.stringify({ agent_id: 'beta' }),
       });
    assert.equal(contention.response.status, 409, 'contestant is rejected by contention');
    assert.match(contention.body.error, /already claimed by alpha/, 'contention error string');
    assert.notEqual(contention.body.error, staleClaim.body.error, 'contention and version 409 differ');
        // Contention 409 carries no version details (it is not a version conflict).
    assert.equal(contention.body.details, undefined, 'contention 409 has no version details');
    assert.equal(contention.body.currentVersion, undefined, 'contention 409 has no currentVersion');

      // And a claim against the CURRENT version by the holder itself still works,
     // bumping to v3.
    const reclaim = await jsonRequest(baseUrl, '/api/tasks/oc-claim/claim', {
      method: 'POST',
      headers: { ...headers(undefined, 'alpha'), 'If-Match': '2' },
      body: JSON.stringify({ agent_id: 'alpha' }),
       });
    assert.equal(reclaim.response.status, 200, 'holder re-claims at current version');
    assert.equal(reclaim.body.version, 3, 'holder reclaim bumps 2 -> 3');
   });

  it('a throwing mutation neither re-runs nor blocks the queue', async () => {
    const seen = [];
    const throwerRuns = { count: 0 };
    const argSpy = { received: undefined, wasCalled: false };

    const thrower = async () => {
      throwerRuns.count += 1;
      throw new Error('boom');
    };
    const argProbe = async (arg) => {
      argSpy.wasCalled = true;
      argSpy.received = arg;
      seen.push('probe');
    };
    const tail = async () => {
      seen.push('tail');
    };

    // The throwing op must NOT be retried, and must not receive the Error as
    // an argument; the two later ops still run in FIFO order.
    const results = await Promise.allSettled([
      store.withMutationLock(thrower),
      store.withMutationLock(argProbe),
      store.withMutationLock(tail),
    ]);

    assert.equal(results[0].status, 'rejected', 'the throwing op rejects');
    assert.equal(throwerRuns.count, 1, 'the throwing op runs exactly once (no retry)');
    assert.equal(results[1].status, 'fulfilled', 'the op after the thrower still runs');
    assert.equal(results[2].status, 'fulfilled', 'the op after the probe still runs');
    assert.equal(argSpy.wasCalled, true, 'the probe op was invoked');
    assert.equal(argSpy.received, undefined, 'no Error is passed as an argument to the op');
    assert.deepEqual(seen, ['probe', 'tail'], 'ops run in FIFO order after a throw');
   });
});
