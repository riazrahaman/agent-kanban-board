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
import {
  resolveTrustProxy, describeTrustProxy, forwardedHeaderWarning, resetForwardedHeaderWarning,
} from '../server.js';
import {
  MAX_LIVE_CHALLENGES_PER_ADDRESS, MAX_LIVE_SESSION_CHALLENGES, challengeOwnerKey, consumeSessionChallenge,
  sessionChallengeRetryAfterMs, createSessionChallenge,
  resetSessionChallenges,
} from '../sessionChallenge.js';
import {
  MAX_LIVE_STREAM_TICKETS, MAX_LIVE_STREAM_TICKETS_PER_OWNER, createStreamTicket, liveStreamTicketCount, resetStreamTickets, verifyStreamTicket,
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
  it('unset trusts no proxy', () => {
    assert.equal(resolveTrustProxy(undefined), false);
    assert.equal(resolveTrustProxy(''), false);
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
    assert.match(describeTrustProxy(undefined), /off by default/);
    assert.match(describeTrustProxy('false'), /off/);
    assert.match(describeTrustProxy('1'), /1 hop/);
  });
  it('a peer in a private range cannot choose its address by default', async () => {
    const { default: express } = await import('express');
    const app = express();
    app.set('trust proxy', resolveTrustProxy(undefined));
    app.get('/ip', (r, s) => s.json({ ip: r.ip }));
    const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/ip`, {
        headers: { 'X-Forwarded-For': '198.51.100.7' },
      });
      assert.match((await res.json()).ip, /127\.0\.0\.1/);
    } finally { await new Promise((r) => server.close(r)); }
  });
  it('warns once per process when X-Forwarded-For arrives with trust unset', () => {
    delete process.env.KANBAN_TRUST_PROXY;
    resetForwardedHeaderWarning();
    const lines = [];
    const realWarn = console.warn;
    console.warn = (l) => lines.push(String(l));
    try {
      const r = { headers: { 'x-forwarded-for': '198.51.100.7' } };
      forwardedHeaderWarning(r, {}, () => {});
      forwardedHeaderWarning(r, {}, () => {});
      forwardedHeaderWarning({ headers: {} }, {}, () => {});
    } finally { console.warn = realWarn; resetForwardedHeaderWarning(); }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /KANBAN_TRUST_PROXY=1/);
    assert.ok(!/198\.51\.100\.7/.test(lines[0]), 'no client address in the warning');
  });
  it('does not warn when KANBAN_TRUST_PROXY is set explicitly', () => {
    process.env.KANBAN_TRUST_PROXY = '1';
    resetForwardedHeaderWarning();
    const lines = [];
    const realWarn = console.warn;
    console.warn = (l) => lines.push(String(l));
    try { forwardedHeaderWarning({ headers: { 'x-forwarded-for': 'x' } }, {}, () => {}); }
    finally { console.warn = realWarn; delete process.env.KANBAN_TRUST_PROXY; }
    assert.equal(lines.length, 0);
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

describe('SEC-105 per-owner challenge cap and no cross-owner eviction', () => {
  beforeEach(() => resetSessionChallenges());
  it('a flooding address evicts only its own challenges', () => {
    const victim = createSessionChallenge('198.51.100.1').challenge;
    const first = createSessionChallenge('203.0.113.9').challenge;
    for (let i = 0; i < MAX_LIVE_CHALLENGES_PER_ADDRESS + 20; i += 1) createSessionChallenge('203.0.113.9');
    assert.equal(consumeSessionChallenge(first), false, 'flooder own oldest evicted');
    assert.equal(consumeSessionChallenge(victim), true, 'other address unaffected');
  });
  it('owner keys group IPv6 by /64 and unwrap IPv4-mapped addresses', () => {
    assert.equal(challengeOwnerKey('2001:db8:1:2:aaaa::1'), challengeOwnerKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
    assert.notEqual(challengeOwnerKey('2001:db8:1:2::1'), challengeOwnerKey('2001:db8:1:3::1'));
    assert.equal(challengeOwnerKey('::ffff:192.0.2.5'), '192.0.2.5');
    assert.equal(challengeOwnerKey('192.0.2.5'), '192.0.2.5');
  });
  it('rotating addresses inside one /64 shares one allowance', () => {
    const first = createSessionChallenge('2001:db8:1:2::1').challenge;
    for (let i = 0; i < MAX_LIVE_CHALLENGES_PER_ADDRESS; i += 1) createSessionChallenge(`2001:db8:1:2::${i + 2}`);
    assert.equal(consumeSessionChallenge(first), false);
  });
  it('at global capacity new issuance is refused and no live challenge is evicted', () => {
    const victim = createSessionChallenge('198.51.100.1').challenge;
    const owners = Math.ceil(MAX_LIVE_SESSION_CHALLENGES / MAX_LIVE_CHALLENGES_PER_ADDRESS) + 1;
    let refused = 0;
    for (let o = 0; o < owners; o += 1) {
      for (let i = 0; i < MAX_LIVE_CHALLENGES_PER_ADDRESS; i += 1) {
        if (createSessionChallenge(`10.${o >> 8}.${o & 255}.1`) === null) refused += 1;
      }
    }
    assert.ok(refused > 0, 'issuance refused once the table is full');
    assert.equal(consumeSessionChallenge(victim), true, 'victim challenge survived');
    assert.ok(sessionChallengeRetryAfterMs() >= 1000);
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

  it('a full table refuses mints and never invalidates a live ticket of another project', () => {
    const alpha = createStreamTicket({ role: 'builder', project: 'alpha' });
    let refused = null;
    for (let i = 0; i < MAX_LIVE_STREAM_TICKETS + 5 && !refused; i += 1) {
      const r = createStreamTicket({ role: 'builder', project: `beta-${i % 30}` });
      if (r?.refused) refused = r;
    }
    assert.ok(refused, 'global cap refuses');
    assert.ok(refused.retryAfterMs >= 1000);
    assert.ok(verifyStreamTicket(alpha.ticket), 'alpha ticket still redeemable');
  });
  it('one project cannot fill the table past its per-owner cap', () => {
    for (let i = 0; i < MAX_LIVE_STREAM_TICKETS_PER_OWNER; i += 1) {
      assert.ok(createStreamTicket({ role: 'builder', project: 'greedy' }).ticket);
    }
    assert.equal(createStreamTicket({ role: 'builder', project: 'greedy' }).refused, true);
    assert.ok(createStreamTicket({ role: 'builder', project: 'other' }).ticket);
  });
  it('redeeming frees owner capacity', () => {
    const tickets = [];
    for (let i = 0; i < MAX_LIVE_STREAM_TICKETS_PER_OWNER; i += 1) tickets.push(createStreamTicket({ role: 'builder', project: 'p' }));
    assert.ok(verifyStreamTicket(tickets[0].ticket));
    assert.ok(createStreamTicket({ role: 'builder', project: 'p' }).ticket);
  });
});
