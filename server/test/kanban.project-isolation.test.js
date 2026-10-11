/**
 * §2.11 — Per-token project name isolation on shared multi-client boards.
 *
 * Verifies that:
 * 1. Admin token has full oversight across all projects in /api/projects, /api/health, and /api/tasks.
 * 2. Project-scoped tokens in KANBAN_PROJECT_TOKENS only see their authorized project in /api/projects.
 * 3. GET /api/health with a project-scoped token filters credential_map.missing and extra to only that project.
 * 4. Unscoped GET /api/tasks with a project-scoped token only returns tasks for the authorized project.
 * 5. Scoped GET /api/tasks for a foreign project with a project-scoped token returns an empty array.
 * 6. Anonymous callers under isolation receive an empty list [] from /api/projects (or 401 when read-auth enabled).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import * as store from '../store.js';

const ADMIN_TOKEN = 'tok-admin-secret';
const ALPHA_TOKEN = 'tok-alpha-secret';
const BETA_TOKEN = 'tok-beta-secret';

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function headers(token, role = 'builder') {
  return {
    ...(token ? { 'x-api-token': token } : {}),
    'Content-Type': 'application/json',
    ...(role ? { 'X-Agent-Role': role } : {}),
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

describe('§2.11 per-token project name isolation', () => {
  let tmpDir;
  let server;
  let baseUrl;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_ARCHIVE_AFTER_DAYS;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-isolation-'));

    process.env.KANBAN_ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.KANBAN_PROJECT_TOKENS = JSON.stringify({
      alpha: ALPHA_TOKEN,
      beta: BETA_TOKEN,
      ghost: 'tok-ghost', // in token map, but no store project yet (extra)
    });

    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    await store.loadStore();

    // Create tasks in alpha, beta, and gamma (gamma has no token in map -> missing)
    await store.createTask({ id: 't-a1', title: 'Alpha task 1', status: 'BACKLOG', project: 'alpha', round: 1 });
    await store.createTask({ id: 't-b1', title: 'Beta task 1', status: 'BACKLOG', project: 'beta', round: 1 });
    await store.createTask({ id: 't-g1', title: 'Gamma task 1', status: 'BACKLOG', project: 'gamma', round: 1 });

    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.KANBAN_ADMIN_TOKEN;
    delete process.env.KANBAN_PROJECT_TOKENS;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    store.setStorage(null);
  });

  describe('GET /api/projects isolation', () => {
    it('1. Admin token receives all project summaries in GET /api/projects', async () => {
      const { response, body } = await jsonRequest(baseUrl, '/api/projects', {
        headers: headers(ADMIN_TOKEN),
      });
      assert.equal(response.status, 200);
      assert.ok(Array.isArray(body));
      const projects = body.map((p) => p.project);
      assert.ok(projects.includes('alpha'));
      assert.ok(projects.includes('beta'));
      assert.ok(projects.includes('gamma'));
    });

    it('2. Alpha token only receives project "alpha" in GET /api/projects', async () => {
      const { response, body } = await jsonRequest(baseUrl, '/api/projects', {
        headers: headers(ALPHA_TOKEN),
      });
      assert.equal(response.status, 200);
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 1);
      assert.equal(body[0].project, 'alpha');
    });

    it('3. Beta token only receives project "beta" in GET /api/projects', async () => {
      const { response, body } = await jsonRequest(baseUrl, '/api/projects', {
        headers: headers(BETA_TOKEN),
      });
      assert.equal(response.status, 200);
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 1);
      assert.equal(body[0].project, 'beta');
    });

    it('4. Anonymous caller receives empty array [] under isolation mode', async () => {
      const { response, body } = await jsonRequest(baseUrl, '/api/projects');
      assert.equal(response.status, 200);
      assert.deepEqual(body, []);
    });

    it('5. Invalid token caller receives empty array [] under isolation mode', async () => {
      const { response, body } = await jsonRequest(baseUrl, '/api/projects', {
        headers: headers('invalid-token-xyz'),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(body, []);
    });
  });

  describe('GET /api/health credential map isolation', () => {
    it('6. Admin token receives all missing and extra projects in /api/health', async () => {
      const { response, body } = await jsonRequest(baseUrl, '/api/health', {
        headers: headers(ADMIN_TOKEN),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(body.credential_map.missing, ['gamma']);
      assert.deepEqual(body.credential_map.extra, ['ghost']);
    });

    it('7. Alpha token does not see gamma in missing or ghost in extra', async () => {
      const { response, body } = await jsonRequest(baseUrl, '/api/health', {
        headers: headers(ALPHA_TOKEN),
      });
      assert.equal(response.status, 200);
      // alpha is neither missing nor extra
      assert.deepEqual(body.credential_map.missing, []);
      assert.deepEqual(body.credential_map.extra, []);
    });

    it('8. Anonymous caller omits missing and extra arrays completely', async () => {
      const { response, body } = await jsonRequest(baseUrl, '/api/health');
      assert.equal(response.status, 200);
      assert.equal('missing' in body.credential_map, false);
      assert.equal('extra' in body.credential_map, false);
      assert.equal(body.credential_map.missing_count, 1);
      assert.equal(body.credential_map.extra_count, 1);
    });
  });

  describe('GET /api/tasks scoping isolation', () => {
    it('9. Unscoped GET /api/tasks with Alpha token only returns alpha tasks', async () => {
      const { response, body } = await jsonRequest(baseUrl, '/api/tasks', {
        headers: headers(ALPHA_TOKEN),
      });
      assert.equal(response.status, 200);
      assert.ok(Array.isArray(body));
      assert.equal(body.length, 1);
      assert.equal(body[0].project, 'alpha');
    });

    it('10. Foreign project query GET /api/tasks?project=beta with Alpha token returns empty array', async () => {
      const { response, body } = await jsonRequest(baseUrl, '/api/tasks?project=beta', {
        headers: headers(ALPHA_TOKEN),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(body, []);
    });

    it('11. Unscoped GET /api/tasks with Admin token returns all tasks', async () => {
      const { response, body } = await jsonRequest(baseUrl, '/api/tasks', {
        headers: headers(ADMIN_TOKEN),
      });
      assert.equal(response.status, 200);
      assert.ok(Array.isArray(body));
      const projects = new Set(body.map((t) => t.project));
      assert.ok(projects.has('alpha'));
      assert.ok(projects.has('beta'));
      assert.ok(projects.has('gamma'));
    });
  });
});
