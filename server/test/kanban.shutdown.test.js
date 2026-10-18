import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  // --- #108 -------------------------------------------------------------
  // Railway reported "Deploy Crashed" on every redeploy. The start command was
  // the first cause and was fixed in the dashboard; this is the second. An SSE
  // response is held open deliberately and for ever, so `server.close()` — which
  // waits for every open connection — never called back, and the process left
  // only via the timeout, after the platform had already killed the container.

  it('ends open event streams BEFORE calling server.close (#108)', () => {
    const order = [];

    const mockServer = {
      close: (cb) => {
        order.push('close');
        cb(null);
      },
      closeIdleConnections: () => order.push('closeIdleConnections'),
      closeAllConnections: () => order.push('closeAllConnections'),
    };

    const cleanup = registerShutdownHandlers(mockServer, {
      exit: () => {},
      log: () => {},
      drain: () => {
        order.push('drain');
        return 2;
      },
    });

    try {
      process.emit('SIGTERM');
      assert.deepEqual(
        order,
        ['drain', 'close', 'closeIdleConnections'],
        'draining after close would deadlock on the streams close() is waiting for',
      );
      assert.ok(
        !order.includes('closeAllConnections'),
        'in-flight requests must not be destroyed synchronously — that is the opposite of graceful',
      );
    } finally {
      cleanup();
    }
  });

  it('still exits when draining throws, and on a server with no closeAllConnections', () => {
    let exitCode = null;
    let closed = false;

    // No closeAllConnections: Node < 18.2, and the mock servers above.
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
      log: () => {},
      drain: () => {
        throw new Error('stream already destroyed');
      },
    });

    try {
      process.emit('SIGTERM');
      assert.equal(closed, true, 'a failed drain must not abort the shutdown');
      assert.equal(exitCode, 0);
    } finally {
      cleanup();
    }
  });

  it('exits promptly on SIGTERM with a live SSE stream attached (#108 end-to-end)', async () => {
    // The unit tests above use a mock server, so they cannot catch the real
    // defect: it only appears against a real http.Server holding a real open
    // response. Measured before the fix: ~5s (the full fallback timeout).
    const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
    const dataDir = await mkdtemp(path.join(tmpdir(), 'kanban-shutdown-'));
    // Ask the OS for a free port rather than guessing one: a random pick
    // collided with another listener under a full parallel suite run and made
    // this test flaky, which is worse than not having it.
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.on('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address();
        probe.close(() => resolve(free));
      });
    });

    const child = spawn(process.execPath, [serverPath], {
      // KANBAN_DATA_FILE as well as KANBAN_DATA_DIR: the DEFAULT project falls
      // back to the in-repo server/tasks.json, so without it this spawns a
      // server onto the real store, here and in CI.
      env: {
        ...process.env,
        PORT: String(port),
        KANBAN_DATA_DIR: dataDir,
        KANBAN_DATA_FILE: path.join(dataDir, 'tasks.json'),
        KANBAN_REAP_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      // Wait for the listener.
      const up = await Promise.race([
        new Promise((resolve) => {
          child.stdout.on('data', (b) => {
            if (String(b).includes('listening on')) resolve(true);
          });
        }),
        new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
      ]);
      assert.ok(up, 'the server under test must come up');

      // Attach a real SSE stream and wait until the response headers land, so
      // the connection is genuinely open when the signal arrives.
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      });
      assert.equal(res.status, 200);

      const started = Date.now();
      child.kill('SIGTERM');
      const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
      const elapsed = Date.now() - started;

      assert.equal(code, 0, 'a graceful shutdown exits 0');
      assert.ok(
        elapsed < 2000,
        `must not wait on the open stream: exited in ${elapsed}ms (the pre-fix path took ~5000ms, ` +
          'which is longer than the platform grace period, so the container was killed and reported as a crash)',
      );
      controller.abort();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
