import test, { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import yaml from 'yaml';
import { createApp } from '../server.js';
import * as store from '../store.js';

const execFileAsync = promisify(execFile);
const TOKEN = 'pi03-test-token';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
  const body = await response.json();
  return { response, body };
}

describe('PI-03 kanban contract', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-pi03-'));
    store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
    await store.loadStore();
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_AUTH_TOKEN;
  });

  describe('KB-01 and KB-02 state machine and role ownership', () => {
    it('rejects duplicate task ids without replacing the original card', async () => {
      let result = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('duplicate', 'Original'),
      });
      assert.equal(result.response.status, 201);
      result = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('duplicate', 'Replacement'),
      });
      assert.equal(result.response.status, 409);
      const original = await jsonRequest(baseUrl, '/api/tasks/duplicate');
      assert.equal(original.body.title, 'Original');
    });

    it('refuses missing or blank status and round instead of fabricating workflow values', async () => {
      let result = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ id: 'missing-status', title: 'Missing status', round: 1 }),
      });
      assert.equal(result.response.status, 400);
      result = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ id: 'blank-status', title: 'Blank status', status: ' ', round: 1 }),
      });
      assert.equal(result.response.status, 400);
      result = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ id: 'missing-round', title: 'Missing round', status: 'BACKLOG' }),
      });
      assert.equal(result.response.status, 400);
    });

    it('accepts the owned loop and rejects jumps, invalid values, and missing roles', async () => {
      let result = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('flow', 'State flow'),
      });
      assert.equal(result.response.status, 201);
      assert.equal(result.body.status, 'BACKLOG');

      result = await jsonRequest(baseUrl, '/api/tasks/flow', {
        method: 'PATCH', headers: headers(null), body: JSON.stringify({ status: 'BUILDING' }),
      });
      assert.equal(result.response.status, 403, 'missing role must not become admin');
      result = await jsonRequest(baseUrl, '/api/tasks/flow', {
        method: 'PATCH', headers: headers('builder'), body: JSON.stringify({ status: 'BUILDING' }),
      });
      assert.equal(result.response.status, 200);
      result = await jsonRequest(baseUrl, '/api/tasks/flow', {
        method: 'PATCH', headers: headers('builder'), body: JSON.stringify({ status: 'IN_REVIEW' }),
      });
      assert.equal(result.response.status, 200);
      result = await jsonRequest(baseUrl, '/api/tasks/flow', {
        method: 'PATCH', headers: headers('reviewer'), body: JSON.stringify({ status: 'IN_TEST' }),
      });
      assert.equal(result.response.status, 200);
      result = await jsonRequest(baseUrl, '/api/tasks/flow', {
        method: 'PATCH', headers: headers('builder'), body: JSON.stringify({ status: 'DONE' }),
      });
      assert.equal(result.response.status, 403, 'Builder cannot finish a card');
      result = await jsonRequest(baseUrl, '/api/tasks/flow', {
        method: 'PATCH', headers: headers('tester'), body: JSON.stringify({ status: 'DONE' }),
      });
      assert.equal(result.response.status, 200);
      result = await jsonRequest(baseUrl, '/api/tasks/flow', {
        method: 'PATCH', headers: headers('builder'), body: JSON.stringify({ status: 'BUILDING' }),
      });
      assert.equal(result.response.status, 409, 'DONE is terminal');

      result = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('jump', 'Jump'),
      });
      assert.equal(result.response.status, 201);
      result = await jsonRequest(baseUrl, '/api/tasks/jump', {
        method: 'PATCH', headers: headers('builder'), body: JSON.stringify({ status: 'DONE' }),
      });
      assert.equal(result.response.status, 409);
      result = await jsonRequest(baseUrl, '/api/tasks/jump', {
        method: 'PATCH', headers: headers('builder'), body: JSON.stringify({ status: 'NOT_A_STATUS' }),
      });
      assert.equal(result.response.status, 400);
    });

    it('allows BLOCKED from every non-terminal state and only owned roles to move back', async () => {
      const cases = [
        ['blocked-backlog', 'BACKLOG'],
        ['blocked-building', 'BUILDING'],
        ['blocked-review', 'IN_REVIEW'],
        ['blocked-test', 'IN_TEST'],
      ];
      for (const [id, startingStatus] of cases) {
        await jsonRequest(baseUrl, '/api/tasks', {
          method: 'POST', headers: headers(), body: taskBody(id, id),
        });
        if (startingStatus !== 'BACKLOG') {
          await jsonRequest(baseUrl, `/api/tasks/${id}`, {
            method: 'PATCH', headers: headers('builder'), body: JSON.stringify({ status: 'BUILDING' }),
          });
        }
        if (startingStatus === 'IN_REVIEW' || startingStatus === 'IN_TEST') {
          await jsonRequest(baseUrl, `/api/tasks/${id}`, {
            method: 'PATCH', headers: headers('builder'), body: JSON.stringify({ status: 'IN_REVIEW' }),
          });
        }
        if (startingStatus === 'IN_TEST') {
          await jsonRequest(baseUrl, `/api/tasks/${id}`, {
            method: 'PATCH', headers: headers('reviewer'), body: JSON.stringify({ status: 'IN_TEST' }),
          });
        }
        const blocked = await jsonRequest(baseUrl, `/api/tasks/${id}`, {
          method: 'PATCH', headers: headers('runner'), body: JSON.stringify({ status: 'BLOCKED' }),
        });
        assert.equal(blocked.response.status, 200, id);
        const resumed = await jsonRequest(baseUrl, `/api/tasks/${id}`, {
          method: 'PATCH', headers: headers('runner'), body: JSON.stringify({ status: 'BACKLOG' }),
        });
        assert.equal(resumed.response.status, 200, id);
      }
    });
  });

  describe('KB-03 claim contention', () => {
    it('allows one winner even for concurrent claims and permits idempotent reclaim', async () => {
      await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('claim', 'Claim'),
      });
      const claims = await Promise.all(['alpha', 'beta'].map((agentId) => jsonRequest(
        baseUrl,
        '/api/tasks/claim/claim',
        { method: 'POST', headers: headers(undefined, agentId), body: JSON.stringify({ agent_id: agentId }) },
      )));
      assert.deepEqual(claims.map(({ response }) => response.status).sort(), [200, 409]);
      const winner = claims.find(({ response }) => response.status === 200).body.assigned_agent;
      const again = await jsonRequest(baseUrl, '/api/tasks/claim/claim', {
        method: 'POST', headers: headers(undefined, winner), body: JSON.stringify({ agent_id: winner }),
      });
      assert.equal(again.response.status, 200);
      assert.equal(again.body.assigned_agent, winner);

      const bypass = await jsonRequest(baseUrl, '/api/tasks/claim', {
        method: 'PATCH', headers: headers('builder'), body: JSON.stringify({ assigned_agent: 'thief' }),
      });
      assert.equal(bypass.response.status, 200);
      assert.equal(bypass.body.assigned_agent, winner, 'PATCH cannot overwrite claim ownership');
    });
  });

  describe('KB-04 shared-token identity gate', () => {
    it('rejects an unknown role on create, claim, and log mutations', async () => {
      let result = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers('unknown'), body: taskBody('role-gate', 'Role gate'),
      });
      assert.equal(result.response.status, 403);
      result = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('role-gate', 'Role gate'),
      });
      assert.equal(result.response.status, 201);
      result = await jsonRequest(baseUrl, '/api/tasks/role-gate/claim', {
        method: 'POST', headers: headers('unknown'),
        body: JSON.stringify({ agent_id: 'unknown-agent' }),
      });
      assert.equal(result.response.status, 403);
      result = await jsonRequest(baseUrl, '/api/tasks/role-gate/logs', {
        method: 'POST', headers: headers('unknown'),
        body: JSON.stringify({ agent_id: 'unknown-agent', message: 'x' }),
      });
      assert.equal(result.response.status, 403);
    });

    it('fails closed when no token is configured and rejects invalid tokens', async () => {
      delete process.env.KANBAN_AUTH_TOKEN;
      let result = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'no-token', title: 'No token' }),
      });
      assert.equal(result.response.status, 503);
      process.env.KANBAN_AUTH_TOKEN = TOKEN;
      result = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'wrong-token', title: 'Wrong token' }),
      });
      assert.equal(result.response.status, 401);
      assert.equal((await fetch(`${baseUrl}/api/tasks`)).status, 200);
    });
  });

  describe('KB-05 atomic persistence and KB-08 issue register', () => {
    it('does not mutate memory when persistence fails', async () => {
      class FailingStorage extends store.JsonStorage {
        async saveTask() { throw new Error('simulated disk failure'); }
      }
      store.setStorage(new FailingStorage(path.join(tmpDir, 'never-written.json')));
      await assert.rejects(
        store.createTask({ id: 'disk-failure', title: 'Must not appear', status: 'BACKLOG', round: 1 }),
        /disk failure/,
      );
      assert.equal(store.getTask('disk-failure'), null);
      store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
      await store.loadStore();
    });

    it('persists an issue register and exposes issue-bearing tasks for the swimlane', async () => {
      const created = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(),
        body: taskBody('issue-task', 'Issue task', { issues: ['ISS-001'] }),
      });
      assert.equal(created.response.status, 201);
      const added = await jsonRequest(baseUrl, '/api/tasks/issue-task/issues', {
        method: 'POST', headers: headers(), body: JSON.stringify({ issue_id: 'ISS-002' }),
      });
      assert.equal(added.response.status, 200);
      assert.deepEqual(added.body.issues, ['ISS-001', 'ISS-002']);
      const duplicate = await jsonRequest(baseUrl, '/api/tasks/issue-task/issues', {
        method: 'POST', headers: headers(), body: JSON.stringify({ issue_id: 'ISS-002' }),
      });
      assert.deepEqual(duplicate.body.issues, ['ISS-001', 'ISS-002']);
      const listed = await jsonRequest(baseUrl, '/api/tasks/issue-task/issues');
      assert.deepEqual(listed.body.issues, ['ISS-001', 'ISS-002']);

      const malformedRole = await jsonRequest(baseUrl, '/api/tasks/issue-task', {
        method: 'PATCH', headers: headers('not-a-role'), body: JSON.stringify({ status: 'BUILDING' }),
      });
      assert.equal(malformedRole.response.status, 403);
    });

    it('escapes HTML in issue ids and dedupes on the escaped value', async () => {
      const payload = '<img src=x onerror=alert(1)>';
      const created = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(),
        body: taskBody('xss-issue', 'XSS issue'),
      });
      assert.equal(created.response.status, 201);

      const added = await jsonRequest(baseUrl, '/api/tasks/xss-issue/issues', {
        method: 'POST', headers: headers(), body: JSON.stringify({ issue_id: payload }),
      });
      assert.equal(added.response.status, 200);
      assert.deepEqual(added.body.issues, ['&lt;img src=x onerror=alert(1)&gt;']);

      const duplicate = await jsonRequest(baseUrl, '/api/tasks/xss-issue/issues', {
        method: 'POST', headers: headers(), body: JSON.stringify({ issue_id: payload }),
      });
      assert.equal(duplicate.response.status, 200);
      assert.deepEqual(duplicate.body.issues, ['&lt;img src=x onerror=alert(1)&gt;']);

      const persisted = store.getTask('xss-issue');
      assert.deepEqual(persisted.issues, ['&lt;img src=x onerror=alert(1)&gt;']);
      assert.ok(!persisted.issues[0].includes('<'), 'raw < present');
      assert.ok(!persisted.issues[0].includes('>'), 'raw > present');
    });
  });

  describe('KB-09 pluggable git-backed storage', () => {
    it('writes one YAML card per task and commits every transition', async () => {
      const gitDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-git-pi03-'));
      await execFileAsync('git', ['init'], { cwd: gitDir });
      await execFileAsync('git', ['config', 'user.name', 'PI-03 Test'], { cwd: gitDir });
      await execFileAsync('git', ['config', 'user.email', 'pi03@test.local'], { cwd: gitDir });
      store.setStorage(new store.GitYamlStorage(gitDir));
      await store.loadStore();
      const result = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('git-task', 'Git card'),
      });
      assert.equal(result.response.status, 201);
      const cardPath = path.join(gitDir, 'git-task.yml');
      assert.ok(existsSync(cardPath));
      assert.equal(yaml.parse(await readFile(cardPath, 'utf8')).status, 'BACKLOG');
      const transition = await jsonRequest(baseUrl, '/api/tasks/git-task', {
        method: 'PATCH', headers: headers('builder'), body: JSON.stringify({ status: 'BUILDING' }),
      });
      assert.equal(transition.response.status, 200);
      const log = await execFileAsync('git', ['log', '--format=%s', '-2'], { cwd: gitDir });
      assert.match(log.stdout, /ops\(git-task\): kanban BUILDING/);
      assert.match(log.stdout, /ops\(git-task\): kanban BACKLOG/);
      await rm(gitDir, { recursive: true, force: true });
    });

    it('surfaces a commit failure and leaves the in-memory task unchanged', async () => {
      const gitDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-git-failure-pi03-'));
      const hooksDir = path.join(gitDir, 'hooks');
      await execFileAsync('git', ['init'], { cwd: gitDir });
      await execFileAsync('git', ['config', 'user.name', 'PI-03 Test'], { cwd: gitDir });
      await execFileAsync('git', ['config', 'user.email', 'pi03@test.local'], { cwd: gitDir });
      await mkdir(hooksDir, { recursive: true });
      await writeFile(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', 'utf8');
      await chmod(path.join(hooksDir, 'pre-commit'), 0o755);
      await execFileAsync('git', ['config', 'core.hooksPath', hooksDir], { cwd: gitDir });
      await assert.rejects(
        new store.GitYamlStorage(gitDir).saveTask({ id: 'bad-round', title: 'Bad round', status: 'BACKLOG' }),
        /requires a positive integer round/,
      );
      store.setStorage(new store.GitYamlStorage(gitDir));
      await store.loadStore();
      await assert.rejects(
        store.createTask({ id: 'commit-failure', title: 'Commit failure', status: 'BACKLOG', round: 1 }),
        /Git-backed persistence commit failed/,
      );
      assert.equal(store.getTask('commit-failure'), null);
      await assert.rejects(execFileAsync('git', ['log', '-1'], { cwd: gitDir }));
      await rm(gitDir, { recursive: true, force: true });
    });

    it('returns a controlled error when git add fails and keeps the server alive', async () => {
      const gitDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-git-route-failure-pi03-'));
      await execFileAsync('git', ['init'], { cwd: gitDir });
      await execFileAsync('git', ['config', 'user.name', 'PI-03 Test'], { cwd: gitDir });
      await execFileAsync('git', ['config', 'user.email', 'pi03@test.local'], { cwd: gitDir });
      await rm(path.join(gitDir, '.git', 'index'), { force: true });
      await mkdir(path.join(gitDir, '.git', 'index'));
      store.setStorage(new store.GitYamlStorage(gitDir));
      await store.loadStore();
      const failed = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: taskBody('route-failure', 'Route failure'),
      });
      assert.equal(failed.response.status, 500);
      assert.match(failed.body.error, /Internal Server Error/);
      assert.equal(store.getTask('route-failure'), null);
      const liveness = await fetch(`${baseUrl}/api/tasks`);
      assert.equal(liveness.status, 200);
      await rm(gitDir, { recursive: true, force: true });
      store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
      await store.loadStore();
    });
  });
});

