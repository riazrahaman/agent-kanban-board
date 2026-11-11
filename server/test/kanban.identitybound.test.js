/**
 * A7 (v3.12.8) — credential-bound agent identity.
 *
 * The failure this suite pins down: an agent id used to be caller-DECLARED —
 * `X-Agent-Id`, or worse, a body `agent_id` that the middleware folded into
 * `req.caller` for everyone. A project token could therefore claim to be any
 * agent, and every write was attributed to whoever the caller said it was.
 *
 * Now KANBAN_PROJECT_TOKENS credentials may bind an `agent_id`:
 *   - a bound credential FORCES req.caller.agent_id; a conflicting header or
 *     body value is ignored and audited (identity_binding_mismatch)
 *   - sessions minted from a bound credential carry that identity
 *   - an UNBOUND (legacy) credential keeps the documented header semantics,
 *     but the body is never identity for a non-privileged caller
 *   - the admin token is privileged and may still assert an identity
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { parseProjectTokens } from '../middleware/auth.js';
import { resetRateLimits } from '../middleware/rateLimit.js';
import {
  createSessionToken,
  verifySessionToken,
} from '../sessionAuth.js';
import { proofInput, challengeProofInput } from '../routes/auth.js';
import * as store from '../store.js';

const PROJECT = 'alpha';
const OTHER_PROJECT = 'beta';
const SECRET = 'identity-bound-secret-0123456789abcdef';

const CREDENTIALS = {
  boundBuilder: 'tok-bound-builder',
  legacyBuilder: 'tok-legacy-builder',
};
const ADMIN_TOKEN = 'tok-admin';
const BOUND_AGENT = 'agent-alpha-builder';
const PROJECT_TOKENS = JSON.stringify({
  [PROJECT]: {
    credentials: [
      { token: CREDENTIALS.boundBuilder, role: 'builder', agent_id: BOUND_AGENT },
      { token: CREDENTIALS.legacyBuilder, role: 'builder' },
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

function headers(token, role, agentId) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(role ? { 'X-Agent-Role': role } : {}),
    ...(agentId ? { 'X-Agent-Id': agentId } : {}),
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

function signed(secret, input) {
  return crypto.createHmac('sha256', secret).update(input).digest('hex');
}

describe('A7 — credential-bound agent identity (v3.12.8)', () => {
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
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kanban-identitybound-'));
    store.setStorage(null);
    process.env.KANBAN_DATA_DIR = tmpDir;
    process.env.KANBAN_DATA_FILE = path.join(tmpDir, 'tasks.json');
    process.env.KANBAN_PROJECT_TOKENS = PROJECT_TOKENS;
    process.env.KANBAN_ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.KANBAN_AUTH_SECRET = SECRET;
    await store.loadStore();
    auditListener = (entry) => auditEntries.push(entry);
    store.onAudit(auditListener);
    ({ server, baseUrl } = await startTestServer(createApp()));
  });

  after(async () => {
    if (auditListener) store.offAudit?.(auditListener);
    delete process.env.KANBAN_PROJECT_TOKENS;
    delete process.env.KANBAN_ADMIN_TOKEN;
    delete process.env.KANBAN_AUTH_SECRET;
    delete process.env.KANBAN_DATA_DIR;
    delete process.env.KANBAN_DATA_FILE;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    resetRateLimits();
  });

  /** admin helper: create + promote a task to READY */
  const makeReadyTask = async (id) => {
    const created = await jsonRequest(baseUrl, '/api/tasks', {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, 'admin', 'setup'),
      body: JSON.stringify({ id, project: PROJECT, title: id, status: 'BACKLOG', round: 1 }),
    });
    assert.equal(created.response.status, 201, `create ${id}: ${created.body?.error || ''}`);
    const promoted = await jsonRequest(baseUrl, `/api/tasks/${id}?project=${PROJECT}`, {
      method: 'PATCH',
      headers: headers(ADMIN_TOKEN, 'admin', 'setup'),
      body: JSON.stringify({ status: 'READY', expected_version: 1 }),
    });
    assert.equal(promoted.response.status, 200, `promote ${id} to READY`);
    return id;
  };

  it('I1. a bound credential wins over spoofed header AND body identity on claim', async () => {
    const before = auditEntries.length;
    const id = await makeReadyTask('ib-claim');

    const claimed = await jsonRequest(baseUrl, `/api/tasks/${id}/claim?project=${PROJECT}`, {
      method: 'POST',
      headers: headers(CREDENTIALS.boundBuilder, 'builder', 'spoofed-header-agent'),
      body: JSON.stringify({ agent_id: 'spoofed-body-agent' }),
    });
    assert.equal(claimed.response.status, 200, claimed.body?.error || '');
    assert.equal(claimed.body.assigned_agent, BOUND_AGENT, 'the credential identity owns the lease');
    assert.notEqual(claimed.body.assigned_agent, 'spoofed-header-agent');
    assert.notEqual(claimed.body.assigned_agent, 'spoofed-body-agent');

    const mismatches = auditEntries.slice(before).filter((e) => e.kind === 'identity_binding_mismatch');
    assert.ok(mismatches.length >= 2, 'both the header and body conflicts are audited');
    const headerEntry = mismatches.find((e) => /declared header/.test(e.reason));
    const bodyEntry = mismatches.find((e) => /declared body/.test(e.reason));
    assert.ok(headerEntry, 'header conflict audited');
    assert.ok(bodyEntry, 'body conflict audited');
    assert.equal(headerEntry.actor, BOUND_AGENT);
    assert.match(headerEntry.reason, /conflicts with credential-bound agent_id 'agent-alpha-builder'/);
    assert.ok(!JSON.stringify(mismatches).includes(CREDENTIALS.boundBuilder), 'no token value in the audit');
  });

  it('I2. heartbeat, logs, comments and next-claim all attribute to the bound identity', async () => {
    const hb = await jsonRequest(baseUrl, '/api/tasks/ib-claim/heartbeat?project=' + PROJECT, {
      method: 'POST',
      headers: headers(CREDENTIALS.boundBuilder, 'builder', 'spoofed-hb'),
      body: JSON.stringify({ agent_id: 'spoofed-hb-body' }),
    });
    assert.equal(hb.response.status, 200, hb.body?.error || '');
    assert.equal(hb.body.assigned_agent, BOUND_AGENT, 'heartbeat still the bound holder');

    const logged = await jsonRequest(baseUrl, '/api/tasks/ib-claim/logs?project=' + PROJECT, {
      method: 'POST',
      headers: headers(CREDENTIALS.boundBuilder, 'builder', 'spoofed-log'),
      body: JSON.stringify({ agent_id: 'spoofed-log-body', message: 'progress' }),
    });
    assert.equal(logged.response.status, 200, logged.body?.error || '');
    assert.equal(logged.body.agent_logs.at(-1).agent_id, BOUND_AGENT, 'log attributed to the credential identity');

    const commented = await jsonRequest(baseUrl, '/api/tasks/ib-claim/comments?project=' + PROJECT, {
      method: 'POST',
      headers: headers(CREDENTIALS.boundBuilder, 'builder', 'spoofed-comment'),
      body: JSON.stringify({ agent_id: 'spoofed-comment-body', message: 'hi' }),
    });
    assert.equal(commented.response.status, 200, commented.body?.error || '');
    assert.equal(commented.body.comments.at(-1).agent_id, BOUND_AGENT, 'comment attributed to the credential identity');

    await makeReadyTask('ib-next');
    const next = await jsonRequest(baseUrl, '/api/tasks/next-claim?project=' + PROJECT, {
      method: 'POST',
      headers: headers(CREDENTIALS.boundBuilder, 'builder', 'spoofed-next'),
      body: JSON.stringify({ agent_id: 'spoofed-next-body' }),
    });
    assert.equal(next.response.status, 200, next.body?.error || '');
    assert.equal(next.body.assigned_agent, BOUND_AGENT, 'next-claim attributed to the credential identity');
  });

  it('I3. unbound legacy credential keeps X-Agent-Id semantics', async () => {
    await makeReadyTask('ib-legacy-header');
    const claimed = await jsonRequest(baseUrl, '/api/tasks/ib-legacy-header/claim?project=' + PROJECT, {
      method: 'POST',
      headers: headers(CREDENTIALS.legacyBuilder, 'builder', 'legacy-header-agent'),
      body: JSON.stringify({ agent_id: 'legacy-body-spoof' }),
    });
    assert.equal(claimed.response.status, 200, claimed.body?.error || '');
    assert.equal(claimed.body.assigned_agent, 'legacy-header-agent', 'header identity is honored');
    assert.notEqual(claimed.body.assigned_agent, 'legacy-body-spoof', 'body identity never wins');
  });

  it('I4. a body-only identity is REJECTED for a non-privileged caller (the A7 spoofing path)', async () => {
    await makeReadyTask('ib-body-only');
    const claim = await jsonRequest(baseUrl, '/api/tasks/ib-body-only/claim?project=' + PROJECT, {
      method: 'POST',
      headers: headers(CREDENTIALS.legacyBuilder, 'builder'),
      body: JSON.stringify({ agent_id: 'body-only-agent' }),
    });
    assert.equal(claim.response.status, 400, 'no header identity: nothing to attribute the claim to');

    const log = await jsonRequest(baseUrl, '/api/tasks/ib-body-only/logs?project=' + PROJECT, {
      method: 'POST',
      headers: headers(CREDENTIALS.legacyBuilder, 'builder'),
      body: JSON.stringify({ agent_id: 'body-only-agent', message: 'x' }),
    });
    assert.equal(log.response.status, 400, 'a body agent_id alone cannot authorize a log write');

    // The same write with the documented header channel succeeds.
    const withHeader = await jsonRequest(baseUrl, '/api/tasks/ib-body-only/logs?project=' + PROJECT, {
      method: 'POST',
      headers: headers(CREDENTIALS.legacyBuilder, 'builder', 'header-agent'),
      body: JSON.stringify({ agent_id: 'body-only-agent', message: 'x' }),
    });
    assert.equal(withHeader.response.status, 200, withHeader.body?.error || '');
    assert.equal(withHeader.body.agent_logs.at(-1).agent_id, 'header-agent');
  });

  it('I5. the admin token is privileged and may assert identity via body or header', async () => {
    await makeReadyTask('ib-admin-body');
    const byBody = await jsonRequest(baseUrl, '/api/tasks/ib-admin-body/claim?project=' + PROJECT, {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, 'admin'),
      body: JSON.stringify({ agent_id: 'admin-chosen-agent' }),
    });
    assert.equal(byBody.response.status, 200, byBody.body?.error || '');
    assert.equal(byBody.body.assigned_agent, 'admin-chosen-agent');

    await makeReadyTask('ib-admin-header');
    const byHeader = await jsonRequest(baseUrl, '/api/tasks/ib-admin-header/claim?project=' + PROJECT, {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, 'admin', 'admin-header-agent'),
      body: JSON.stringify({}),
    });
    assert.equal(byHeader.response.status, 200, byHeader.body?.error || '');
    assert.equal(byHeader.body.assigned_agent, 'admin-header-agent');
  });

  it('I6. sessions minted from a bound credential carry agent_id (challenge flow)', async () => {
    const challengeResponse = await jsonRequest(baseUrl, '/api/auth/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(challengeResponse.response.status, 200);
    const challenge = challengeResponse.body.challenge;
    const clientNonce = 'identity-challenge-nonce';
    const proof = signed(SECRET, challengeProofInput(challenge, clientNonce, 'builder', PROJECT));

    const minted = await jsonRequest(baseUrl, '/api/auth/session', {
      method: 'POST',
      headers: headers(CREDENTIALS.boundBuilder, null, 'spoofed-mint-header'),
      body: JSON.stringify({
        client_nonce: clientNonce,
        proof,
        server_nonce: challenge,
        role: 'builder',
        project: PROJECT,
        agent_id: 'spoofed-mint-body',
      }),
    });
    assert.equal(minted.response.status, 200, minted.body?.error || '');
    assert.equal(minted.body.agent_id, BOUND_AGENT, 'the mint response discloses the bound identity');

    const verified = verifySessionToken(minted.body.token);
    assert.ok(verified, 'the minted session verifies');
    assert.equal(verified.agent_id, BOUND_AGENT);
    assert.equal(verified.role, 'builder');
    assert.equal(verified.project, PROJECT);

    // The session's identity is credential-bound too: a spoofed header on a
    // write does not change attribution.
    await makeReadyTask('ib-session-claim');
    const claimed = await jsonRequest(baseUrl, '/api/tasks/ib-session-claim/claim?project=' + PROJECT, {
      method: 'POST',
      headers: headers(minted.body.token, 'builder', 'spoofed-session-agent'),
      body: JSON.stringify({ agent_id: 'spoofed-session-body' }),
    });
    assert.equal(claimed.response.status, 200, claimed.body?.error || '');
    assert.equal(claimed.body.assigned_agent, BOUND_AGENT);
  });

  it('I7. sessions minted via the legacy proof flow also carry agent_id', async () => {
    const clientNonce = 'identity-legacy-nonce';
    const proof = signed(SECRET, proofInput(clientNonce, 'builder', PROJECT));
    const minted = await jsonRequest(baseUrl, '/api/auth/session', {
      method: 'POST',
      headers: headers(CREDENTIALS.boundBuilder, null),
      body: JSON.stringify({ client_nonce: clientNonce, proof, role: 'builder', project: PROJECT }),
    });
    assert.equal(minted.response.status, 200, minted.body?.error || '');
    assert.equal(minted.body.agent_id, BOUND_AGENT);
    assert.equal(verifySessionToken(minted.body.token).agent_id, BOUND_AGENT);
  });

  it('I8. a session with no bound agent still verifies (backward compatibility)', async () => {
    const legacy = createSessionToken({
      clientNonce: 'legacy-client',
      serverNonce: 'legacy-server',
      role: 'builder',
      project: PROJECT,
    });
    assert.ok(legacy.token);
    const verified = verifySessionToken(legacy.token);
    assert.ok(verified, 'a token without agent_id still verifies');
    assert.equal(verified.agent_id, null);
    assert.equal(verified.role, 'builder');

    // And one minted through the handshake WITHOUT a bearer credential is unbound.
    const clientNonce = 'identity-unbound-nonce';
    const proof = signed(SECRET, proofInput(clientNonce, 'builder', PROJECT));
    const minted = await jsonRequest(baseUrl, '/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_nonce: clientNonce, proof, role: 'builder', project: PROJECT }),
    });
    assert.equal(minted.response.status, 200, minted.body?.error || '');
    assert.equal(minted.body.agent_id, undefined, 'no credential => no bound identity');
    assert.equal(verifySessionToken(minted.body.token).agent_id, null);
  });

  it('I9. (B1) the browser header shape works end to end on all five identity paths', async () => {
    // The browser client now sends X-Agent-Id from the same agentId value it
    // puts in the body. A non-privileged project credential that binds NO
    // identity is the deployment this must keep working: without the header the
    // round-1 change 400s every one of these writes. `clientHeaders` is exactly
    // what client/src/lib/authToken.ts::authHeaders produces for a stored token.
    const UI_AGENT = 'human-ui-agent';
    const clientHeaders = {
      Authorization: `Bearer ${CREDENTIALS.legacyBuilder}`,
      'Content-Type': 'application/json',
      'X-Agent-Role': 'builder',
      'X-Agent-Id': UI_AGENT,
    };

    await makeReadyTask('ib-client-claim');
    const claimed = await jsonRequest(baseUrl, `/api/tasks/ib-client-claim/claim?project=${PROJECT}`, {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({ agent_id: UI_AGENT }),
    });
    assert.equal(claimed.response.status, 200, claimed.body?.error || '');
    assert.equal(claimed.body.assigned_agent, UI_AGENT);

    const heartbeat = await jsonRequest(baseUrl, `/api/tasks/ib-client-claim/heartbeat?project=${PROJECT}`, {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({ agent_id: UI_AGENT }),
    });
    assert.equal(heartbeat.response.status, 200, heartbeat.body?.error || '');

    const logged = await jsonRequest(baseUrl, `/api/tasks/ib-client-claim/logs?project=${PROJECT}`, {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({ agent_id: UI_AGENT, message: 'from the browser' }),
    });
    assert.equal(logged.response.status, 200, logged.body?.error || '');
    assert.equal(logged.body.agent_logs.at(-1).agent_id, UI_AGENT);

    const commented = await jsonRequest(baseUrl, `/api/tasks/ib-client-claim/comments?project=${PROJECT}`, {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({ agent_id: UI_AGENT, message: 'from the browser' }),
    });
    assert.equal(commented.response.status, 200, commented.body?.error || '');
    assert.equal(commented.body.comments.at(-1).agent_id, UI_AGENT);

    await makeReadyTask('ib-client-next');
    const next = await jsonRequest(baseUrl, `/api/tasks/next-claim?project=${PROJECT}`, {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({ agent_id: UI_AGENT, role: 'builder' }),
    });
    assert.equal(next.response.status, 200, next.body?.error || '');
    assert.equal(next.body.assigned_agent, UI_AGENT);
  });

  it('I10. (B2) a privileged BOUND session cannot be attributed by body/header on any path', async () => {
    // The round-2 regression: the mint is privileged (role system) but carries
    // the credential's bound identity, and the routes still preferred the body.
    // Prove the session is privileged AND bound before using it.
    const clientNonce = 'identity-privileged-nonce';
    const proof = signed(SECRET, proofInput(clientNonce, 'system', PROJECT));
    const minted = await jsonRequest(baseUrl, '/api/auth/session', {
      method: 'POST',
      headers: headers(CREDENTIALS.boundBuilder, null),
      body: JSON.stringify({ client_nonce: clientNonce, proof, role: 'system', project: PROJECT }),
    });
    assert.equal(minted.response.status, 200, minted.body?.error || '');
    const verified = verifySessionToken(minted.body.token);
    assert.equal(verified.role, 'system');
    assert.equal(verified.agent_id, BOUND_AGENT);

    const spoofHeaders = headers(minted.body.token, 'system', 'victim-header2');
    const spoofBody = (extra = {}) => JSON.stringify({ agent_id: 'victim-body2', ...extra });
    const before = auditEntries.length;

    await makeReadyTask('ib-priv-claim');
    const claimed = await jsonRequest(baseUrl, `/api/tasks/ib-priv-claim/claim?project=${PROJECT}`, {
      method: 'POST',
      headers: spoofHeaders,
      body: spoofBody(),
    });
    assert.equal(claimed.response.status, 200, claimed.body?.error || '');
    assert.equal(claimed.body.assigned_agent, BOUND_AGENT, 'claim attributes to the bound session id');
    assert.notEqual(claimed.body.assigned_agent, 'victim-body2');

    const heartbeat = await jsonRequest(baseUrl, `/api/tasks/ib-priv-claim/heartbeat?project=${PROJECT}`, {
      method: 'POST',
      headers: spoofHeaders,
      body: spoofBody(),
    });
    assert.equal(heartbeat.response.status, 200, heartbeat.body?.error || '');

    const logged = await jsonRequest(baseUrl, `/api/tasks/ib-priv-claim/logs?project=${PROJECT}`, {
      method: 'POST',
      headers: spoofHeaders,
      body: spoofBody({ message: 'privileged session log' }),
    });
    assert.equal(logged.response.status, 200, logged.body?.error || '');
    assert.equal(logged.body.agent_logs.at(-1).agent_id, BOUND_AGENT);

    const commented = await jsonRequest(baseUrl, `/api/tasks/ib-priv-claim/comments?project=${PROJECT}`, {
      method: 'POST',
      headers: spoofHeaders,
      body: spoofBody({ message: 'privileged session comment' }),
    });
    assert.equal(commented.response.status, 200, commented.body?.error || '');
    assert.equal(commented.body.comments.at(-1).agent_id, BOUND_AGENT);

    await makeReadyTask('ib-priv-next');
    const next = await jsonRequest(baseUrl, '/api/tasks/next-claim?project=' + PROJECT, {
      method: 'POST',
      headers: spoofHeaders,
      body: spoofBody({ role: 'system' }),
    });
    assert.equal(next.response.status, 200, next.body?.error || '');
    assert.equal(next.body.assigned_agent, BOUND_AGENT, 'next-claim attributes to the bound session id');

    // The refusal is observable, and every entry names the id that actually served.
    const mismatches = auditEntries.slice(before).filter((e) => e.kind === 'identity_binding_mismatch');
    assert.ok(mismatches.length > 0, 'the privileged spoof attempts are audited');
    assert.ok(mismatches.every((e) => e.actor === BOUND_AGENT));

    // Contrast: the admin token is UNBOUND and privileged, so it may still assert.
    await makeReadyTask('ib-priv-admin');
    const adminClaim = await jsonRequest(baseUrl, `/api/tasks/ib-priv-admin/claim?project=${PROJECT}`, {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, 'admin'),
      body: JSON.stringify({ agent_id: 'admin-asserted' }),
    });
    assert.equal(adminClaim.response.status, 200, adminClaim.body?.error || '');
    assert.equal(adminClaim.body.assigned_agent, 'admin-asserted');
  });
});

