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
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Only the calls the board and the setup scripts make are forwarded. */
export const ALLOWED_ROUTES = new Set(['POST /v1/chat/completions', 'GET /api/tags']);
export const MAX_BODY_BYTES = 1024 * 1024;

/** Constant-time bearer comparison over equal-length digests. */
export function bearerMatches(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Pure request check: returns null when allowed, else { status, error }. */
export function checkRequest({ method, url, authorization }, expectedAuth) {
  if (!bearerMatches(authorization, expectedAuth)) return { status: 401, error: 'unauthorized' };
  const path = String(url || '').split('?')[0];
  if (!ALLOWED_ROUTES.has(`${method} ${path}`)) return { status: 404, error: 'not_found' };
  return null;
}

export function createGateway({ token, target = 'http://127.0.0.1:11434', maxBodyBytes = MAX_BODY_BYTES, log = console } = {}) {
  const targetUrl = new URL(target);
  const expectedAuth = token.startsWith('Bearer ') ? token : `Bearer ${token}`;

  const server = http.createServer((req, res) => {
    const startTime = Date.now();
    const clientInfo = req.socket.remoteAddress || 'local';
    const fail = (status, error) => {
      res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error }));
    };

    const rejected = checkRequest({ method: req.method, url: req.url, authorization: req.headers['authorization'] }, expectedAuth);
    if (rejected) {
      log.warn(`[GATEWAY ${rejected.status}] ${rejected.error} from ${clientInfo}`);
      return fail(rejected.status, rejected.error);
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBodyBytes) return fail(413, 'payload_too_large');

    const headers = { ...req.headers, host: targetUrl.host };
    delete headers['authorization'];
    const proxyReq = http.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port || 11434,
      path: req.url,
      method: req.method,
      headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
      res.on('finish', () => {
        log.log(`[GATEWAY] ${req.method} ${req.url} -> ${proxyRes.statusCode} (${Date.now() - startTime}ms)`);
      });
    });
    proxyReq.on('error', (err) => {
      log.error('[GATEWAY PROXY ERROR]', err.message);
      if (!res.headersSent) fail(502, 'bad_gateway');
    });

    let received = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      received += chunk.length;
      if (received > maxBodyBytes) {
        tooLarge = true;
        proxyReq.destroy();
        if (!res.headersSent) fail(413, 'payload_too_large');
        return;
      }
      proxyReq.write(chunk);
    });
    req.on('end', () => { if (!tooLarge) proxyReq.end(); });
  });
  return { server, expectedAuth, targetUrl };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const PORT = parseInt(process.env.GATEWAY_PORT || '11435', 10);
  const TOKEN = process.env.GATEWAY_TOKEN || '';
  const OLLAMA_TARGET = process.env.OLLAMA_TARGET || 'http://127.0.0.1:11434';
  if (!TOKEN) {
    console.error('[GATEWAY ERROR] GATEWAY_TOKEN environment variable is required.');
    console.error('Usage: GATEWAY_TOKEN="your-secret" node scripts/gateway/ollama-tunnel-gateway.js');
    process.exit(1);
  }
  const { server, expectedAuth, targetUrl } = createGateway({ token: TOKEN, target: OLLAMA_TARGET });
  const PING_INTERVAL_MS = parseInt(process.env.GATEWAY_PING_INTERVAL_MS || '60000', 10);
  const PING_URL = process.env.GATEWAY_PING_URL || process.env.TUNNEL_PING_URL || '';

// Periodic keepalive: pings local Ollama and the tunnel endpoint to prevent
// DERP relay inactivity and TLS handshake drops.
if (PING_INTERVAL_MS > 0) {
  setInterval(async () => {
    try {
      await fetch(new URL('/api/tags', targetUrl), { signal: AbortSignal.timeout(5000) });
    } catch (err) {
      console.warn(`[GATEWAY PING] Local Ollama ping failed: ${err.message}`);
    }

    if (PING_URL) {
      try {
        const pingRes = await fetch(PING_URL, {
          headers: { Authorization: expectedAuth },
          signal: AbortSignal.timeout(10000),
        });
        if (!pingRes.ok) {
          console.warn(`[GATEWAY PING] Tunnel ping returned HTTP ${pingRes.status}`);
        }
      } catch (err) {
        console.warn(`[GATEWAY PING] Tunnel ping failed: ${err.message}`);
      }
    }
  }, PING_INTERVAL_MS).unref();
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Ollama Tunnel Gateway] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[Ollama Tunnel Gateway] Forwarding authorized requests to ${OLLAMA_TARGET}`);
  console.log(`[Ollama Tunnel Gateway] Token authentication active.`);
  if (PING_URL) {
    console.log(`[Ollama Tunnel Gateway] Keepalive heartbeat active for ${PING_URL} (every ${PING_INTERVAL_MS}ms)`);
  }
});
}
