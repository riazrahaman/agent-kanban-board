/**
 * ADR-006 — the `role_crossing` audit signal and its per-deployment kill switch.
 *
 * The signal fires when ONE agent_id presents BOUND credentials for MORE THAN
 * ONE role on the same project. It is a REVIEW PROMPT, never a rejection: the
 * server can prove which roles an agent held, not why.
 *
 * The switch is `KANBAN_ROLE_CROSSING_AUDIT`, same flag shape as
 * `KANBAN_AUDIT_LOG` (unset/''/'0'/'false' = OFF, anything else = ON), and it
 * is **OFF by default** — the whole point of the ADR: enabling the signal is a
 * deliberate per-deployment decision, because unlike `role_binding_mismatch`
 * (rare by construction) a crossing is easy to produce legitimately.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { resetRateLimits } from '../middleware/rateLimit.js';
import { roleCrossingAuditEnabled, resetRoleCrossings } from '../utils/roleCrossing.js';
import * as store from '../store.js';

const PROJECT = 'cross';
const CREDENTIALS = {
  builder: 'tok-builder',
  reviewer: 'tok-reviewer',
  tester: 'tok-tester',
  legacy: 'tok-legacy',
  otherReviewer: 'tok-other-reviewer',
};
const ADMIN_TOKEN = 'tok-admin';

const PROJECT_TOKENS = JSON.stringify({
  [PROJECT]: {
    credentials: [
      { token: CREDENTIALS.builder, role: 'builder' },
      { token: CREDENTIALS.reviewer, role: 'reviewer' },
      { token: CREDENTIALS.tester, role: 'tester' },
      { token: CREDENTIALS.legacy },
    ],
  },
  // A second project, so the per-project scoping of the signal can be pinned.
  other: {
    credentials: [{ token: CREDENTIALS.otherReviewer, role: 'reviewer' }],
  },
});

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function headers(token, role, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(role ? { 'X-Agent-Role': role } : {}),
    ...extra,
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

describe('ADR-006 — role_crossing audit signal (off by default)', () => {
  let tmpDir;
  let server;
  let baseUrl;
  const auditEntries = [];
  let auditListener;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_AUTH_TOKEN;
    process.env.KANBAN_DATA_DIR = tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-rolecross-'));
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_PROJECT_TOKENS = PROJECT_TOKENS;
    process.env.KANBAN_ADMIN_TOKEN = ADMIN_TOKEN;
    await store.loadStore();
    auditListener = (entry) => auditEntries.push(entry);
    store.onAudit(auditListener);
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  after(async () => {
    if (auditListener) store.offAudit?.(auditListener);
    delete process.env.KANBAN_PROJECT_TOKENS;
    delete process.env.KANBAN_ADMIN_TOKEN;
    delete process.env.KANBAN_ROLE_CROSSING_AUDIT;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    auditEntries.length = 0;
    resetRoleCrossings();
    resetRateLimits();
    delete process.env.KANBAN_ROLE_CROSSING_AUDIT;
  });

  /** admin-token helper: create a task in BACKLOG */
  const makeTask = async (id) => {
    const created = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, 'admin'),
      body: JSON.stringify({ id, project: PROJECT, title: id, status: 'BACKLOG', round: 1 }),
    });
    assert.equal(created.response.status, 201, `create ${id}`);
    return id;
  };

  /** A mutation with a bound credential and a given agent identity. */
  const mutateAs = async (id, token, agentId, role) => {
    const current = await jsonRequest(baseUrl, `/api/tasks/${id}?project=${PROJECT}`, {
      headers: headers(ADMIN_TOKEN, 'admin'),
    });
    return jsonRequest(baseUrl, `/api/tasks/${id}?project=${PROJECT}`, {
      method: 'PATCH',
      headers: headers(token, role, { 'X-Agent-Id': agentId }),
      body: JSON.stringify({ title: `${id} touched`, expected_version: current.body.version }),
    });
  };

  const crossings = () => auditEntries.filter((entry) => entry.kind === 'role_crossing');

  describe('flag shape', () => {
    it('is OFF by default (unset) — a deployment that never opted in is unchanged', () => {
      assert.equal(roleCrossingAuditEnabled(undefined), false);
    });

    it('treats empty, 0 and false as OFF (same shape as KANBAN_AUDIT_LOG)', () => {
      assert.equal(roleCrossingAuditEnabled(''), false);
      assert.equal(roleCrossingAuditEnabled('0'), false);
      assert.equal(roleCrossingAuditEnabled('false'), false);
      assert.equal(roleCrossingAuditEnabled('FALSE'), false);
    });

    it('treats any other value as ON', () => {
      assert.equal(roleCrossingAuditEnabled('1'), true);
      assert.equal(roleCrossingAuditEnabled('true'), true);
      assert.equal(roleCrossingAuditEnabled('on'), true);
    });
  });

  describe('default behaviour (signal disabled)', () => {
    it('emits no role_crossing event when the flag is unset', async () => {
      const id = await makeTask('rc-off');
      const first = await mutateAs(id, CREDENTIALS.builder, 'agent-1');
      assert.equal(first.response.status, 200);
      const second = await mutateAs(id, CREDENTIALS.reviewer, 'agent-1');
      assert.equal(second.response.status, 200);
      assert.equal(crossings().length, 0, 'no crossing events while the signal is off');
    });

    it('still serves the request normally (the switch only governs emission)', async () => {
      const id = await makeTask('rc-off-ok');
      const first = await mutateAs(id, CREDENTIALS.builder, 'agent-1');
      assert.equal(first.response.status, 200);
      const second = await mutateAs(id, CREDENTIALS.reviewer, 'agent-1');
      assert.equal(second.response.status, 200);
    });
  });

  describe('enabled', () => {
    beforeEach(() => {
      process.env.KANBAN_ROLE_CROSSING_AUDIT = '1';
    });

    it('emits a role_crossing event when one agent presents a second bound role', async () => {
      const id = await makeTask('rc-cross');
      const first = await mutateAs(id, CREDENTIALS.builder, 'agent-1');
      assert.equal(first.response.status, 200);
      assert.equal(crossings().length, 0, 'the first role is not a crossing');

      const second = await mutateAs(id, CREDENTIALS.reviewer, 'agent-1');
      assert.equal(second.response.status, 200, 'the request is still served');
      const events = crossings();
      assert.equal(events.length, 1, 'exactly one crossing event');
      assert.equal(events[0].project, PROJECT);
      assert.equal(events[0].actor, 'agent-1');
      assert.match(events[0].reason, /builder/);
      assert.match(events[0].reason, /reviewer/);
    });

    it('does not re-emit when the same agent presents the SAME role again', async () => {
      const id = await makeTask('rc-same');
      await mutateAs(id, CREDENTIALS.builder, 'agent-1');
      await mutateAs(id, CREDENTIALS.builder, 'agent-1');
      await mutateAs(id, CREDENTIALS.builder, 'agent-1');
      assert.equal(crossings().length, 0);
    });

    it('does not emit when DIFFERENT agents present different roles', async () => {
      const id = await makeTask('rc-agents');
      await mutateAs(id, CREDENTIALS.builder, 'agent-1');
      await mutateAs(id, CREDENTIALS.reviewer, 'agent-2');
      assert.equal(crossings().length, 0, 'separate identities are not a crossing');
    });

    it('does not emit for a legacy UNBOUND credential (header role is not a bound role)', async () => {
      const id = await makeTask('rc-legacy');
      await mutateAs(id, CREDENTIALS.legacy, 'agent-1', 'builder');
      await mutateAs(id, CREDENTIALS.legacy, 'agent-1', 'reviewer');
      assert.equal(crossings().length, 0);
    });

    it('does not emit for the admin token (privileged path is not tracked)', async () => {
      const id = await makeTask('rc-admin');
      await mutateAs(id, ADMIN_TOKEN, 'admin-agent');
      await mutateAs(id, ADMIN_TOKEN, 'admin-agent');
      assert.equal(crossings().length, 0);
    });

    it('keeps the scope per project — the same agent on another project is not a crossing', async () => {
      const id = await makeTask('rc-scope');
      await mutateAs(id, CREDENTIALS.builder, 'agent-1');
      // The same agent id presenting a different role on a DIFFERENT project
      // must not be reported as a crossing on this project.
      const other = await jsonRequest(baseUrl, '/api/tasks', {
        method: 'POST',
        headers: headers(ADMIN_TOKEN, 'admin'),
        body: JSON.stringify({
          id: 'rc-scope-2',
          project: 'other',
          title: 'rc-scope-2',
          status: 'BACKLOG',
          round: 1,
        }),
      });
      assert.equal(other.response.status, 201);
      const otherPatch = await jsonRequest(baseUrl, '/api/tasks/rc-scope-2?project=other', {
        method: 'PATCH',
        headers: headers(CREDENTIALS.otherReviewer, null, { 'X-Agent-Id': 'agent-1' }),
        body: JSON.stringify({ title: 'touched', expected_version: 1 }),
      });
      assert.equal(otherPatch.response.status, 200);
      assert.equal(crossings().length, 0);
    });

    it('never leaks a token value into the event', async () => {
      const id = await makeTask('rc-redact');
      await mutateAs(id, CREDENTIALS.builder, 'agent-1');
      await mutateAs(id, CREDENTIALS.reviewer, 'agent-1');
      const serialized = JSON.stringify(crossings());
      assert.ok(!serialized.includes(CREDENTIALS.builder), 'builder token must not appear');
      assert.ok(!serialized.includes(CREDENTIALS.reviewer), 'reviewer token must not appear');
      assert.ok(!serialized.includes(ADMIN_TOKEN), 'admin token must not appear');
    });
  });
});
