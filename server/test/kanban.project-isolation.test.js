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

  // A4 (v3.12.2): /api/tasks/archive, /api/tasks/trash and POST
  // /api/tasks/archive/sweep used to ignore getAuthorizedProjects entirely — a
  // project-scoped credential could read every project's archive and trash and
  // sweep the whole board. These cases pin the clamp.
  describe('archive / trash / sweep scoping (v3.12.2 A4)', () => {
    const daysAgoIso = (d) => new Date(Date.now() - d * 86400000).toISOString();

    async function driveToDone(id, project) {
      const steps = [
        { role: 'builder', status: 'IN_PROGRESS' },
        { role: 'builder', status: 'IN_REVIEW' },
        { role: 'reviewer', status: 'VALIDATION' },
        { role: 'tester', status: 'READY_TO_SHIP' },
        { role: 'releaser', status: 'DONE' },
      ];
      for (const { role, status } of steps) {
        const r = await jsonRequest(baseUrl, `/api/tasks/${id}?project=${project}`, {
          method: 'PATCH', headers: headers(project === 'alpha' ? ALPHA_TOKEN : BETA_TOKEN, role),
          body: JSON.stringify({ status }),
        });
        assert.equal(r.response.status, 200, `${id}: step ${status} -> ${r.body?.error || 'ok'}`);
      }
    }

    async function backdate(id, project, days = 40) {
      const task = store.getTask(id, project);
      assert.ok(task, `${project}/${id} exists`);
      const past = daysAgoIso(days);
      task.completed_at = past;
      task.created_at = task.created_at || past;
      await store.getStorage(project).saveTask(task, store.getProjectBucket(project));
    }

    before(async () => {
      // Two old DONE cards (one per project) that the ADMIN sweep archives, so
      // both sinks start populated.
      for (const [project, token, id] of [['alpha', ALPHA_TOKEN, 'a-arch-1'], ['beta', BETA_TOKEN, 'b-arch-1']]) {
        const created = await jsonRequest(baseUrl, `/api/tasks?project=${project}`, {
          method: 'POST', headers: headers(token), body: JSON.stringify({ id, title: id, status: 'READY', round: 1 }),
        });
        assert.equal(created.response.status, 201);
        await driveToDone(id, project);
        await backdate(id, project);
      }
      const adminSweep = await jsonRequest(baseUrl, '/api/tasks/archive/sweep', {
        method: 'POST', headers: headers(ADMIN_TOKEN),
      });
      assert.equal(adminSweep.response.status, 200);
      assert.ok(adminSweep.body.moved >= 2, 'the admin sweep archived both');

      // One soft-deleted card per project in the trash sink (deleteTask is
      // admin-only, so the admin token parks them).
      for (const [project, id] of [['alpha', 'a-del-1'], ['beta', 'b-del-1']]) {
        const created = await jsonRequest(baseUrl, `/api/tasks?project=${project}`, {
          method: 'POST', headers: headers(ADMIN_TOKEN), body: JSON.stringify({ id, title: id, status: 'READY', round: 1 }),
        });
        assert.equal(created.response.status, 201);
        const del = await jsonRequest(baseUrl, `/api/tasks/${id}?project=${project}`, {
          method: 'DELETE', headers: headers(ADMIN_TOKEN),
        });
        assert.equal(del.response.status, 200, `${id} soft-deleted to trash`);
      }
    });

    it('12. alpha token /archive sees only alpha cards', async () => {
      const { response, body } = await jsonRequest(baseUrl, '/api/tasks/archive', {
        headers: headers(ALPHA_TOKEN),
      });
      assert.equal(response.status, 200);
      assert.ok(Array.isArray(body));
      const ids = body.map((t) => t.id);
      assert.ok(ids.includes('a-arch-1'), 'own archived card visible');
      assert.ok(!ids.includes('b-arch-1'), "another project's archived card hidden");
      for (const t of body) assert.equal(t.project, 'alpha');
    });

    it('13. alpha token /archive?project=beta returns []', async () => {
      const { response, body } = await jsonRequest(baseUrl, '/api/tasks/archive?project=beta', {
        headers: headers(ALPHA_TOKEN),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(body, []);
    });

    it('14. alpha token /trash sees only alpha cards', async () => {
      const { response, body } = await jsonRequest(baseUrl, '/api/tasks/trash', {
        headers: headers(ALPHA_TOKEN),
      });
      assert.equal(response.status, 200);
      const ids = body.map((t) => t.id);
      assert.ok(ids.includes('a-del-1'), 'own trashed card visible');
      assert.ok(!ids.includes('b-del-1'), "another project's trashed card hidden");
    });

    it('15. alpha token /trash?project=beta returns []', async () => {
      const { response, body } = await jsonRequest(baseUrl, '/api/tasks/trash?project=beta', {
        headers: headers(ALPHA_TOKEN),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(body, []);
    });

    it('16. unscoped admin token sees every project in /archive and /trash', async () => {
      const arch = await jsonRequest(baseUrl, '/api/tasks/archive', { headers: headers(ADMIN_TOKEN) });
      assert.equal(arch.response.status, 200);
      const archIds = arch.body.map((t) => t.id);
      assert.ok(archIds.includes('a-arch-1'));
      assert.ok(archIds.includes('b-arch-1'));

      const trash = await jsonRequest(baseUrl, '/api/tasks/trash', { headers: headers(ADMIN_TOKEN) });
      assert.equal(trash.response.status, 200);
      const trashIds = trash.body.map((t) => t.id);
      assert.ok(trashIds.includes('a-del-1'));
      assert.ok(trashIds.includes('b-del-1'));
    });

    it('17. a scoped sweep moves ONLY the authorized project and reports only it', async () => {
      // One fresh eligible card per project, backdated right before the sweep —
      // no GET runs in between, so no lazy sweep can pre-move either card.
      for (const [project, token, id] of [['alpha', ALPHA_TOKEN, 'a-sweep'], ['beta', BETA_TOKEN, 'b-sweep']]) {
        const created = await jsonRequest(baseUrl, `/api/tasks?project=${project}`, {
          method: 'POST', headers: headers(token), body: JSON.stringify({ id, title: id, status: 'READY', round: 1 }),
        });
        assert.equal(created.response.status, 201);
        await driveToDone(id, project);
        await backdate(id, project);
      }

      // A scoped credential references one of its own projects (the mutation
      // guard requires it — an unscoped mutation resolves to `default`); the
      // sweep still covers the token's WHOLE authorized set, which for this
      // single-project token is exactly alpha.
      const r = await jsonRequest(baseUrl, '/api/tasks/archive/sweep?project=alpha', {
        method: 'POST', headers: headers(ALPHA_TOKEN),
      });
      assert.equal(r.response.status, 200);
      assert.equal(r.body.moved, 1, 'only the alpha card moved');
      const reported = r.body.projects.map((p) => p.project);
      assert.ok(reported.includes('alpha'), 'the authorized project is reported');
      assert.ok(!reported.includes('beta'), "another project's summary is clamped out");

      assert.ok(store.getArchivedTasks('alpha').some((t) => t.id === 'a-sweep'), 'alpha card archived');
      assert.ok(store.getTask('b-sweep', 'beta'), "beta's eligible card was NOT touched by the scoped sweep");
    });

    it('18. the unscoped admin sweep still sees every project', async () => {
      const r = await jsonRequest(baseUrl, '/api/tasks/archive/sweep', {
        method: 'POST', headers: headers(ADMIN_TOKEN),
      });
      assert.equal(r.response.status, 200);
      assert.ok(r.body.moved >= 1, "beta's card moved under the unscoped sweep");
      const reported = new Set(r.body.projects.map((p) => p.project));
      assert.ok(reported.has('alpha'));
      assert.ok(reported.has('beta'));
      assert.ok(store.getArchivedTasks('beta').some((t) => t.id === 'b-sweep'), 'beta card archived');
    });
  });
});
