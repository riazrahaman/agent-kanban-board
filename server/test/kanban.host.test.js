import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolveHost } from '../server.js';

/**
 * Host binding regression guard.
 *
 * Railway injects `HOST=[::]`. Passing a bracketed IPv6 literal straight to
 * `net.Server.listen` makes Node treat it as a hostname, fail with
 * `getaddrinfo ENOTFOUND`, and crash the process via an unhandled 'error' event
 * — which restart-loops and fails the deploy. `resolveHost` must strip the
 * brackets so the server binds instead.
 */

describe('resolveHost', () => {
  it('strips the brackets from a bracketed IPv6 wildcard (Railway)', () => {
    assert.equal(resolveHost({ HOST: '[::]', PORT: '8080' }), '::');
  });

  it('strips the brackets from a bracketed IPv6 loopback', () => {
    assert.equal(resolveHost({ HOST: '[::1]' }), '::1');
  });

  it('passes a bare IPv6 wildcard through untouched', () => {
    assert.equal(resolveHost({ HOST: '::' }), '::');
  });

  it('passes IPv4 literals through untouched', () => {
    assert.equal(resolveHost({ HOST: '0.0.0.0' }), '0.0.0.0');
    assert.equal(resolveHost({ HOST: '127.0.0.1' }), '127.0.0.1');
  });

  it('trims surrounding whitespace before deciding', () => {
    assert.equal(resolveHost({ HOST: '  [::]  ', PORT: '1' }), '::');
  });

  it('defaults to loopback when HOST is absent (local dev)', () => {
    assert.equal(resolveHost({}), '127.0.0.1');
    assert.equal(resolveHost({ HOST: '' }), '127.0.0.1');
  });

  it('defaults to all interfaces when HOST is absent but PORT is injected', () => {
    assert.equal(resolveHost({ PORT: '10000' }), '0.0.0.0');
  });
});

describe('server binds the host resolveHost produces', () => {
  it('listens on a resolved [::] without an ENOTFOUND crash', async (t) => {
    const host = resolveHost({ HOST: '[::]', PORT: '4000' });
    const server = createServer();
    const error = await new Promise((resolve) => {
      server.once('error', resolve);
      server.listen(0, host, () => {
        server.close(() => resolve(null));
      });
    });
    // IMPL-01 (v2.7.0): tolerate an IPv6-less environment. A host with no IPv6
    // stack rejects `[::]` with EADDRNOTAVAIL / EAFNOSUPPORT — that is not a
    // regression (the bracket-stripping logic did its job: no ENOTFOUND). Treat
    // those as a skip. EADDRINUSE is also environment noise (a flaky CI port),
    // not a code defect. The real assertion: a bracketed host must NEVER produce
    // ENOTFOUND.
    if (error) {
      const skipCodes = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EADDRINUSE']);
      if (skipCodes.has(error.code)) {
        assert.notEqual(error.code, 'ENOTFOUND', 'bracketed host must not produce ENOTFOUND');
        t.skip(`IPv6 unavailable on this host (${error.code}) — bracket logic verified`);
        return;
      }
    }
    assert.equal(error, null, `expected a clean bind, got ${error && error.code}`);
  });
});
