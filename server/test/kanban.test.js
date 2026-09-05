import test, { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'yaml';
import { createApp } from '../server.js';
import * as store from '../store.js';

const execFileAsync = promisify(execFile);

// Helper to launch app on ephemeral port
async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({ server, baseUrl });
    });
  });
}

describe('Agent Kanban Board API & Core Services (PI-03)', () => {
  let tmpDir;
  let serverInstance;
  let baseUrl;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-test-'));
    const testDataFile = path.join(tmpDir, 'tasks.json');
    store.setStorage(new store.JsonStorage(testDataFile));
    await store.loadStore();

    const app = createApp();
    const { server, baseUrl: url } = await startTestServer(app);
    serverInstance = server;
    baseUrl = url;
  });

  after(async () => {
    if (serverInstance) {
      await new Promise((resolve) => serverInstance.close(resolve));
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // KB-01: State Machine Transitions
  // --------------------------------------------------------------------------
  describe('KB-01: State Machine Enforcement', () => {
    it('allows valid progressive transitions: BACKLOG -> BUILDING -> IN_REVIEW -> IN_TEST -> DONE', async () => {
      const createRes = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'task-flow-1', title: 'Flow Test' }),
      });
      assert.equal(createRes.status, 201);
      const task = await createRes.json();
      assert.equal(task.status, 'BACKLOG');

      // BACKLOG -> BUILDING
      const p1 = await fetch(`${baseUrl}/api/tasks/task-flow-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'BUILDING' }),
      });
      assert.equal(p1.status, 200);
      assert.equal((await p1.json()).status, 'BUILDING');

      // BUILDING -> IN_REVIEW
      const p2 = await fetch(`${baseUrl}/api/tasks/task-flow-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'IN_REVIEW' }),
      });
      assert.equal(p2.status, 200);
      assert.equal((await p2.json()).status, 'IN_REVIEW');

      // IN_REVIEW -> IN_TEST
      const p3 = await fetch(`${baseUrl}/api/tasks/task-flow-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'IN_TEST' }),
      });
      assert.equal(p3.status, 200);
      assert.equal((await p3.json()).status, 'IN_TEST');

      // IN_TEST -> DONE
      const p4 = await fetch(`${baseUrl}/api/tasks/task-flow-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'DONE' }),
      });
      assert.equal(p4.status, 200);
      assert.equal((await p4.json()).status, 'DONE');
    });

    it('refuses invalid jump from BACKLOG directly to DONE with 409 Conflict', async () => {
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'task-jump-1', title: 'Jump Test' }),
      });

      const res = await fetch(`${baseUrl}/api/tasks/task-jump-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'DONE' }),
      });
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.match(data.error, /invalid state transition/i);
    });

    it('refuses invalid jump from BUILDING directly to DONE with 409 Conflict', async () => {
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'task-jump-2', title: 'Jump Test 2' }),
      });
      await fetch(`${baseUrl}/api/tasks/task-jump-2`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'BUILDING' }),
      });

      const res = await fetch(`${baseUrl}/api/tasks/task-jump-2`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'DONE' }),
      });
      assert.equal(res.status, 409);
    });

    it('allows BLOCKED transition from active states, but refuses direct transition from BLOCKED to DONE', async () => {
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'task-block-1', title: 'Block Test' }),
      });
      await fetch(`${baseUrl}/api/tasks/task-block-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'BUILDING' }),
      });

      // Move to BLOCKED
      const blockRes = await fetch(`${baseUrl}/api/tasks/task-block-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'BLOCKED' }),
      });
      assert.equal(blockRes.status, 200);

      // Attempt BLOCKED -> DONE directly
      const doneRes = await fetch(`${baseUrl}/api/tasks/task-block-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'DONE' }),
      });
      assert.equal(doneRes.status, 409);
    });
  });

  // --------------------------------------------------------------------------
  // KB-02: Role Ownership Rules
  // --------------------------------------------------------------------------
  describe('KB-02: Role Ownership Enforcement', () => {
    beforeEach(async () => {
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'task-role-1', title: 'Role Test' }),
      });
    });

    it('refuses a Builder moving a card to DONE with 403 Forbidden', async () => {
      // Advance to IN_TEST
      await fetch(`${baseUrl}/api/tasks/task-role-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'BUILDING' }),
      });
      await fetch(`${baseUrl}/api/tasks/task-role-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'IN_REVIEW' }),
      });
      await fetch(`${baseUrl}/api/tasks/task-role-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'IN_TEST' }),
      });

      // Builder attempts to set DONE
      const res = await fetch(`${baseUrl}/api/tasks/task-role-1`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Role': 'builder',
        },
        body: JSON.stringify({ status: 'DONE' }),
      });
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.match(data.error, /not authorized/i);
    });

    it('refuses a Reviewer moving a card to DONE with 403 Forbidden', async () => {
      await fetch(`${baseUrl}/api/tasks/task-role-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'BUILDING' }),
      });
      await fetch(`${baseUrl}/api/tasks/task-role-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'IN_REVIEW' }),
      });
      await fetch(`${baseUrl}/api/tasks/task-role-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'IN_TEST' }),
      });

      const res = await fetch(`${baseUrl}/api/tasks/task-role-1`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Role': 'reviewer',
        },
        body: JSON.stringify({ status: 'DONE' }),
      });
      assert.equal(res.status, 403);
    });

    it('allows a Tester to move from IN_TEST to DONE', async () => {
      await fetch(`${baseUrl}/api/tasks/task-role-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'BUILDING' }),
      });
      await fetch(`${baseUrl}/api/tasks/task-role-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'IN_REVIEW' }),
      });
      await fetch(`${baseUrl}/api/tasks/task-role-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'IN_TEST' }),
      });

      const res = await fetch(`${baseUrl}/api/tasks/task-role-1`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Role': 'tester',
        },
        body: JSON.stringify({ status: 'DONE' }),
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).status, 'DONE');
    });
  });

  // --------------------------------------------------------------------------
  // KB-03: Claim Contention
  // --------------------------------------------------------------------------
  describe('KB-03: Claim Contention', () => {
    it('allows first agent to claim, but rejects second agent with 409 Conflict', async () => {
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'task-claim-1', title: 'Claim Contention Test' }),
      });

      // Agent-Alpha claims
      const claim1 = await fetch(`${baseUrl}/api/tasks/task-claim-1/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: 'Agent-Alpha' }),
      });
      assert.equal(claim1.status, 200);
      const task1 = await claim1.json();
      assert.equal(task1.assigned_agent, 'Agent-Alpha');
      assert.equal(task1.status, 'BUILDING');

      // Agent-Beta attempts to steal
      const claim2 = await fetch(`${baseUrl}/api/tasks/task-claim-1/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: 'Agent-Beta' }),
      });
      assert.equal(claim2.status, 409);
      const data2 = await claim2.json();
      assert.match(data2.error, /already claimed by Agent-Alpha/i);

      // Verify task still belongs to Agent-Alpha
      const verify = await fetch(`${baseUrl}/api/tasks/task-claim-1`);
      assert.equal((await verify.json()).assigned_agent, 'Agent-Alpha');
    });

    it('allows the same agent to re-claim idempotently', async () => {
      const claimAgain = await fetch(`${baseUrl}/api/tasks/task-claim-1/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: 'Agent-Alpha' }),
      });
      assert.equal(claimAgain.status, 200);
    });
  });

  // --------------------------------------------------------------------------
  // KB-04: API Authentication (A07)
  // --------------------------------------------------------------------------
  describe('KB-04: API Authentication', () => {
    let authServerInstance;
    let authBaseUrl;

    before(async () => {
      process.env.KANBAN_AUTH_TOKEN = 'test-secret-token-777';
      const authApp = createApp();
      const { server, baseUrl: url } = await startTestServer(authApp);
      authServerInstance = server;
      authBaseUrl = url;
    });

    after(async () => {
      delete process.env.KANBAN_AUTH_TOKEN;
      if (authServerInstance) {
        await new Promise((resolve) => authServerInstance.close(resolve));
      }
    });

    it('rejects unauthenticated mutating requests with 401 Unauthorized', async () => {
      const res = await fetch(`${authBaseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'auth-task-1', title: 'Auth Test' }),
      });
      assert.equal(res.status, 401);
    });

    it('rejects mutating requests with invalid token with 401 Unauthorized', async () => {
      const res = await fetch(`${authBaseUrl}/api/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-token',
        },
        body: JSON.stringify({ id: 'auth-task-1', title: 'Auth Test' }),
      });
      assert.equal(res.status, 401);
    });

    it('allows mutating requests with valid Bearer token', async () => {
      const res = await fetch(`${authBaseUrl}/api/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-secret-token-777',
        },
        body: JSON.stringify({ id: 'auth-task-1', title: 'Auth Test' }),
      });
      assert.equal(res.status, 201);
    });

    it('allows read requests without authentication', async () => {
      const res = await fetch(`${authBaseUrl}/api/tasks`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(await res.json()));
    });
  });

  // --------------------------------------------------------------------------
  // KB-05: Atomic Persistence
  // --------------------------------------------------------------------------
  describe('KB-05: Atomic Persistence', () => {
    it('writes to disk atomically without corrupting state', async () => {
      const atomicDir = await mkdtemp(path.join(os.tmpdir(), 'atomic-'));
      const atomicFile = path.join(atomicDir, 'atomic.json');
      const atomicStore = new store.JsonStorage(atomicFile);

      await atomicStore.save([{ id: 'T-1', title: 'One', status: 'BACKLOG' }]);
      assert.ok(existsSync(atomicFile));

      const content = await readFile(atomicFile, 'utf-8');
      const parsed = JSON.parse(content);
      assert.equal(parsed.tasks.length, 1);
      assert.equal(parsed.tasks[0].id, 'T-1');

      await rm(atomicDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // KB-08: Loop Statuses & Issues Register
  // --------------------------------------------------------------------------
  describe('KB-08: Loop Statuses & Issues Register', () => {
    it('tracks issues register on tasks', async () => {
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'task-issue-1',
          title: 'Issue Test',
          issues: ['ISS-001'],
        }),
      });

      const getRes = await fetch(`${baseUrl}/api/tasks/task-issue-1/issues`);
      assert.equal(getRes.status, 200);
      const data = await getRes.json();
      assert.deepEqual(data.issues, ['ISS-001']);

      // Add issue
      const addRes = await fetch(`${baseUrl}/api/tasks/task-issue-1/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue_id: 'ISS-002' }),
      });
      assert.equal(addRes.status, 200);
      const addedData = await addRes.json();
      assert.deepEqual(addedData.issues, ['ISS-001', 'ISS-002']);
    });
  });

  // --------------------------------------------------------------------------
  // KB-09: Pluggable Git-Backed Storage
  // --------------------------------------------------------------------------
  describe('KB-09: Git-Backed YAML Storage', () => {
    let gitDir;
    let gitServerInstance;
    let gitBaseUrl;

    before(async () => {
      gitDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-git-'));

      // Initialize git repo in gitDir to test auto-commit
      await execFileAsync('git', ['init'], { cwd: gitDir });
      await execFileAsync('git', ['config', 'user.name', 'Kanban Test'], { cwd: gitDir });
      await execFileAsync('git', ['config', 'user.email', 'kanban@test.local'], { cwd: gitDir });

      const gitStorage = new store.GitYamlStorage(gitDir, { autoCommit: true });
      store.setStorage(gitStorage);
      await store.loadStore();

      const gitApp = createApp();
      const { server, baseUrl: url } = await startTestServer(gitApp);
      gitServerInstance = server;
      gitBaseUrl = url;
    });

    after(async () => {
      if (gitServerInstance) {
        await new Promise((resolve) => gitServerInstance.close(resolve));
      }
      await rm(gitDir, { recursive: true, force: true });
    });

    it('creates and persists task as a YAML card matching spec Sec 3.2', async () => {
      const res = await fetch(`${gitBaseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'P1-04',
          title: 'Adapter #1, daily bars',
          status: 'BACKLOG',
          depends_on: ['P1-03', 'P0-05'],
        }),
      });
      assert.equal(res.status, 201);

      const cardPath = path.join(gitDir, 'P1-04.yml');
      assert.ok(existsSync(cardPath), 'P1-04.yml card must exist on disk');

      const raw = await readFile(cardPath, 'utf-8');
      const card = yaml.parse(raw);
      assert.equal(card.id, 'P1-04');
      assert.equal(card.title, 'Adapter #1, daily bars');
      assert.equal(card.status, 'BACKLOG');
      assert.deepEqual(card.depends_on, ['P1-03', 'P0-05']);
    });

    it('commits git transition when task status is updated', async () => {
      const patchRes = await fetch(`${gitBaseUrl}/api/tasks/P1-04`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'BUILDING' }),
      });
      assert.equal(patchRes.status, 200);

      const { stdout } = await execFileAsync('git', ['log', '-1', '--oneline'], {
        cwd: gitDir,
      });
      assert.match(stdout, /ops\(P1-04\): kanban BUILDING/);
    });

    it('reloads tasks correctly on cold boot from YAML store', async () => {
      const freshStorage = new store.GitYamlStorage(gitDir);
      const loaded = await freshStorage.load();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].id, 'P1-04');
      assert.equal(loaded[0].status, 'BUILDING');
    });
  });
});
