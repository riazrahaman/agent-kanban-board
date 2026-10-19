/**
 * v3.8.0 — credential-bound roles (SEC: role derived from token, not header).
 *
 * The failure this suite pins down: roles used to be caller-DECLARED (X-Agent-Role
 * header or body role), so one agent could self-approve through every stage.
 * Now the role comes from the credential in KANBAN_PROJECT_TOKENS:
 *   - a role-bound credential FORCES req.caller.role; a conflicting
 *     X-Agent-Role is ignored and audited (role_binding_mismatch)
 *   - the admin token derives role 'admin' from the credential
 *   - a body 'role' field is rejected on PATCH (400) and ignored as identity
 *   - legacy unbound credentials keep the old header semantics
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { parseProjectTokens } from '../middleware/auth.js';
import { resetRateLimits } from '../middleware/rateLimit.js';
import { reportCredentialCoverage } from '../utils/credentialMap.js';
import * as store from '../store.js';

const PROJECT = 'pipe';
const CREDENTIALS = {
  builder: 'tok-builder',
  reviewer: 'tok-reviewer',
  tester: 'tok-tester',
  releaser: 'tok-releaser',
  legacy: 'tok-legacy', // unbound credential — header semantics preserved
};
const ADMIN_TOKEN = 'tok-admin';

const PROJECT_TOKENS = JSON.stringify({
  [PROJECT]: {
    credentials: [
      { token: CREDENTIALS.builder, role: 'builder' },
      { token: CREDENTIALS.reviewer, role: 'reviewer' },
      { token: CREDENTIALS.tester, role: 'tester' },
      { token: CREDENTIALS.releaser, role: 'releaser' },
      { token: CREDENTIALS.legacy },
    ],
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

describe('§2.3d — credential-bound roles (v3.8.0)', () => {
  let tmpDir;
  let server;
  let baseUrl;
  const auditEntries = [];
  let auditListener;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    delete process.env.KANBAN_AUTH_TOKEN; // per-project mode only
    delete process.env.KANBAN_SESSION_SECRET; // no session path interference
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-rolebound-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
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
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  /** admin-token helper: create + promote a task to READY */
  const makeReadyTask = async (id) => {
    const created = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, 'admin'),
      body: JSON.stringify({ id, project: PROJECT, title: id, status: 'BACKLOG', round: 1 }),
    });
    assert.equal(created.response.status, 201, `create ${id}`);
    const promoted = await jsonRequest(baseUrl, `/api/tasks/${id}?project=${PROJECT}`, {
      method: 'PATCH',
      headers: headers(ADMIN_TOKEN, 'admin'),
      body: JSON.stringify({ status: 'READY', expected_version: 1 }),
    });
    assert.equal(promoted.response.status, 200, `promote ${id} to READY`);
    return id;
  };

  /** GET fresh version, then PATCH status with a given credential */
  const patchStatus = async (id, token, role, status, extra = {}) => {
    const current = await jsonRequest(baseUrl, `/api/tasks/${id}?project=${PROJECT}`, {
      headers: headers(ADMIN_TOKEN, 'admin'),
    });
    assert.equal(current.response.status, 200);
    return jsonRequest(baseUrl, `/api/tasks/${id}?project=${PROJECT}`, {
      method: 'PATCH',
      headers: headers(token, role, extra.headers || {}),
      body: JSON.stringify({ status, expected_version: current.body.version, ...extra.body }),
    });
  };

  const claim = async (id, token, role, body = {}) =>
    jsonRequest(baseUrl, `/api/tasks/${id}/claim?project=${PROJECT}`, {
      method: 'POST',
      headers: headers(token, role),
      body: JSON.stringify({ agent_id: `agent-${role || 'x'}`, ...body }),
    });

  it('A1. a bound credential FORCES the role: builder token + reviewer header is 403 at the reviewer gate', async () => {
    const id = await makeReadyTask('a1-force');
    const claimed = await claim(id, CREDENTIALS.builder, 'reviewer'); // WRONG header, bound builder
    assert.equal(claimed.response.status, 200, 'claim succeeds with the credential role despite the wrong header');
    assert.equal(claimed.body.status, 'IN_PROGRESS');

    // Bound builder walks its own gate…
    const own = await patchStatus(id, CREDENTIALS.builder, null, 'IN_REVIEW');
    assert.equal(own.response.status, 200, 'bound builder can move IN_PROGRESS -> IN_REVIEW with NO header');

    // …but is 403 at the reviewer gate, even while declaring 'reviewer'.
    const gate = await patchStatus(id, CREDENTIALS.builder, 'reviewer', 'VALIDATION');
    assert.equal(gate.response.status, 403);
    assert.match(
      gate.body.error,
      /Role 'builder' is not authorized to transition task from IN_REVIEW to VALIDATION/,
      'the BOUND role is enforced — the header never reaches the state machine'
    );
  });

  it('A2. a conflicting header is audited as role_binding_mismatch, and the served role is the bound one', async () => {
    const before = auditEntries.length;
    const id = await makeReadyTask('a2-audit');
    await claim(id, CREDENTIALS.builder, 'reviewer');
    const mismatches = auditEntries.slice(before).filter((e) => e.kind === 'role_binding_mismatch');
    assert.ok(mismatches.length >= 1, 'a role_binding_mismatch audit entry was emitted');
    const entry = mismatches[mismatches.length - 1];
    assert.equal(entry.project, PROJECT);
    assert.equal(entry.actor, 'agent-reviewer');
    assert.match(entry.reason, /declared 'reviewer' conflicts with credential-bound role 'builder'/);
    // Never echoes the credential value:
    assert.ok(!JSON.stringify(entry).includes(CREDENTIALS.builder), 'no token value in the audit entry');
  });

  it("A3. a garbled/absent header does not break a bound credential (the credential is the authority)", async () => {
    const id = await makeReadyTask('a3-noheader');
    const claimed = await claim(id, CREDENTIALS.builder, 'totally-bogus');
    assert.equal(claimed.response.status, 200, 'garbled header is ignored; bound builder still claims');
    assert.equal(claimed.body.status, 'IN_PROGRESS');
  });

  it('A4. a body role is never identity: claim body {role:"admin"} on a bound builder proceeds as builder', async () => {
    const id = await makeReadyTask('a4-bodyrole');
    const r = await jsonRequest(baseUrl, `/api/tasks/${id}/claim?project=${PROJECT}`, {
      method: 'POST',
      headers: headers(CREDENTIALS.builder), // token only; role smuggled in body
      body: JSON.stringify({ agent_id: 'agent-smuggle', role: 'admin' }),
    });
    assert.equal(r.response.status, 200);
    assert.equal(r.body.assigned_agent, 'agent-smuggle');
    assert.equal(r.body.status, 'IN_PROGRESS', 'the bound builder role claimed it — body role ignored');
  });

  it('A5. the admin token DERIVES role admin; a conflicting header is recorded, and the credential still confers privilege', async () => {
    const before = auditEntries.length;
    const id = await makeReadyTask('a5-admin');
    // Admin bypasses transitions; header says 'builder' — serve, but audited:
    const r = await patchStatus(id, ADMIN_TOKEN, 'builder', 'BACKLOG');
    assert.equal(r.response.status, 200, 'admin bypasses the state machine regardless of the header');
    const mismatches = auditEntries.slice(before).filter((e) => e.kind === 'role_binding_mismatch');
    assert.ok(mismatches.length >= 1, 'admin header-conflict is audited');
    assert.match(mismatches[mismatches.length - 1].reason, /declared 'builder' conflicts with credential-bound role 'admin'/);

    // privilege really comes from the credential: delete a task (§2.3b gate) with a bogus header.
    const spare = await makeReadyTask('a5-spare');
    const del = await jsonRequest(baseUrl, `/api/tasks/${spare}?project=${PROJECT}`, {
      method: 'DELETE',
      headers: headers(ADMIN_TOKEN, 'builder', { 'X-Agent-Id': 'agent-admin' }),
    });
    assert.equal(del.response.status, 200, 'admin credential is privileged even with a wrong header');
  });

  it('A6. legacy unbound credential keeps the historical header semantics', async () => {
    const id = await makeReadyTask('a6-legacy');
    const claimed = await claim(id, CREDENTIALS.legacy, 'reviewer');
    assert.equal(claimed.response.status, 200, 'legacy token + header reviewer claims as reviewer');
    assert.equal(claimed.body.status, 'IN_PROGRESS');
    const walk = await patchStatus(id, CREDENTIALS.legacy, 'runner', 'IN_REVIEW');
    assert.equal(walk.response.status, 200, 'legacy header role runner still bypasses transitions');
    });

  it('B1. patchTask rejects a body "role" field with 400 (the old side door is closed), even for admin callers', async () => {
    const id = await makeReadyTask('b1-side1');
    const r = await patchStatus(id, CREDENTIALS.builder, null, 'IN_REVIEW', {
      body: { role: 'admin' },
    });
    assert.equal(r.response.status, 400);
    assert.match(r.body.error, /role is not mutable/);
    // The gate fires BEFORE the version/transition logic:
    const current = await jsonRequest(baseUrl, `/api/tasks/${id}?project=${PROJECT}`, {
      headers: headers(ADMIN_TOKEN, 'admin'),
    });
    assert.equal(current.body.status, 'READY', 'the task was not touched');
  });

  it('B2. the drop of the caller.role || patch.role fallback: body role cannot authorize a transition', async () => {
    const id = await makeReadyTask('b2-side2');
    // Legacy unbound token, NO header, body role admin — historically this
    // would walk every stage. Now the body no longer feeds identity at all:
    // the middleware 403s before the body can matter.
    const smuggled = await patchStatus(id, CREDENTIALS.legacy, null, 'IN_REVIEW', {
      body: { role: 'admin' },
    });
    assert.equal(smuggled.response.status, 403);
    assert.match(smuggled.body.error, /A valid agent role is required for mutating operations/);
    // And with a valid header role present, the body role is rejected outright
    // (400) — it can never override or supplement the caller's role.
    const rejected = await patchStatus(id, CREDENTIALS.legacy, 'builder', 'IN_REVIEW', {
      body: { role: 'admin' },
    });
    assert.equal(rejected.response.status, 400);
    assert.match(rejected.body.error, /role is not mutable/);
    const current = await jsonRequest(baseUrl, `/api/tasks/${id}?project=${PROJECT}`, {
      headers: headers(ADMIN_TOKEN, 'admin'),
    });
    assert.equal(current.body.status, 'READY');
  });

  it('B3. role-less mutation is rejected at the auth layer; header and bound roles still update settings', async () => {
    const settingsBody = JSON.stringify({ column_colors: {} });
    const noRole = await jsonRequest(baseUrl, '/api/settings?project=' + PROJECT, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${CREDENTIALS.legacy}`, 'Content-Type': 'application/json' },
      body: settingsBody,
    });
    assert.equal(noRole.response.status, 403, 'unbound credential without a header has no role at all');
    assert.match(noRole.body.error, /A valid agent role is required for mutating operations/);
    const withRole = await jsonRequest(baseUrl, '/api/settings?project=' + PROJECT, {
      method: 'PUT',
      headers: headers(CREDENTIALS.legacy, 'human'),
      body: settingsBody,
    });
    assert.equal(withRole.response.status, 200, 'legacy credential + header human is accepted');
    const bound = await jsonRequest(baseUrl, '/api/settings?project=' + PROJECT, {
      method: 'PUT',
      headers: headers(CREDENTIALS.builder), // bound builder, no header
      body: settingsBody,
    });
    assert.equal(bound.response.status, 200, 'a bound credential carries its role with no header');
  });

  it('C. the full pipeline hop x role matrix — each stage gate accepts only its role', async () => {
    const claimVersion = async (id, token, role) => {
      const claimed = await claim(id, token, role);
      assert.equal(claimed.response.status, 200, `${role} claims ${id}`);
      return claimed.body;
    };

    // t-builder: builder walks its two hops, then CANNOT reach VALIDATION.
    await makeReadyTask('c-builder');
    await claimVersion('c-builder', CREDENTIALS.builder, 'reviewer');
    assert.equal((await patchStatus('c-builder', CREDENTIALS.builder, null, 'IN_REVIEW')).response.status, 200);
    assert.equal((await patchStatus('c-builder', CREDENTIALS.builder, 'reviewer', 'VALIDATION')).response.status, 403);

    // t-reviewer: reviewer cannot do the builder hop, but owns its own hop.
    // patchTask has no holder gate (only renew/heartbeat do), so the reviewer
    // patches the builder-owned card directly — claim stays with the builder.
    await makeReadyTask('c-reviewer');
    await claimVersion('c-reviewer', CREDENTIALS.reviewer, 'builder');
    assert.equal((await patchStatus('c-reviewer', CREDENTIALS.reviewer, 'builder', 'IN_REVIEW')).response.status, 403,
      'reviewer cannot do the builder hop');
    assert.equal((await patchStatus('c-reviewer', ADMIN_TOKEN, 'admin', 'IN_REVIEW')).response.status, 200,
      'admin moves the card into review');
    assert.equal((await patchStatus('c-reviewer', CREDENTIALS.reviewer, 'builder', 'VALIDATION')).response.status, 200,
      'reviewer takes IN_REVIEW -> VALIDATION (header ignored, bound role allowed)');
    assert.equal((await patchStatus('c-reviewer', CREDENTIALS.reviewer, 'builder', 'READY_TO_SHIP')).response.status, 403,
      'reviewer cannot reach READY_TO_SHIP');

    // t-tester: tester takes VALIDATION -> READY_TO_SHIP, cannot set DONE.
    await makeReadyTask('c-tester');
    await claimVersion('c-tester', CREDENTIALS.builder, null);
    await patchStatus('c-tester', CREDENTIALS.builder, null, 'IN_REVIEW');
    assert.equal((await patchStatus('c-tester', CREDENTIALS.reviewer, null, 'VALIDATION')).response.status, 200,
      'reviewer credential takes the VALIDATION hop with no header');
    assert.equal((await patchStatus('c-tester', CREDENTIALS.tester, 'builder', 'READY_TO_SHIP')).response.status, 200,
      'tester takes VALIDATION -> READY_TO_SHIP');
    assert.equal((await patchStatus('c-tester', CREDENTIALS.tester, 'validator', 'DONE')).response.status, 403,
      'tester cannot set DONE');

    // t-ship/t-release: only the releaser can take READY_TO_SHIP -> DONE.
    for (const id of ['c-ship', 'c-release']) {
      await makeReadyTask(id);
      await claimVersion(id, CREDENTIALS.builder, null);
      await patchStatus(id, CREDENTIALS.builder, null, 'IN_REVIEW');
      await patchStatus(id, CREDENTIALS.reviewer, null, 'VALIDATION');
      await patchStatus(id, CREDENTIALS.tester, null, 'READY_TO_SHIP');
    }
    assert.equal((await patchStatus('c-ship', CREDENTIALS.builder, 'admin', 'DONE')).response.status, 403,
      'builder (even declaring admin) cannot ship');
    assert.equal((await patchStatus('c-release', CREDENTIALS.releaser, 'builder', 'DONE')).response.status, 200,
      'releaser credential sets DONE with no header at all');
  });

  it('C2. a single role-bound token cannot walk the whole pipeline (the original vulnerability)', async () => {
    const id = await makeReadyTask('c2-solo');
    const r = await claim(id, CREDENTIALS.builder, 'admin'); // header says admin!
    assert.equal(r.response.status, 200);
    const toReview = await patchStatus(id, CREDENTIALS.builder, 'admin', 'IN_REVIEW');
    assert.equal(toReview.response.status, 200);
    const toValidation = await patchStatus(id, CREDENTIALS.builder, 'admin', 'VALIDATION');
    assert.equal(toValidation.response.status, 403, 'the walk STOPS at the first hop the bound role does not own');
  });

  it('D1. next-claim picks up the BOUND role, never a query/body role', async () => {
    await makeReadyTask('d1-nc');
    const r = await jsonRequest(baseUrl, '/api/tasks/next-claim?project=' + PROJECT + '&role=reviewer', {
      method: 'POST',
      headers: headers(CREDENTIALS.builder),
      body: JSON.stringify({ agent_id: 'agent-nc', role: 'reviewer' }),
    });
    assert.equal(r.response.status, 200, 'claimable as the bound builder');
    assert.equal(r.body.status, 'IN_PROGRESS');
  });

  it('D2. health: credential_map reports bound/unbound credential counts without exposing token values', async () => {
    const r = await jsonRequest(baseUrl, '/api/health');
    assert.equal(r.response.status, 200);
    const cm = r.body.credential_map;
    assert.equal(cm.credentials_total, 5);
    assert.equal(cm.credentials_bound, 4);
    assert.equal(cm.credentials_unbound, 1);
    assert.ok(!JSON.stringify(r.body).includes('tok-'), '/api/health never exposes a credential value');
  });

  it('D3. coverage report: bound/unbound counts are computed; boot warns when everything is unbound', () => {
    const report = reportCredentialCoverage([PROJECT], parseProjectTokens(PROJECT_TOKENS), {
      info: () => {}, warn: () => {}, error: () => {},
    });
    assert.equal(report.credentials_total, 5);
    assert.equal(report.credentials_bound, 4);
    assert.equal(report.credentials_unbound, 1);

    const lines = [];
    const logger = { info: () => {}, warn: (m) => lines.push(m), error: (m) => lines.push(m) };
    const unbound = reportCredentialCoverage(
      [PROJECT], parseProjectTokens(JSON.stringify({ [PROJECT]: 'tok-str' })), logger
    );
    assert.equal(unbound.credentials_bound, 0);
    assert.ok(lines.some((l) => l.includes('UNBOUND') && l.includes('self-declared')),
      'boot warns when every credential is unbound');
  });

  it('E. bound-role usage is not an auth failure: role mismatches never trip the failed-auth rate limiter', async () => {
    process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN = '2';
    resetRateLimits();
    const id = await makeReadyTask('e-rl');
    await claim(id, CREDENTIALS.builder, 'reviewer'); // audited mismatch, served
    // Three more mismatched-gate attempts (403 from the state machine, not auth):
    await patchStatus(id, CREDENTIALS.builder, null, 'IN_REVIEW');
    await patchStatus(id, CREDENTIALS.builder, 'reviewer', 'VALIDATION');
    await patchStatus(id, CREDENTIALS.builder, null, 'IN_REVIEW');
    const last = await patchStatus(id, CREDENTIALS.builder, 'reviewer', 'VALIDATION');
    assert.notEqual(last.response.status, 429, 'bound-role 403s are not counted as auth failures');
    assert.notEqual(last.response.status, 200); // still the state-machine 403
    delete process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN;
    resetRateLimits();
  });
});