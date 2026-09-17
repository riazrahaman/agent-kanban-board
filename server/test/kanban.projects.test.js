import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const TOKEN = 'pi03-projects-token';

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

describe('§2.1 multi-project namespacing', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-projects-'));
     // Named partitions live under tmpDir/tasks/<project>.json; default reuses tmpDir/tasks.json
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
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
   });

  it('1. composite uniqueness: two projects may share a short id', async () => {
    const a = await jsonRequest(baseUrl, '/api/tasks?project=atlas', {
      method: 'POST', headers: headers(), body: taskBody('task-1', 'Atlas card'),
     });
    assert.equal(a.response.status, 201);
    assert.equal(a.body.project, 'atlas');
    const b = await jsonRequest(baseUrl, '/api/tasks?project=alpha', {
      method: 'POST', headers: headers(), body: taskBody('task-1', 'Alpha card'),
     });
    assert.equal(b.response.status, 201);
    assert.equal(b.body.project, 'alpha');

    const ga = await jsonRequest(baseUrl, '/api/tasks/task-1?project=atlas');
    const gb = await jsonRequest(baseUrl, '/api/tasks/task-1?project=alpha');
    assert.equal(ga.body.title, 'Atlas card');
    assert.equal(gb.body.title, 'Alpha card');
    assert.notEqual(store.getTask('task-1', 'atlas').title, store.getTask('task-1', 'alpha').title);
   });

  it('2. cross-project isolation on list', async () => {
    const all = await jsonRequest(baseUrl, '/api/tasks');
    assert.ok(Array.isArray(all.body), 'unfiltered list returns an array');
    assert.ok(all.body.some((t) => t.project === 'atlas'));
    assert.ok(all.body.some((t) => t.project === 'alpha'));

    const atlasOnly = await jsonRequest(baseUrl, '/api/tasks?project=atlas');
    assert.ok(atlasOnly.body.every((t) => t.project === 'atlas'));

    const none = await jsonRequest(baseUrl, '/api/tasks?project=none');
    assert.deepEqual(none.body, []);
   });

  it('3. default project back-compat: id has no composite prefix', async () => {
    const a = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(), body: taskBody('legacy-no-prefix', 'Default card'),
     });
    assert.equal(a.response.status, 201);
    assert.equal(a.body.project, 'default');
    assert.equal(a.body.id, 'legacy-no-prefix', 'short id is preserved, not composite');

    const scoped = await jsonRequest(baseUrl, '/api/tasks?project=default');
    assert.ok(scoped.body.some((t) => t.id === 'legacy-no-prefix'));

    const bare = await jsonRequest(baseUrl, '/api/tasks');
    assert.ok(bare.body.some((t) => t.id === 'legacy-no-prefix'));
   });

  it('4. composite lookup on detail + unknown composite -> 404', async () => {
    const got = await jsonRequest(baseUrl, '/api/tasks/atlas:task-1');
    assert.equal(got.response.status, 200);
    assert.equal(got.body.title, 'Atlas card');

    const missing = await jsonRequest(baseUrl, '/api/tasks/ghost:task-1');
    assert.equal(missing.response.status, 404);
   });

  it('5. workspace_id alias sets project and is not persisted', async () => {
    const created = await jsonRequest(baseUrl, '/api/tasks?project=', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ id: 'alias-card', title: 'Alias card', status: 'BACKLOG', round: 1, workspace_id: 'atlas' }),
     });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.project, 'atlas');
    assert.equal(created.body.workspace_id, undefined, 'workspace_id must not be persisted');
   });

  it('6. invalid project -> 400; valid accepted', async () => {
    const bad = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ id: 'x1', title: 'x', status: 'BACKLOG', round: 1, project: '../../etc' }),
     });
    assert.equal(bad.response.status, 400);

    const badSlash = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ id: 'x2', title: 'x', status: 'BACKLOG', round: 1, project: 'a/b' }),
     });
    assert.equal(badSlash.response.status, 400);

    const good = await jsonRequest(baseUrl, '/api/tasks?project=vault', {
      method: 'POST', headers: headers(), body: taskBody('vault-card', 'Vault card'),
     });
    assert.equal(good.response.status, 201);
     // No traversal file leaked into the filesystem.
    assert.ok(!existsSync(path.join(tmpDir, 'tasks', '..', '..', 'etc')), 'no traversal');
   });

  it('7. partitioned storage writes only its project', async () => {
    const atlasFile = path.join(tmpDir, 'tasks', 'atlas.json');
    assert.ok(existsSync(atlasFile), 'atlas partition file exists');
    const parsed = JSON.parse(await readFile(atlasFile, 'utf8'));
    assert.equal(parsed.project, 'atlas');
    assert.ok(Array.isArray(parsed.tasks));
    assert.ok(parsed.tasks.every((t) => t.project === 'atlas'), 'atlas.json holds only atlas tasks');
    assert.ok(!parsed.tasks.some((t) => t.project === 'alpha'));

    const projects = await jsonRequest(baseUrl, '/api/projects');
    assert.equal(projects.response.status, 200);
    const atlas = projects.body.find((p) => p.project === 'atlas');
    assert.ok(atlas, 'atlas listed in /api/projects');
    assert.ok(typeof atlas.task_count === 'number');
    assert.ok(typeof atlas.live_count === 'number');
   });

  it('9. project immutability: PATCH {project} -> 400', async () => {
    const res = await jsonRequest(baseUrl, '/api/tasks/task-1?project=atlas', {
      method: 'PATCH', headers: headers('builder'),
      body: JSON.stringify({ project: 'other' }),
          });
    assert.equal(res.response.status, 400, 'project must not be mutable');
      });

  it('10. partition-scoped save isolation: patching atlas does not rewrite alpha.json', async () => {
    const alphaFile = path.join(tmpDir, 'tasks', 'alpha.json');
    assert.ok(existsSync(alphaFile));
    const before = (await stat(alphaFile)).mtimeMs;
    // small delay so mtime is observable
    await new Promise((r) => setTimeout(r, 15));
    const res = await jsonRequest(baseUrl, '/api/tasks/task-1?project=atlas', {
      method: 'PATCH', headers: headers('builder'),
      body: JSON.stringify({ status: 'BUILDING', title: 'Atlas card v2' }),
     });
    assert.equal(res.response.status, 200);
    const after = (await stat(alphaFile)).mtimeMs;
    assert.equal(after, before, 'alpha.json untouched when patching an atlas task');
   });

  it('11. GET /api/projects shape is complete and sorted', async () => {
    const projects = await jsonRequest(baseUrl, '/api/projects');
    assert.ok(Array.isArray(projects.body));
    for (const p of projects.body) {
      assert.ok('project' in p);
      assert.ok('task_count' in p);
      assert.ok('done_count' in p);
      assert.ok('live_count' in p);
      assert.ok('archived_count' in p);
     }
    const names = projects.body.map((p) => p.project);
    const sorted = [...names].sort();
    assert.deepEqual(names, sorted, 'projects sorted by name');
   });
});

