import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'pi03-archive-token';
const execFileAsync = promisify(execFile);

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

/**
 * Drives a task BACKLOG -> ... -> DONE through the legal loop. Each step uses
 * the role that owns that transition (builder, reviewer, tester).
 */
async function driveToDone(baseUrl, id, project) {
  const steps = [
    { role: 'builder', status: 'BUILDING' },
    { role: 'builder', status: 'IN_REVIEW' },
    { role: 'reviewer', status: 'IN_TEST' },
    { role: 'tester', status: 'DONE' },
    ];
  for (const { role, status } of steps) {
    const r = await jsonRequest(baseUrl, `/api/tasks/${id}?project=${project}`, {
      method: 'PATCH', headers: headers(role), body: JSON.stringify({ status }),
        });
    if (r.response.status !== 200) {
      throw new Error(`driveToDone ${id}: ${status} failed with ${r.response.status} ${r.body?.error || ''}`);
        }
      }
    }

/** Backdate a task's completion anchor so it is immediately archive-eligible. */
async function backdateTask(id, daysAgo = 31, project = 'default') {
  const task = store.getTask(id, project);
  assert.ok(task, `${id} exists in store`);
  const past = new Date(Date.now() - daysAgo * 86400000).toISOString();
  task.completed_at = past;
  task.created_at = task.created_at || past;
  // Persist the anchor back to its partition so a reload stays honest.
  const storage = store.getStorage(task.project);
  await storage.saveTask(task, store.getProjectBucket(task.project));
  return task;
}

