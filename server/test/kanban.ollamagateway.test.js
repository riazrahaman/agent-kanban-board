import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway, checkRequest, bearerMatches } from '../../scripts/gateway/ollama-tunnel-gateway.js';

const silent = { log() {}, warn() {}, error() {} };
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

describe('ollama tunnel gateway', () => {
  it('checkRequest allows only the documented routes behind a Bearer token', () => {
    const exp = 'Bearer s3cret';
    assert.equal(checkRequest({ method: 'POST', url: '/v1/chat/completions', authorization: exp }, exp), null);
    assert.equal(checkRequest({ method: 'GET', url: '/api/tags?x=1', authorization: exp }, exp), null);
    assert.equal(checkRequest({ method: 'DELETE', url: '/api/delete', authorization: exp }, exp).status, 404);
    assert.equal(checkRequest({ method: 'GET', url: '/v1/chat/completions', authorization: exp }, exp).status, 404);
    assert.equal(checkRequest({ method: 'POST', url: '/v1/chat/completions', authorization: 's3cret' }, exp).status, 401);
    assert.equal(bearerMatches('a', 'ab'), false);
  });

  it('proxies allowed calls, rejects others, and caps the body', async () => {
    const seen = [];
    const upstream = http.createServer((req, res) => { seen.push(req.url); req.resume(); req.on('end', () => res.end('{"ok":true}')); });
    const up = await listen(upstream);
    const { server } = createGateway({ token: 'tok', target: `http://127.0.0.1:${up}`, maxBodyBytes: 100, log: silent });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;
    const h = { Authorization: 'Bearer tok' };
    try {
      assert.equal((await fetch(`${base}/`)).status, 401);
      assert.equal((await fetch(`${base}/api/pull`, { method: 'POST', headers: h })).status, 404);
      assert.equal((await fetch(`${base}/api/tags`, { headers: h })).status, 200);
      assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: h, body: 'x'.repeat(50) })).status, 200);
      assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: h, body: 'x'.repeat(500) })).status, 413);
      assert.deepEqual(seen, ['/api/tags', '/v1/chat/completions']);
    } finally {
      await new Promise((r) => server.close(r));
      await new Promise((r) => upstream.close(r));
    }
  });
});
