/**
 * Limits hardening: overflow-bucket exemption, trust-proxy default, ticket
 * scope, per-address challenge cap, O(1) ticket expiry, bounded Ask lockout map.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_HARD_CAP_MULTIPLIER, MAX_AUTH_BUCKETS, authFailuresExceeded, authHardCapExceeded,
  recordAuthFailure, resetAuthLimits,
} from '../middleware/rateLimit.js';
import { resolveTrustProxy, describeTrustProxy, DEFAULT_TRUST_PROXY } from '../server.js';
import {
  MAX_LIVE_CHALLENGES_PER_ADDRESS, consumeSessionChallenge, createSessionChallenge,
  resetSessionChallenges,
} from '../sessionChallenge.js';
import {
  createStreamTicket, liveStreamTicketCount, resetStreamTickets, verifyStreamTicket,
} from '../streamTicket.js';
import { getAuthorizedProjects } from '../middleware/auth.js';

const req = (ip) => ({ ip });

describe('SEC-102 overflow bucket never refuses valid credentials', () => {
  beforeEach(() => {
    process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN = '2';
    resetAuthLimits();
  });
  afterEach(() => { delete process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN; resetAuthLimits(); });

  it('past the hard cap, an overflow address is throttled on failure but not hard-capped', () => {
    for (let i = 0; i < MAX_AUTH_BUCKETS; i += 1) recordAuthFailure(req(`10.${i >> 8}.${i & 255}.1`));
    for (let i = 0; i < 3 * AUTH_HARD_CAP_MULTIPLIER; i += 1) recordAuthFailure(req(`203.0.113.${i}`));
    assert.equal(authHardCapExceeded(req('198.51.100.9')), null);
    assert.notEqual(authFailuresExceeded(req('198.51.100.9')), null);
  });

  it('tracked addresses keep the per-address hard cap', () => {
    for (let i = 0; i < 2 * AUTH_HARD_CAP_MULTIPLIER + 1; i += 1) recordAuthFailure(req('192.0.2.1'));
    assert.notEqual(authHardCapExceeded(req('192.0.2.1')), null);
  });
});

describe('SEC-103 trust proxy default', () => {
  it('unset resolves to the private-range list', () => {
    assert.deepEqual(resolveTrustProxy(undefined), ['loopback', 'linklocal', 'uniquelocal', '100.64.0.0/10']);
    assert.deepEqual(resolveTrustProxy(''), DEFAULT_TRUST_PROXY);
  });
  it('explicit values keep their documented meaning', () => {
    assert.equal(resolveTrustProxy('1'), 1);
    assert.equal(resolveTrustProxy('2'), 2);
    assert.equal(resolveTrustProxy('0'), false);
    assert.equal(resolveTrustProxy('false'), false);
    assert.equal(resolveTrustProxy('true'), true);
    assert.equal(resolveTrustProxy('loopback'), 'loopback');
  });
  it('describes the mode without secrets', () => {
    assert.match(describeTrustProxy(undefined), /default/);
    assert.match(describeTrustProxy('false'), /off/);
    assert.match(describeTrustProxy('1'), /1 hop/);
  });
  it('a public peer cannot choose its address; a CGNAT/private peer can be forwarded', async () => {
    const { default: express } = await import('express');
    const app = express();
    app.set('trust proxy', resolveTrustProxy(undefined));
    app.get('/ip', (r, s) => s.json({ ip: r.ip }));
    const trust = app.get('trust proxy fn');
    assert.equal(trust('127.0.0.1', 0), true);
    assert.equal(trust('100.64.1.2', 0), true);
    assert.equal(trust('10.1.2.3', 0), true);
    assert.equal(trust('203.0.113.7', 0), false);
  });
});

describe('SEC-104 ticket scope', () => {
  beforeEach(() => {
    process.env.KANBAN_AUTH_TOKEN = 'tok-b4';
    process.env.KANBAN_AUTH_SECRET = 'secret-b4';
    resetStreamTickets();
  });
  afterEach(() => { delete process.env.KANBAN_AUTH_TOKEN; delete process.env.KANBAN_AUTH_SECRET; resetStreamTickets(); });

  const mk = (method, path, ticket) => ({
    method, path, query: { ticket }, headers: {}, caller: { role: 'builder' },
  });

  it('ticket authorises GET /api/events', () => {
    const t = createStreamTicket({ role: 'reviewer', project: 'p' });
    const r = mk('GET', '/api/events', t.ticket);
    assert.deepEqual([...getAuthorizedProjects(r)], ['p']);
    assert.equal(r.caller.role, 'reviewer');
  });
  it('ticket is ignored on writes and other routes and is not consumed', () => {
    const t = createStreamTicket({ role: 'admin', project: null });
    for (const [m, p] of [['POST', '/api/tasks'], ['PATCH', '/api/tasks/x'], ['GET', '/api/tasks']]) {
      const r = mk(m, p, t.ticket);
      assert.equal(getAuthorizedProjects(r), null);
      assert.equal(r.caller.role, 'builder');
    }
    assert.ok(verifyStreamTicket(t.ticket), 'still redeemable for the stream');
  });
});

describe('SEC-105 per-address challenge cap', () => {
  beforeEach(() => resetSessionChallenges());
  it('a flooding address evicts only its own challenges', () => {
    const victim = createSessionChallenge('198.51.100.1').challenge;
    const first = createSessionChallenge('203.0.113.9').challenge;
    for (let i = 0; i < MAX_LIVE_CHALLENGES_PER_ADDRESS + 20; i += 1) createSessionChallenge('203.0.113.9');
    assert.equal(consumeSessionChallenge(first), false, 'flooder own oldest evicted');
    assert.equal(consumeSessionChallenge(victim), true, 'other address unaffected');
  });
});

describe('PERF-102 stream ticket mint/redeem', () => {
  beforeEach(() => {
    process.env.KANBAN_AUTH_TOKEN = 'tok-b4';
    resetStreamTickets();
  });
  afterEach(() => { delete process.env.KANBAN_AUTH_TOKEN; resetStreamTickets(); });
  it('single-use and expiry still hold, and mint cost does not grow with outstanding tickets', () => {
    const a = createStreamTicket({ role: 'builder', project: 'p' });
    assert.ok(verifyStreamTicket(a.ticket));
    assert.equal(verifyStreamTicket(a.ticket), null);
    const realNow = Date.now;
    try {
      const t0 = realNow();
      createStreamTicket({ role: 'builder', project: 'p' });
      Date.now = () => t0 + 61000;
      assert.equal(liveStreamTicketCount(), 0);
    } finally { Date.now = realNow; }
    for (let i = 0; i < 5000; i += 1) createStreamTicket({ role: 'builder', project: 'p' });
    const s = process.hrtime.bigint();
    for (let i = 0; i < 200; i += 1) createStreamTicket({ role: 'builder', project: 'p' });
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    assert.ok(ms < 500, `200 mints with 5000 outstanding took ${ms}ms`);
  });
});