describe('A7 — parseProjectTokens agent_id schema', () => {
  const get = (raw) => parseProjectTokens(raw);

  it('accepts valid agent_id with and without a bound role', () => {
    const withRole = get(JSON.stringify({
      alpha: { token: 't', role: 'builder', agent_id: 'agent.7@lane:3/x-y_z' },
    }));
    assert.ok(withRole.map);
    assert.deepEqual(withRole.map.get('alpha'), [
      { token: 't', role: 'builder', agent_id: 'agent.7@lane:3/x-y_z' },
    ]);

    const identityOnly = get(JSON.stringify({ alpha: { token: 't', agent_id: 'agent-7' } }));
    assert.ok(identityOnly.map);
    assert.deepEqual(identityOnly.map.get('alpha'), [{ token: 't', role: null, agent_id: 'agent-7' }]);

    // Trimming is part of the schema.
    const padded = get(JSON.stringify({ alpha: { token: 't', agent_id: '  agent-7  ' } }));
    assert.equal(padded.map.get('alpha')[0].agent_id, 'agent-7');
  });

  it('rejects invalid agent_id values', () => {
    for (const agentId of ['', '   ', 7, 'has space', 'semi;colon', 'a'.repeat(65), 'emoji-\u{1F600}']) {
      const raw = JSON.stringify({ alpha: { token: 't', agent_id: agentId } });
      assert.ok(get(raw).malformed, `invalid agent_id rejected: ${JSON.stringify(agentId)}`);
    }
    // The maximum length itself is accepted.
    const max = get(JSON.stringify({ alpha: { token: 't', agent_id: 'a'.repeat(64) } }));
    assert.ok(max.map, '64 characters is the inclusive limit');
  });

  it('rejects one token bound to different agent ids across projects', () => {
    const conflict = get(JSON.stringify({
      [PROJECT]: { token: 'tok-shared', role: 'builder', agent_id: 'agent-a' },
      [OTHER_PROJECT]: { token: 'tok-shared', role: 'builder', agent_id: 'agent-b' },
    }));
    assert.deepEqual(conflict, { malformed: true });
  });

  it('allows the same agent id across projects, and bound-vs-unbound mixing', () => {
    const same = get(JSON.stringify({
      [PROJECT]: { token: 'tok-shared', agent_id: 'agent-a' },
      [OTHER_PROJECT]: { token: 'tok-shared', agent_id: 'agent-a' },
    }));
    assert.ok(same.map);
    assert.equal(same.map.get(PROJECT)[0].agent_id, 'agent-a');

    const mixed = get(JSON.stringify({
      [PROJECT]: { token: 'tok-shared', agent_id: 'agent-a' },
      [OTHER_PROJECT]: { token: 'tok-shared' },
    }));
    assert.ok(mixed.map, 'bound-vs-unbound stays legal, like the role rule');
    assert.equal(mixed.map.get(OTHER_PROJECT)[0].agent_id, undefined);
  });
});
