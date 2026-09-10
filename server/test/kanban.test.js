import test, { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import yaml from 'yaml';
import { createApp } from '../server.js';
import * as store from '../store.js';

const execFileAsync = promisify(execFile);
const TOKEN = 'pi03-test-token';

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function headers(role, agentId) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    ...(role ? { 'X-Agent-Role': role } : {}),
    ...(agentId ? { 'X-Agent-Id': agentId } : {}),
  };
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
    it('accepts the owned loop and rejects jumps, invalid values, and missing roles', async () => {
      let result = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(), body: JSON.stringify({ id: 'flow', title: 'State flow' }),
      });
      assert.equal(result.response.status, 201);
      assert.equal(result.body.status, 'BACKLOG');

      result = await jsonRequest(baseUrl, '/api/tasks/flow', {
        method: 'PATCH', headers: headers(), body: JSON.stringify({ status: 'BUILDING' }),
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
        method: 'POST', headers: headers(), body: JSON.stringify({ id: 'jump', title: 'Jump' }),
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
          method: 'POST', headers: headers(), body: JSON.stringify({ id, title: id }),
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
        method: 'POST', headers: headers(), body: JSON.stringify({ id: 'claim', title: 'Claim' }),
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
    });
  });

  describe('KB-04 shared-token identity gate', () => {
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
      await assert.rejects(store.createTask({ id: 'disk-failure', title: 'Must not appear' }), /disk failure/);
      assert.equal(store.getTask('disk-failure'), null);
      store.setStorage(new store.JsonStorage(path.join(tmpDir, 'tasks.json')));
      await store.loadStore();
    });

    it('persists an issue register and exposes issue-bearing tasks for the swimlane', async () => {
      const created = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ id: 'issue-task', title: 'Issue task', issues: ['ISS-001'] }),
      });
      assert.equal(created.response.status, 201);
      const added = await jsonRequest(baseUrl, '/api/tasks/issue-task/issues', {
        method: 'POST', headers: headers(), body: JSON.stringify({ issue_id: 'ISS-002' }),
      });
      assert.equal(added.response.status, 200);
      assert.deepEqual(added.body.issues, ['ISS-001', 'ISS-002']);
      const listed = await jsonRequest(baseUrl, '/api/tasks/issue-task/issues');
      assert.deepEqual(listed.body.issues, ['ISS-001', 'ISS-002']);
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
        method: 'POST', headers: headers(), body: JSON.stringify({ id: 'git-task', title: 'Git card' }),
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
  });
});
