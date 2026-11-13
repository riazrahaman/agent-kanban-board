/**
 * Failed-auth bucket map bounds and hard-cap diagnostics.
 * - At most MAX_AUTH_BUCKETS addresses get their own bucket; further addresses
 *   share one overflow bucket, which is throttled collectively.
 * - Expired buckets are pruned at most once per second.
 * - Tripping the hard cap logs one warning and emits one audit entry per
 *   bucket per window.
 * Unit-level: the limiter functions take any object with an `ip`.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_HARD_CAP_MULTIPLIER,
  MAX_AUTH_BUCKETS,
  authFailuresExceeded,
  authHardCapExceeded,
  recordAuthFailure,
  resetAuthLimits,
  trackedAuthIpCount,
} from '../middleware/rateLimit.js';
import { onAudit } from '../store.js';

const realNow = Date.now;
let now = 1_000_000;
const req = (ip) => ({ ip });
const ipFor = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

describe('failed-auth bucket bounds', () => {
  beforeEach(() => {
    Date.now = () => now;
    process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN = '2';
    process.env.KANBAN_RATE_LIMIT_WINDOW_MS = '60000';
    resetAuthLimits();
  });
  afterEach(() => {
    Date.now = realNow;
    delete process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN;
    delete process.env.KANBAN_RATE_LIMIT_WINDOW_MS;
    resetAuthLimits();
  });

  it('caps per-address buckets at 10,000 and sends the rest to one shared overflow bucket', () => {
    assert.equal(MAX_AUTH_BUCKETS, 10000);
    for (let i = 0; i < MAX_AUTH_BUCKETS; i += 1) recordAuthFailure(req(ipFor(i)));
    assert.equal(trackedAuthIpCount(), MAX_AUTH_BUCKETS);
    for (let i = 0; i < 500; i += 1) recordAuthFailure(req(`192.0.2.${i % 250}-${i}`));
    assert.equal(trackedAuthIpCount(), MAX_AUTH_BUCKETS + 1, 'only one extra (overflow) entry');
  });

  it('overflow addresses are throttled collectively, tracked ones individually', () => {
    for (let i = 0; i < MAX_AUTH_BUCKETS; i += 1) recordAuthFailure(req(ipFor(i)));
    // Two distinct new addresses, one failure each: the shared bucket hits the limit (2).
    recordAuthFailure(req('198.51.100.1'));
    recordAuthFailure(req('198.51.100.2'));
    assert.notEqual(authFailuresExceeded(req('198.51.100.3')), null, 'a third new address is throttled');
    // A tracked address with one failure is still within its own budget.
    assert.equal(authFailuresExceeded(req(ipFor(5))), null);
    // The hard cap also applies to the overflow bucket as a whole.
    for (let i = 0; i < 2 * AUTH_HARD_CAP_MULTIPLIER; i += 1) recordAuthFailure(req(`203.0.113.${i}`));
    assert.notEqual(authHardCapExceeded(req('203.0.113.250')), null);
    assert.equal(authHardCapExceeded(req(ipFor(5))), null);
  });

  it('prunes expired buckets at most once per second', () => {
    process.env.KANBAN_RATE_LIMIT_WINDOW_MS = '100';
    recordAuthFailure(req('a')); // prune ran at `now`
    now += 150; // a's window is over
    recordAuthFailure(req('b')); // within a second of the last prune: no prune
    assert.equal(trackedAuthIpCount(), 2, 'no prune within one second of the last');
    assert.equal(authFailuresExceeded(req('a')), null, 'an expired bucket is still ignored on read');
    now += 1000;
    recordAuthFailure(req('c'));
    assert.equal(trackedAuthIpCount(), 1, 'a and b pruned once a second has passed');
  });

  it('expired buckets free capacity once pruned', () => {
    process.env.KANBAN_RATE_LIMIT_WINDOW_MS = '100';
    for (let i = 0; i < MAX_AUTH_BUCKETS; i += 1) recordAuthFailure(req(ipFor(i)));
    now += 1500;
    recordAuthFailure(req('fresh'));
    assert.equal(trackedAuthIpCount(), 1, 'fresh address gets its own bucket after the prune');
  });
});

describe('hard-cap diagnostics', () => {
  let audits;
  let warns;
  let unsub;
  const realWarn = console.warn;

  beforeEach(() => {
    Date.now = () => now;
    process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN = '2';
    process.env.KANBAN_RATE_LIMIT_WINDOW_MS = '60000';
    resetAuthLimits();
    audits = [];
    warns = [];
    unsub = onAudit((e) => { if (e.kind === 'auth_hard_cap') audits.push(e); });
    console.warn = (...args) => { warns.push(args.join(' ')); };
  });
  afterEach(() => {
    unsub();
    console.warn = realWarn;
    Date.now = realNow;
    delete process.env.KANBAN_AUTH_RATE_LIMIT_PER_MIN;
    delete process.env.KANBAN_RATE_LIMIT_WINDOW_MS;
    resetAuthLimits();
  });

  const capWarns = () => warns.filter((w) => w.includes('hard cap reached'));

  it('logs one warning and one audit entry when an address trips the cap, once per window', () => {
    const cap = 2 * AUTH_HARD_CAP_MULTIPLIER;
    for (let i = 0; i < cap; i += 1) recordAuthFailure(req('192.0.2.7'));
    assert.equal(audits.length, 0, 'nothing at the cap itself');
    for (let i = 0; i < 50; i += 1) recordAuthFailure(req('192.0.2.7'));
    assert.equal(audits.length, 1);
    assert.equal(capWarns().length, 1);
    assert.match(capWarns()[0], /192\.0\.2\.7/, 'the console line names the address');
    assert.equal(audits[0].actor, 'system');
    assert.doesNotMatch(audits[0].reason, /192\.0\.2\.7/, 'the audit entry carries no address');

    // Next window: trips again, logs again.
    now += 60001;
    for (let i = 0; i <= cap; i += 1) recordAuthFailure(req('192.0.2.7'));
    assert.equal(audits.length, 2);
    assert.equal(capWarns().length, 2);
  });

  it('a different address tripping the cap is reported separately', () => {
    const cap = 2 * AUTH_HARD_CAP_MULTIPLIER;
    for (let i = 0; i <= cap; i += 1) recordAuthFailure(req('192.0.2.8'));
    for (let i = 0; i <= cap; i += 1) recordAuthFailure(req('192.0.2.9'));
    assert.equal(audits.length, 2);
  });
});
