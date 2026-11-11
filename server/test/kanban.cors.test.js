import test, { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configureCors } from '../middleware/cors.js';
import { createApp } from '../server.js';

const TOKEN = 'cors-test-token';

async function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe('CORS origin allowlist', () => {
  const orig = process.env.KANBAN_ALLOWED_ORIGIN;

  before(() => {
    process.env.KANBAN_AUTH_TOKEN = TOKEN;
  });

  after(() => {
    if (orig === undefined) delete process.env.KANBAN_ALLOWED_ORIGIN;
    else process.env.KANBAN_ALLOWED_ORIGIN = orig;
  });

  it('allows a single configured origin', async () => {
    process.env.KANBAN_ALLOWED_ORIGIN = 'https://one.example.test';
    const { server, baseUrl } = await startTestServer(createApp());
    try {
      const res = await fetch(`${baseUrl}/api/tasks`, {
        headers: { Origin: 'https://one.example.test' },
      });
      assert.equal(res.headers.get('access-control-allow-origin'), 'https://one.example.test');
      const other = await fetch(`${baseUrl}/api/tasks`, {
        headers: { Origin: 'https://two.example.test' },
      });
      assert.equal(other.headers.get('access-control-allow-origin'), null);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('allows a comma-separated list of origins', async () => {
    process.env.KANBAN_ALLOWED_ORIGIN = 'https://one.example.test, https://two.example.test';
    const { server, baseUrl } = await startTestServer(createApp());
    try {
      for (const origin of ['https://one.example.test', 'https://two.example.test']) {
        const res = await fetch(`${baseUrl}/api/tasks`, { headers: { Origin: origin } });
        assert.equal(res.headers.get('access-control-allow-origin'), origin);
      }
      const other = await fetch(`${baseUrl}/api/tasks`, {
        headers: { Origin: 'https://three.example.test' },
      });
      assert.equal(other.headers.get('access-control-allow-origin'), null);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects a wildcard origin', () => {
    process.env.KANBAN_ALLOWED_ORIGIN = '*';
    assert.throws(() => configureCors(), /must be one or more explicit origins/);
  });

  it('rejects an empty origin value', () => {
    process.env.KANBAN_ALLOWED_ORIGIN = '   ';
    assert.throws(() => configureCors(), /must be one or more explicit origins/);
  });

  it('allows a no-origin request', async () => {
    process.env.KANBAN_ALLOWED_ORIGIN = 'https://one.example.test';
    const { server, baseUrl } = await startTestServer(createApp());
    try {
      const res = await fetch(`${baseUrl}/api/tasks`);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
      assert.equal(res.status, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

/**
 * D8 (v3.12.6): the localhost dev origin is a development default, so a
 * production boot must refuse it unless the operator says otherwise.
 */
describe('production CORS guard', () => {
  const savedEnv = process.env.NODE_ENV;
  const savedOrigin = process.env.KANBAN_ALLOWED_ORIGIN;
  const savedDev = process.env.KANBAN_ALLOW_DEV_CORS;

  after(() => {
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    if (savedOrigin === undefined) delete process.env.KANBAN_ALLOWED_ORIGIN;
    else process.env.KANBAN_ALLOWED_ORIGIN = savedOrigin;
    if (savedDev === undefined) delete process.env.KANBAN_ALLOW_DEV_CORS;
    else process.env.KANBAN_ALLOW_DEV_CORS = savedDev;
  });

  it('refuses to boot with no allowlist and no explicit opt-in', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.KANBAN_ALLOWED_ORIGIN;
    delete process.env.KANBAN_ALLOW_DEV_CORS;
    assert.throws(
      () => createApp(),
      /KANBAN_ALLOWED_ORIGIN is unset while NODE_ENV=production/,
    );
  });

  it('boots with KANBAN_ALLOW_DEV_CORS=1 and keeps the dev origin', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.KANBAN_ALLOWED_ORIGIN;
    process.env.KANBAN_ALLOW_DEV_CORS = '1';
    const app = createApp();
    const { server, baseUrl } = await startTestServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/tasks`, {
        headers: { Origin: 'http://localhost:5173' },
      });
      assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('boots with an explicit production allowlist', async () => {
    process.env.NODE_ENV = 'production';
    process.env.KANBAN_ALLOWED_ORIGIN = 'https://board.example.test';
    delete process.env.KANBAN_ALLOW_DEV_CORS;
    const app = createApp();
    const { server, baseUrl } = await startTestServer(app);
    try {
      const res = await fetch(`${baseUrl}/api/tasks`, {
        headers: { Origin: 'https://board.example.test' },
      });
      assert.equal(res.headers.get('access-control-allow-origin'), 'https://board.example.test');
      const dev = await fetch(`${baseUrl}/api/tasks`, {
        headers: { Origin: 'http://localhost:5173' },
      });
      assert.equal(dev.headers.get('access-control-allow-origin'), null);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('non-production keeps the permissive dev default', () => {
    delete process.env.NODE_ENV;
    delete process.env.KANBAN_ALLOWED_ORIGIN;
    delete process.env.KANBAN_ALLOW_DEV_CORS;
    assert.doesNotThrow(() => configureCors());
  });
});