describe('PI-04 public board hardening', () => {
  let server;
  let baseUrl;

  before(async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    delete process.env.KANBAN_ALLOWED_ORIGIN;
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.KANBAN_ALLOWED_ORIGIN;
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
  });

  it('allows only the configured CORS origin, never a broad loopback allowlist', async () => {
    let response = await fetch(`${baseUrl}/api/tasks`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');

    response = await fetch(`${baseUrl}/api/tasks`, {
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    assert.equal(response.headers.get('access-control-allow-origin'), null);

    process.env.KANBAN_ALLOWED_ORIGIN = 'https://board.example.test';
    const configured = await startTestServer(createApp());
    try {
      response = await fetch(`${configured.baseUrl}/api/tasks`, {
        headers: { Origin: 'https://board.example.test' },
      });
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://board.example.test');
      response = await fetch(`${configured.baseUrl}/api/tasks`, {
        headers: { Origin: 'http://localhost:5173' },
      });
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    } finally {
      await new Promise((resolve) => configured.server.close(resolve));
      delete process.env.KANBAN_ALLOWED_ORIGIN;
    }
  });

  it('stores agent-authored logs as inert text and the client renders them as JSX text', async () => {
    const created = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST',
      headers: headers(),
      body: taskBody('xss-log', 'XSS log target'),
    });
    assert.equal(created.response.status, 201);

    const logged = await jsonRequest(baseUrl, '/api/tasks/xss-log/logs', {
      method: 'POST',
      headers: headers(undefined, '<agent>'),
      body: JSON.stringify({
        agent_id: '<agent>',
        message: '<script>alert("owned")</script><img src=x onerror=alert(1)>',
      }),
    });
    assert.equal(logged.response.status, 200);
    const log = logged.body.agent_logs.at(-1);
    assert.equal(log.agent_id, '&lt;agent&gt;');
    assert.equal(
      log.message,
      '&lt;script&gt;alert(&quot;owned&quot;)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;',
    );

    const taskSheet = await readFile(path.join(REPO_ROOT, 'client/src/components/TaskSheet.tsx'), 'utf8');
    assert.match(taskSheet, /\{log\.message\}/);
    assert.doesNotMatch(taskSheet, /dangerouslySetInnerHTML/);
  });

  it('keeps the public clone standalone and free of drag-and-drop dependencies', async () => {
    const clientPackage = JSON.parse(
      await readFile(path.join(REPO_ROOT, 'client/package.json'), 'utf8'),
    );
    assert.equal(clientPackage.dependencies?.sortablejs, undefined);
    assert.equal(clientPackage.devDependencies?.sortablejs, undefined);
    const lockfile = await readFile(path.join(REPO_ROOT, 'client/package-lock.json'), 'utf8');
    assert.doesNotMatch(lockfile, /sortablejs/i);

    const sourceFiles = await Promise.all(
      ['App.tsx', 'Board.tsx', 'Column.tsx', 'TaskCard.tsx', 'TaskSheet.tsx', 'SignalRail.tsx']
        .map((file) => readFile(path.join(REPO_ROOT, 'client/src', file === 'App.tsx' ? file : `components/${file}`), 'utf8')),
    );
    assert.ok(sourceFiles.every((source) => !/sortablejs|onDrag|onDrop|draggable/i.test(source)));

    const defaultBackend = process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_STORAGE_BACKEND;
    store.setStorage(null);
    assert.ok(store.getStorage() instanceof store.JsonStorage);
    if (defaultBackend === undefined) delete process.env.KANBAN_STORAGE_BACKEND;
    else process.env.KANBAN_STORAGE_BACKEND = defaultBackend;
  });

  it('keeps client source on the DESIGN.md visual contract', async () => {
    const sourceFiles = await Promise.all(
      ['App.tsx', 'Board.tsx', 'Column.tsx', 'TaskCard.tsx', 'TaskSheet.tsx', 'SignalRail.tsx']
        .map((file) => readFile(path.join(REPO_ROOT, 'client/src', file === 'App.tsx' ? file : `components/${file}`), 'utf8')),
    );
    const source = sourceFiles.join('\n');
    assert.doesNotMatch(source, /rounded-full|shadow-|\bInter\b|\bRoboto\b|👤/i);
    assert.match(source, /tabular-nums/);
    assert.match(source, /StatusBadge/);
    assert.match(await readFile(path.join(REPO_ROOT, 'client/src/index.css'), 'utf8'), /--bg:\s*#fbfbfa/);
    for (const file of ['README.md', 'LICENSE', 'client/package-lock.json', 'server/package-lock.json', '.github/workflows/ci.yml']) {
      assert.ok(existsSync(path.join(REPO_ROOT, file)), `${file} must be present`);
     }
   });
});

// §10.3 back-compat regression guards (must stay green alongside 16 originals).
describe('§2.1/§2.8 back-compat regression', () => {
  let tmpDir;

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    store.setStorage(null);
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_ARCHIVING_DISABLED;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_GIT_DIR;
   });

  it('21. unfiltered GET /api/tasks returns the union of all projects', async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    process.env.KANBAN_DEFAULT_PROJECT = 'default';
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-union-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.createTask({ id: 'u-1', title: 'A', status: 'BACKLOG', round: 1, project: 'atlas' });
    await store.createTask({ id: 'u-1', title: 'B', status: 'BACKLOG', round: 1, project: 'alpha' });
    const all = store.getTasks();
     // Unfiltered list must span every project present (no scoping regression).
    const projects = new Set(all.map((t) => t.project));
    assert.ok(projects.has('atlas') && projects.has('alpha'),
     'unfiltered list spans the projects that were written');
    // The unfiltered HTTP list is also the union.
    const serverApp = createApp();
    const listener = await new Promise((resolve) => {
      const s = serverApp.listen(0, '127.0.0.1', () => resolve(s));
      });
    try {
      const resp = await fetch(`http://127.0.0.1:${listener.address().port}/api/tasks`);
      const body = await resp.json();
      const httpProjects = new Set(body.map((t) => t.project));
      assert.ok(httpProjects.has('atlas') && httpProjects.has('alpha'),
        'HTTP unfiltered list spans the projects that were written');
  } finally {
      await new Promise((resolve) => listener.close(resolve));
      }
    });

  it('22. default project keeps the legacy file; no stray tasks/default.json', async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    process.env.KANBAN_DEFAULT_PROJECT = 'default';
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-legacy-'));
    store.setStorage(null);
     // No KANBAN_DATA_DIR set here so default uses the legacy file directly.
    delete process.env.KANBAN_DATA_DIR;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.createTask({ id: 'legacy-1', title: 'Legacy', status: 'BACKLOG', round: 1 });
    assert.ok(existsSync(path.join(tmpDir, 'tasks.json')), 'legacy file is used');
    assert.ok(!existsSync(path.join(tmpDir, 'tasks', 'default.json')), 'no partitioned default file created');
    const stored = JSON.parse(await readFile(path.join(tmpDir, 'tasks.json'), 'utf8'));
    assert.ok(Array.isArray(stored.tasks), 'legacy file keeps the {tasks:[]} envelope');
    assert.equal(stored.tasks[0].project, 'default');
     });

  it('23. legacy records backfill project/created_at/completed_at on load', async () => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
    process.env.KANBAN_DEFAULT_PROJECT = 'default';
    delete process.env.KANBAN_STORAGE_BACKEND;
    process.env.KANBAN_ARCHIVE_AFTER_DAYS = '30'; // default; legacy records become eligible by age
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-backfill-'));
    store.setStorage(null);
    delete process.env.KANBAN_DATA_DIR;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
       // Seed records with NO project / created_at / completed_at (pure legacy shape).
    const past = new Date(Date.now() - 40 * 86400000).toISOString();
    await writeFile(
      path.join(tmpDir, 'tasks.json'),
      JSON.stringify(
        {
          tasks: [
             {
              id: 'legacy-done', title: 'Legacy DONE', status: 'DONE', round: 1,
              priority: 'high', depends_on: [], issues: [], agent_logs: [],
              assigned_agent: null, metadata: {}, updated: past,
              },
             {
              id: 'legacy-open', title: 'Legacy open', status: 'BACKLOG', round: 1,
              priority: 'medium', depends_on: [], issues: [], agent_logs: [],
              assigned_agent: null, metadata: {}, updated: past,
              },
             ],
            },
          null, 2
        )
      );
    await store.loadStore();
       // Default sweep may move the old DONE; assert every *loaded* record got backfilled.
    const done = store.getTask('legacy-done') || store.getArchivedTasks('default').find((t) => t.id === 'legacy-done');
    assert.ok(done, 'legacy done survived (live or archived)');
    assert.equal(done.project, 'default', 'project backfilled to default');
    assert.ok(done.created_at, 'created_at backfilled on legacy record');
    const open = store.getTask('legacy-open');
    assert.ok(open, 'legacy open task loaded');
    assert.equal(open.project, 'default');
    assert.ok(open.created_at, 'created_at backfilled on open legacy record');
     });
});