describe('§2.1 git-backed partitioning', () => {
  it('8. git writes <project>/<id>.yml for named and flat for default', async () => {
    process.env.KANBAN_STORAGE_BACKEND = 'git';
    const gitDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-git-projects-'));
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const git = promisify(execFile);
    await git('git', ['init'], { cwd: gitDir });
    await git('git', ['config', 'user.name', 'Proj Test'], { cwd: gitDir });
    await git('git', ['config', 'user.email', 'proj@test.local'], { cwd: gitDir });

    process.env.KANBAN_GIT_DIR = gitDir;
    store.setStorage(null);
    await store.loadStore();

    // Named project
    const r1 = await store.createTask({ id: 'at-1', title: 'At card', status: 'BACKLOG', round: 1, project: 'atlas' });
    assert.equal(r1.status, 201);
    assert.ok(existsSync(path.join(gitDir, 'atlas', 'at-1.yml')), 'named project card under atlas/');
    assert.ok(!existsSync(path.join(gitDir, 'at-1.yml')), 'named project card is not flat');
    const log1 = (await git('git', ['log', '--format=%s', '-1'], { cwd: gitDir })).stdout;
    assert.match(log1, /ops\(atlas\/at-1\): kanban BACKLOG/);

    // Default project stays flat
    const r2 = await store.createTask({ id: 'def-1', title: 'Default card', status: 'BACKLOG', round: 1 });
    assert.equal(r2.status, 201);
    assert.ok(existsSync(path.join(gitDir, 'def-1.yml')), 'default card written flat');
    const log2 = (await git('git', ['log', '--format=%s', '-1'], { cwd: gitDir })).stdout;
    assert.match(log2, /ops\(def-1\): kanban BACKLOG/);

    await rm(gitDir, { recursive: true, force: true });
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_GIT_DIR;
    store.setStorage(null);
   });
});