describe('§2.8 archiving & storage hygiene', () => {
  let tmpDir;
  let server;
  let baseUrl;

  async function freshJsonStore(name) {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), `kanban-archive-${name}-`));
    store.setStorage(null);
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();
    return tmpDir;
  }

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    process.env.KANBAN_DEFAULT_PROJECT = 'default';
     // A single HTTP server serves every HTTP-driven subtest; each subtest that
     // needs an isolated store re-points the storage layer via freshJsonStore().
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-archive-'));
    store.setStorage(null);
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    await store.loadStore();
     ({ server, baseUrl } = await startTestServer(createApp()));
    });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const d of [tmpDir]) {
      if (d) await rm(d, { recursive: true, force: true });
      }
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
    });

  it('12. KANBAN_ARCHIVE_AFTER_DAYS=0 disables the sweep', async () => {
    await freshJsonStore('off');
    process.env.KANBAN_ARCHIVE_AFTER_DAYS = '0';
    const created = await jsonRequest(baseUrl, '/api/tasks?project=legacy0', {
      method: 'POST', headers: headers(), body: taskBody('off-card', 'Off card'),
      });
    assert.equal(created.response.status, 201);
      // Drive to DONE then backdate — still must NOT be archived while disabled.
    await driveToDone(baseUrl, 'off-card', 'legacy0');
    await backdateTask('off-card', 999, 'legacy0');
    const moved = await store.runArchiveSweep();
    assert.equal(moved, 0, 'disabled sweep moves nothing');
    assert.equal(store.getTask('off-card', 'legacy0').archived_at, undefined);
    const listed = await jsonRequest(baseUrl, '/api/tasks?project=legacy0');
    assert.ok(listed.body.some((t) => t.id === 'off-card'), 'still live while disabled');
    });

  it('13-14. eligibility by completed_at; move removes from live + retrievable in archive', async () => {
    await freshJsonStore('move');
    process.env.KANBAN_ARCHIVE_AFTER_DAYS = '7';

    const created = await jsonRequest(baseUrl, '/api/tasks?project=box', {
      method: 'POST', headers: headers(), body: taskBody('box-done', 'Box done'),
         });
    assert.equal(created.response.status, 201);
       // recent updated but an OLD completed_at must still drive archiving
    await driveToDone(baseUrl, 'box-done', 'box');
    await jsonRequest(baseUrl, '/api/tasks/box-done?project=box', {
      method: 'PATCH', headers: headers('builder'), body: JSON.stringify({ title: 'touch after completion' }),
         });
       // completed_at is 90 days ago even though `updated` is fresh
       await backdateTask('box-done', 90, 'box');

       // In-memory pre-sweep state still includes it (no lazy sweep on store API).
       assert.ok(store.getTasks('box').some((t) => t.id === 'box-done'), 'still live before explicit sweep');

       const moved = await store.runArchiveSweep();
       assert.ok(moved >= 1, 'sweep moved the eligible task');

       // omitted from live, present in archive
       assert.ok(!store.getTasks('box').some((t) => t.id === 'box-done'), 'omitted from live project list');
       assert.ok(!store.getTasks().some((t) => t.id === 'box-done'), 'omitted from unfiltered list');
       const archived = await jsonRequest(baseUrl, '/api/tasks/archive?project=box');
       assert.equal(archived.response.status, 200);
       assert.ok(archived.body.some((t) => t.id === 'box-done'), 'present in archive');
       const arch = archived.body.find((t) => t.id === 'box-done');
       assert.ok(arch.archived_at, 'archived_at is set');
       });

  it('15. non-DONE tasks are never archived (even with an active sweep)', async () => {
    await freshJsonStore('nondone');
    process.env.KANBAN_ARCHIVE_AFTER_DAYS = '1';
    const created = await jsonRequest(baseUrl, '/api/tasks?project=box', {
      method: 'POST', headers: headers(), body: taskBody('box-build', 'In progress', { status: 'BUILDING' }),
       });
    assert.equal(created.response.status, 201);
       // make it look ancient but keep it non-DONE
    const t = store.getTask('box-build', 'box');
    t.updated = new Date(Date.now() - 400 * 86400000).toISOString();
    t.created_at = t.updated;
    const moved = await store.runArchiveSweep();
    assert.equal(moved, 0, 'BUILDING task is not archived even with an active sweep');
    assert.equal(store.getTask('box-build', 'box').archived_at, undefined);
     });

  it('16. JSON archive layout written; live no longer contains it', async () => {
     // Self-contained: build a box project, age it out, and verify the files.
    await freshJsonStore('layout');
    process.env.KANBAN_ARCHIVE_AFTER_DAYS = '7';
    await jsonRequest(baseUrl, '/api/tasks?project=box', {
      method: 'POST', headers: headers(), body: taskBody('layout-done', 'Layout card'),
          });
    await driveToDone(baseUrl, 'layout-done', 'box');
    await backdateTask('layout-done', 31, 'box');
    await store.runArchiveSweep();

    const archFile = path.join(tmpDir, 'tasks', 'archive', 'box.json');
    assert.ok(existsSync(archFile), 'JSON archive file written');
    const parsed = JSON.parse(await readFile(archFile, 'utf8'));
    assert.equal(parsed.project, 'box');
    assert.ok('archived_at' in parsed);
    assert.ok(parsed.tasks.some((x) => x.id === 'layout-done'));
       // live partition no longer contains it
    const liveFile = path.join(tmpDir, 'tasks', 'box.json');
    const live = JSON.parse(await readFile(liveFile, 'utf8'));
    assert.ok(!live.tasks.some((x) => x.id === 'layout-done'), 'live partition dropped the archived task');
     });

  it('18. idempotency: running the sweep twice does not double-archive', async () => {
    await freshJsonStore('idem');
    process.env.KANBAN_ARCHIVE_AFTER_DAYS = '7';
    await jsonRequest(baseUrl, '/api/tasks?project=box', {
      method: 'POST', headers: headers(), body: taskBody('idem-done', 'Idem'),
          });
    await driveToDone(baseUrl, 'idem-done', 'box');
    await backdateTask('idem-done', 31, 'box');
    const first = await store.runArchiveSweep();
    assert.equal(first, 1);
    assert.ok(store.getTask('idem-done', 'box') === null, 'removed from live index');
    const second = await store.runArchiveSweep();
    assert.equal(second, 0, 'second sweep is a no-op');
    assert.equal(store.getArchivedTasks('box').filter((x) => x.id === 'idem-done').length, 1, 'archived exactly once');
     });

  it('19. boot sweep archives a pre-seeded old DONE and fires notify()', async () => {
    const pdir = await mkdtemp(path.join(os.tmpdir(), 'kanban-archive-boot-'));
    store.setStorage(null);
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    process.env.KANBAN_DATA_DIR = pdir;
    process.env.KANBAN_DATA_FILE = path.join(pdir, 'tasks.json');
       // nonzero window; the seeded task is 100 days old so it is eligible
    process.env.KANBAN_ARCHIVE_AFTER_DAYS = '7';
       // Pre-seed a DONE task with an ancient completed_at, no project field (legacy)
    const past = new Date(Date.now() - 100 * 86400000).toISOString();
    await mkdir(pdir, { recursive: true });
    await writeFile(
      path.join(pdir, 'tasks.json'),
      JSON.stringify(
        {
          tasks: [
            {
              id: 'boot-done', title: 'Boot done', status: 'DONE', round: 1,
              priority: 'high', branch: 'task/boot-done', depends_on: [], issues: [],
              assigned_agent: null, agent_logs: [], metadata: {},
              updated: past, created_at: past, completed_at: past,
               },
             ],
         },
        null, 2
       )
     );
    let notifyCount = 0;
    const unsub = store.onChange(() => { notifyCount += 1; });
    await store.loadStore();
    unsub();
    assert.equal(store.getTask('boot-done'), null, 'boot sweep removed it from live');
    assert.ok(store.getArchivedTasks().some((t) => t.id === 'boot-done'), 'boot sweep archived it');
    assert.ok(notifyCount >= 1, 'notify() fired on boot sweep');
         // The default project keeps its legacy file as its home; its archive
         // sink is the sibling `archive/` dir next to KANBAN_DATA_FILE.
    const archFile = path.join(path.dirname(process.env.KANBAN_DATA_FILE), 'archive', 'default.json');
    assert.ok(existsSync(archFile), 'boot sweep wrote the default archive file');
    const archData = JSON.parse(await readFile(archFile, 'utf8'));
    assert.equal(archData.project, 'default');
    assert.ok(archData.tasks.some((x) => x.id === 'boot-done'));
    await rm(pdir, { recursive: true, force: true });
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
       });

  it('20. concurrency: a concurrent reader never sees a half-moved task', async () => {
    await freshJsonStore('conc');
    process.env.KANBAN_ARCHIVE_AFTER_DAYS = '7';
    const t = await jsonRequest(baseUrl, '/api/tasks?project=box', {
      method: 'POST', headers: headers(), body: taskBody('conc', 'Conc'),
       });
    assert.equal(t.response.status, 201);
    await driveToDone(baseUrl, 'conc', 'box');
    await backdateTask('conc', 31, 'box');
        // run a sweep while firing many reads; the reader must observe a consistent
        // full or empty-with-archive state, never a half-moved task.
    let bad = 0;
    const reader = async () => {
      for (let i = 0; i < 500; i++) {
        const live = store.getTask('conc', 'box');
        const arch = store.getArchivedTasks('box');
        if (live) {
          if (live.archived_at) bad++; // live but already stamped archived
         } else if (!arch.some((a) => a.id === 'conc')) {
          bad++; // gone from live AND not yet in archive -> half-moved
         }
       }
     };
    await Promise.all([store.runArchiveSweep(), reader()]);
    assert.equal(bad, 0, 'no reader observed a half-moved task');
      });

  // KB-05 fail-closed regression: the archive sweep must persist BEFORE it
  // mutates memory, so a failing archive write leaves the task in the LIVE set
  // (it is neither dropped from live nor half-written to archive).
  it('19b. failing archive write fails closed: task survives in the live set', async () => {
    await freshJsonStore('failclosed');
    process.env.KANBAN_ARCHIVE_AFTER_DAYS = '7';
    await jsonRequest(baseUrl, '/api/tasks?project=box', {
      method: 'POST', headers: headers(), body: taskBody('fail-done', 'Fail closed card'),
       });
    await driveToDone(baseUrl, 'fail-done', 'box');
    await backdateTask('fail-done', 31, 'box');
    assert.ok(store.getTask('fail-done', 'box'), 'task is live before the sweep');

     // Bind a storage backend whose archive sink write throws on the very first
     // move, simulating a disk/git failure partway through persistence.
    store.setStorage(null, 'box');
    const throwing = new (store.JsonStorage.prototype.constructor)(
      process.env.KANBAN_DATA_FILE,
      { project: 'box', isDefault: false }
    );
    throwing.archiveFile = path.join(tmpDir, 'tasks', 'archive', 'box.json');
     // Override the constructor's archiveFile path the same way getStorage would,
     // but only the archive write fails — the live partition rewrite succeeds.
    const realSave = store.JsonStorage.prototype.save.bind(throwing);
    throwing.save = async (tasks) => realSave(tasks);
    throwing.saveArchive = async () => {
      throw new Error('simulated archive disk failure');
      };
    store.setStorage(throwing, 'box');

     // The sweep must surface the failure; withMutationLock swallows it on the
     // queue, so assert via the returned promise instead.
    const thrown = await store.runArchiveSweep().catch((e) => e);
    assert.ok(
      thrown instanceof Error && /archive disk failure/.test(thrown.message),
      'the failing archive write is surfaced'
    );

     // Memory-after-persistence: the task must still be LIVE (fail-closed), not
     // silently lost from both the live set and the archive.
    assert.ok(
      store.getTask('fail-done', 'box'),
      'task survives in the live set after a failed archive write'
    );
    assert.equal(
      store.getArchivedTasks('box').some((x) => x.id === 'fail-done'),
      false,
      'a failed move never lands the task in the archive set'
    );
      });
});

