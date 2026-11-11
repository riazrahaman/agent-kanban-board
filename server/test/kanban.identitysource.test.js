/**
 * A7 (v3.12.8) — `req.caller.agentSource`.
 *
 * The source is what every mutation route keys its attribution on: a bound
 * credential/session is authoritative, while the admin token and the legacy
 * header path keep the documented caller assertion. The round-2 B2 regression
 * happened because the routes re-read `req.body.agent_id` and so disagreed with
 * the source the middleware had recorded — this suite pins the source values
 * themselves, so a future refactor that changes attribution has to change a
 * test first.
 *
 * These are middleware-level tests (no HTTP): the middleware is synchronous and
 * mutates `req.caller`, which is exactly the contract the routes consume.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emitIdentityBindingMismatch, createAuthMiddleware } from '../middleware/auth.js';
import { resetRateLimits } from '../middleware/rateLimit.js';
import { createSessionToken } from '../sessionAuth.js';
import * as store from '../store.js';

const PROJECT = 'alpha';
const SECRET = 'agent-source-secret-0123456789abcdef';
const ADMIN_TOKEN = 'tok-admin';
const GLOBAL_TOKEN = 'tok-global';
const BOUND_AGENT = 'agent-bound';
const PROJECT_TOKENS = JSON.stringify({
  [PROJECT]: {
    credentials: [
      { token: 'tok-bound', role: 'builder', agent_id: BOUND_AGENT },
      { token: 'tok-unbound', role: 'builder' },
    ],
  },
});

const middleware = createAuthMiddleware();

function fakeReq({ token, role, agentId, body = {}, project = PROJECT } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (role) headers['x-agent-role'] = role;
  if (agentId) headers['x-agent-id'] = agentId;
  return {
    method: 'POST',
    headers,
    body,
    query: project ? { project } : {},
    path: '/api/tasks/t1/claim',
    url: '/api/tasks/t1/claim',
    originalUrl: '/api/tasks/t1/claim',
  };
}

function run(req) {
  let nextCalled = false;
  let statusCode = null;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; },
  };
  middleware(req, res, () => { nextCalled = true; });
  return { req, nextCalled, statusCode, payload };
}

describe('A7 — req.caller.agentSource', () => {
  const auditEntries = [];
  let auditListener;

  before(async () => {
    delete process.env.KANBAN_STORAGE_BACKEND;
    delete process.env.KANBAN_DATA_FILE;
    delete process.env.KANBAN_DEFAULT_PROJECT;
    process.env.KANBAN_PROJECT_TOKENS = PROJECT_TOKENS;
    process.env.KANBAN_ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.KANBAN_AUTH_TOKEN = GLOBAL_TOKEN;
    process.env.KANBAN_AUTH_SECRET = SECRET;
    store.setStorage(null);
    auditListener = (entry) => auditEntries.push(entry);
    store.onAudit(auditListener);
  });

  after(() => {
    if (auditListener) store.offAudit?.(auditListener);
    delete process.env.KANBAN_PROJECT_TOKENS;
    delete process.env.KANBAN_ADMIN_TOKEN;
    delete process.env.KANBAN_AUTH_TOKEN;
    delete process.env.KANBAN_AUTH_SECRET;
    resetRateLimits();
  });

  it('a bound project credential reports "credential" and keeps the bound id', () => {
    const { req, nextCalled } = run(fakeReq({
      token: 'tok-bound',
      role: 'builder',
      agentId: 'declared-header',
      body: { agent_id: 'declared-body' },
    }));
    assert.equal(nextCalled, true);
    assert.equal(req.caller.agentSource, 'credential');
    assert.equal(req.caller.agent_id, BOUND_AGENT);
    assert.equal(req.caller.roleSource, 'credential');
  });

  it('an unbound credential with X-Agent-Id reports "header"', () => {
    const { req, nextCalled } = run(fakeReq({
      token: 'tok-unbound',
      role: 'builder',
      agentId: 'legacy-header-agent',
      body: { agent_id: 'ignored-body' },
    }));
    assert.equal(nextCalled, true);
    assert.equal(req.caller.agentSource, 'header');
    assert.equal(req.caller.agent_id, 'legacy-header-agent', 'the body is never identity here');
  });

  it('an unbound credential with no declaration has no source and no identity', () => {
    const { req, nextCalled } = run(fakeReq({
      token: 'tok-unbound',
      role: 'builder',
      body: { agent_id: 'ignored-body' },
    }));
    assert.equal(nextCalled, true);
    assert.equal(req.caller.agentSource, null);
    assert.equal(req.caller.agent_id, null);
  });

  it('the admin token reports "admin_token" and may assert via body or header', () => {
    const byBody = run(fakeReq({ token: ADMIN_TOKEN, role: 'admin', body: { agent_id: 'admin-body' } }));
    assert.equal(byBody.nextCalled, true);
    assert.equal(byBody.req.caller.agentSource, 'admin_token');
    assert.equal(byBody.req.caller.agent_id, 'admin-body');

    const byHeader = run(fakeReq({
      token: ADMIN_TOKEN,
      role: 'admin',
      agentId: 'admin-header',
      body: { agent_id: 'admin-body' },
    }));
    assert.equal(byHeader.req.caller.agentSource, 'admin_token');
    assert.equal(byHeader.req.caller.agent_id, 'admin-header', 'header outranks body, as before');
  });

  it('a BOUND privileged session reports "session" and the bound id wins over a spoof (B2)', () => {
    const session = createSessionToken({
      clientNonce: 'c',
      serverNonce: 's',
      role: 'system',
      project: PROJECT,
      agentId: BOUND_AGENT,
    });
    const { req, nextCalled } = run(fakeReq({
      token: session.token,
      role: 'system',
      agentId: 'victim-header',
      body: { agent_id: 'victim-body' },
    }));
    assert.equal(nextCalled, true);
    assert.equal(req.caller.privileged, true, 'the session role is privileged');
    assert.equal(req.caller.agentSource, 'session');
    assert.equal(req.caller.agent_id, BOUND_AGENT, 'the bound session identity outranks every declaration');
  });

  it('an UNBOUND privileged session reports "session" and keeps the legacy assertion', () => {
    const session = createSessionToken({
      clientNonce: 'c',
      serverNonce: 's2',
      role: 'system',
      project: PROJECT,
    });
    const { req, nextCalled } = run(fakeReq({
      token: session.token,
      role: 'system',
      body: { agent_id: 'session-asserted' },
    }));
    assert.equal(nextCalled, true);
    assert.equal(req.caller.agentSource, 'session');
    assert.equal(req.caller.agent_id, 'session-asserted');
  });

  it('the legacy global token reports "header" — body only when the header role is privileged', () => {
    // The legacy single-token path only exists when no per-project map is
    // configured (the map branch rejects a token it does not contain).
    delete process.env.KANBAN_PROJECT_TOKENS;
    try {
      const builder = run(fakeReq({
        token: GLOBAL_TOKEN,
        role: 'builder',
        agentId: 'global-header',
        body: { agent_id: 'global-body' },
      }));
      assert.equal(builder.nextCalled, true);
      assert.equal(builder.req.caller.agentSource, 'header');
      assert.equal(builder.req.caller.agent_id, 'global-header');

      const privileged = run(fakeReq({
        token: GLOBAL_TOKEN,
        role: 'admin',
        body: { agent_id: 'global-body' },
      }));
      assert.equal(privileged.nextCalled, true);
      assert.equal(privileged.req.caller.agentSource, 'header');
      assert.equal(privileged.req.caller.agent_id, 'global-body', 'historical superuser body fallback');
    } finally {
      process.env.KANBAN_PROJECT_TOKENS = PROJECT_TOKENS;
    }
  });

  it('the role_binding_mismatch actor is the credential-bound id (binding runs first)', () => {
    const before = auditEntries.length;
    run(fakeReq({
      token: 'tok-bound',
      role: 'tester', // conflicts with the bound builder role
      agentId: 'declared-header',
    }));
    const roleMismatch = auditEntries.slice(before)
      .find((e) => e.kind === 'role_binding_mismatch');
    assert.ok(roleMismatch, 'the mismatch is audited');
    assert.equal(roleMismatch.actor, BOUND_AGENT);
  });

  it('a declared identity cannot forge a log line or flood the audit reason', () => {
    const before = auditEntries.length;
    const forged = `evil\n[kanban audit] 2026-01-01T00:00:00.000Z claimed default/t actor=forged${'x'.repeat(200)}`;
    emitIdentityBindingMismatch(
      fakeReq({ token: 'tok-bound', role: 'builder', agentId: 'declared' }),
      forged,
      BOUND_AGENT,
      PROJECT,
      'header',
    );
    const entry = auditEntries.slice(before).find((e) => e.kind === 'identity_binding_mismatch');
    assert.ok(entry);
    assert.ok(!entry.reason.includes('\n'), 'no newline can be injected into the audit reason');
    // 64 characters of the declared value, plus the fixed template text.
    assert.ok(!entry.reason.includes('x'.repeat(65)), 'the declared value is capped at 64 characters');
    assert.match(entry.reason, /declared header/);
  });
});
