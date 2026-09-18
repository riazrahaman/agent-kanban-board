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