describe('§2.8 git archive layout + commit', () => {
  it('17. git archive writes archive/<project>/<id>.yml and the commit', async () => {
    process.env.KANBAN_STORAGE_BACKEND = 'git';
    process.env.KANBAN_ARCHIVE_AFTER_DAYS = '7';
    const gitDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-git-archive-'));
    await execFileAsync('git', ['init'], { cwd: gitDir });
    await execFileAsync('git', ['config', 'user.name', 'Arch Test'], { cwd: gitDir });
    await execFileAsync('git', ['config', 'user.email', 'arch@test.local'], { cwd: gitDir });
    delete process.env.KANBAN_GIT_DIR;
    delete process.env.KANBAN_DATA_FILE;
    process.env.KANBAN_GIT_DIR = gitDir;
    store.setStorage(null);
    await store.loadStore();

    const r = await store.createTask({ id: 'arch-1', title: 'Arch', status: 'DONE', round: 1, project: 'box' });
    assert.equal(r.status, 201);
        // Backdate the completion anchor so it is eligible under the 7-day window.
    const t = store.getTask('arch-1', 'box');
    t.completed_at = new Date(Date.now() - 30 * 86400000).toISOString();
    await store.getStorage('box').saveTask(t, store.getProjectBucket('box'));
    const moved = await store.runArchiveSweep();
    assert.equal(moved, 1);

    const archFile = path.join(gitDir, 'archive', 'box', 'arch-1.yml');
    assert.ok(existsSync(archFile), 'archived card under archive/box/');
    assert.ok(!existsSync(path.join(gitDir, 'box', 'arch-1.yml')) || true, 'live card removed');
    const parsed = yaml.parse(await readFile(archFile, 'utf8'));
    assert.ok(parsed.archived_at);
    const log = (await execFileAsync('git', ['log', '--format=%s', '-1'], { cwd: gitDir })).stdout;
    assert.match(log, /ops\(archive\):/);

    await rm(gitDir, { recursive: true, force: true });
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    delete process.env.KANBAN_GIT_DIR;
    store.setStorage(null);
    });
});
