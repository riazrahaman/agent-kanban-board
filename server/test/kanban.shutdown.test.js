import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerShutdownHandlers } from '../server.js';

describe('registerShutdownHandlers', () => {
  it('calls server.close and exits with code 0 on SIGTERM', async () => {
    let closed = false;
    let exitCode = null;
    const logs = [];

    const mockServer = {
      close: (cb) => {
        closed = true;
        cb(null);
      },
    };

    const cleanup = registerShutdownHandlers(mockServer, {
      exit: (code) => {
        exitCode = code;
      },
      log: (msg) => logs.push(msg),
    });

    try {
      process.emit('SIGTERM');
      assert.equal(closed, true, 'server.close must be called');
      assert.equal(exitCode, 0, 'process.exit must be called with 0');
      assert.ok(logs.some((l) => l.includes('received SIGTERM')));
    } finally {
      cleanup();
    }
  });

  it('calls server.close and exits with code 0 on SIGINT', async () => {
    let closed = false;
    let exitCode = null;
    const logs = [];

    const mockServer = {
      close: (cb) => {
        closed = true;
        cb(null);
      },
    };

    const cleanup = registerShutdownHandlers(mockServer, {
      exit: (code) => {
        exitCode = code;
      },
      log: (msg) => logs.push(msg),
    });

    try {
      process.emit('SIGINT');
      assert.equal(closed, true, 'server.close must be called');
      assert.equal(exitCode, 0, 'process.exit must be called with 0');
      assert.ok(logs.some((l) => l.includes('received SIGINT')));
    } finally {
      cleanup();
    }
  });

  it('exits with code 1 if server.close fails with an error', async () => {
    let exitCode = null;

    const mockServer = {
      close: (cb) => {
        cb(new Error('EADDRINUSE / close failed'));
      },
    };

    const cleanup = registerShutdownHandlers(mockServer, {
      exit: (code) => {
        exitCode = code;
      },
      log: () => {},
    });

    try {
      process.emit('SIGTERM');
      assert.equal(exitCode, 1, 'process.exit must be called with 1 on close error');
    } finally {
      cleanup();
    }
  });

  it('removes process listeners when cleanup is invoked', () => {
    const mockServer = { close: () => {} };
    const termListenersBefore = process.listenerCount('SIGTERM');
    const intListenersBefore = process.listenerCount('SIGINT');

    const cleanup = registerShutdownHandlers(mockServer, {
      exit: () => {},
      log: () => {},
    });

    assert.equal(process.listenerCount('SIGTERM'), termListenersBefore + 1);
    assert.equal(process.listenerCount('SIGINT'), intListenersBefore + 1);

    cleanup();

    assert.equal(process.listenerCount('SIGTERM'), termListenersBefore);
    assert.equal(process.listenerCount('SIGINT'), intListenersBefore);
  });
});
