#!/usr/bin/env node
/**
 * scripts/gateway/ollama-tunnel-gateway.js
 *
 * Lightweight local reverse proxy for Option 1 (Cloudflare Tunnel).
 *
 * Sits between Cloudflare Tunnel (cloudflared) and the local Ollama instance:
 *   [Railway Board (POST /api/ask)]
 *       | (HTTPS via Cloudflare Tunnel + Authorization: Bearer <TOKEN>)
 *   [Cloudflare Tunnel on Local Machine]
 *       | (HTTP localhost:11435)
 *   [ollama-tunnel-gateway.js]
 *       | (Verifies Authorization header matches GATEWAY_TOKEN)
 *       | (Forwards request to http://localhost:11434)
 *   [Ollama Instance (qwen3.6:latest)]
 *
 * Configuration via environment variables:
 *   GATEWAY_PORT: Port to listen on (default: 11435)
 *   GATEWAY_TOKEN: Required shared secret token for incoming requests.
 *   OLLAMA_TARGET: Upstream Ollama URL (default: http://127.0.0.1:11434)
 *
 * Usage:
 *   GATEWAY_TOKEN="your-secure-token" node scripts/gateway/ollama-tunnel-gateway.js
 */

import http from 'node:http';

const PORT = parseInt(process.env.GATEWAY_PORT || '11435', 10);
const TOKEN = process.env.GATEWAY_TOKEN || '';
const OLLAMA_TARGET = process.env.OLLAMA_TARGET || 'http://127.0.0.1:11434';

if (!TOKEN) {
  console.error('[GATEWAY ERROR] GATEWAY_TOKEN environment variable is required.');
  console.error('Usage: GATEWAY_TOKEN="your-secret" node scripts/gateway/ollama-tunnel-gateway.js');
  process.exit(1);
}

const targetUrl = new URL(OLLAMA_TARGET);

const server = http.createServer((req, res) => {
  // 1. Verify Authorization header
  const authHeader = req.headers['authorization'] || '';
  const expectedAuth = TOKEN.startsWith('Bearer ') ? TOKEN : `Bearer ${TOKEN}`;

  if (authHeader !== expectedAuth && authHeader !== TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized', message: 'Invalid or missing Authorization header' }));
    return;
  }

  // 2. Prepare upstream options
  const upstreamOptions = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || 11434,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: targetUrl.host,
    },
  };

  // Strip incoming auth header from forwarding to Ollama if preferred
  delete upstreamOptions.headers['authorization'];

  const proxyReq = http.request(upstreamOptions, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error('[GATEWAY PROXY ERROR]', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_gateway', message: `Failed to connect to local Ollama: ${err.message}` }));
    }
  });

  req.pipe(proxyReq, { end: true });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Ollama Tunnel Gateway] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[Ollama Tunnel Gateway] Forwarding authorized requests to ${OLLAMA_TARGET}`);
  console.log(`[Ollama Tunnel Gateway] Token authentication active.`);
});
