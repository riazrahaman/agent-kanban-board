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
import { addressOwnerKey } from '../utils/addressKey.js';
import {
  MAX_LIVE_STREAM_TICKETS, MAX_LIVE_STREAM_TICKETS_PER_CREDENTIAL, createStreamTicket, liveStreamTicketCount, resetStreamTickets, verifyStreamTicket,
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

describe('SEC-105 address owner keys', () => {
  it('group IPv6 by /64 and unwrap IPv4-mapped addresses', () => {
    assert.equal(addressOwnerKey('2001:db8:1:2:aaaa::1'), addressOwnerKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
    assert.notEqual(addressOwnerKey('2001:db8:1:2::1'), addressOwnerKey('2001:db8:1:3::1'));
    assert.equal(addressOwnerKey('::ffff:192.0.2.5'), '192.0.2.5');
    assert.equal(addressOwnerKey('192.0.2.5'), '192.0.2.5');
  });
});

describe('PERF-102 stream ticket mint/redeem', () => {
  beforeEach(() => {
    process.env.KANBAN_AUTH_TOKEN = 'tok-b4';
    resetStreamTickets();
  });
  afterEach(() => { delete process.env.KANBAN_AUTH_TOKEN; resetStreamTickets(); });
  it('single-use and expiry still hold', () => {
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
  });

  it('a full table refuses mints and never invalidates another credential\'s live ticket', () => {
    const alpha = createStreamTicket({ role: 'builder', project: 'alpha', credentialId: 'cred-alpha' });
    let refused = null;
    for (let i = 0; i < MAX_LIVE_STREAM_TICKETS + 5 && !refused; i += 1) {
      const r = createStreamTicket({ role: 'builder', project: 'beta', credentialId: `cred-${i % 400}` });
      if (r?.refused) refused = r;
    }
    assert.ok(refused, 'global cap refuses');
    assert.ok(refused.retryAfterMs >= 1000);
    assert.ok(verifyStreamTicket(alpha.ticket), 'alpha ticket still redeemable');
  });
  it('one credential at its cap is refused while another credential and the admin still mint', () => {
    for (let i = 0; i < MAX_LIVE_STREAM_TICKETS_PER_CREDENTIAL; i += 1) {
      assert.ok(createStreamTicket({ role: 'builder', project: 'p', credentialId: 'A' }).ticket);
    }
    assert.equal(createStreamTicket({ role: 'builder', project: 'p', credentialId: 'A' }).refused, true);
    assert.ok(createStreamTicket({ role: 'builder', project: 'p', credentialId: 'B' }).ticket, 'same project, other credential');
    assert.ok(createStreamTicket({ role: 'admin', project: 'p', credentialId: 'ADMIN' }).ticket);
    assert.ok(createStreamTicket({ role: 'builder', project: 'p' }).ticket, 'unscoped callers share one bucket');
  });
  it('redeeming frees credential capacity', () => {
    const tickets = [];
    for (let i = 0; i < MAX_LIVE_STREAM_TICKETS_PER_CREDENTIAL; i += 1) tickets.push(createStreamTicket({ role: 'builder', project: 'p', credentialId: 'A' }));
    assert.ok(verifyStreamTicket(tickets[0].ticket));
    assert.ok(createStreamTicket({ role: 'builder', project: 'p', credentialId: 'A' }).ticket);
  });
  it('mint cost stays flat with thousands of outstanding tickets spread across credentials', () => {
    const mintBatch = (n, base) => {
      const s = process.hrtime.bigint();
      for (let i = 0; i < n; i += 1) {
        const r = createStreamTicket({ role: 'builder', project: 'p', credentialId: `c-${(base + i) % 200}` });
        assert.ok(r.ticket, 'mint accepted');
      }
      return Number(process.hrtime.bigint() - s) / 1e6;
    };
    const cold = mintBatch(200, 0);
    for (let i = 0; i < 6000; i += 1) createStreamTicket({ role: 'builder', project: 'p', credentialId: `c-${i % 200}` });
    assert.equal(liveStreamTicketCount(), 6200);
    const warm = mintBatch(200, 6000);
    // O(n) scanning would make the 6,200-outstanding batch ~30x slower; allow generous noise.
    assert.ok(warm < Math.max(cold * 8, 50), `cold ${cold}ms vs warm ${warm}ms`);
  });
});
