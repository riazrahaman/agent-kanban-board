#!/usr/bin/env node
/**
 * Zero-dependency local stand-in for the Telegram Bot API `sendMessage`
 * endpoint (and, optionally, Cloudflare Turnstile `siteverify`), for demoing
 * and testing Report-a-bug / Request-a-feature without sending a real
 * Telegram message or calling Cloudflare.
 *
 *   node scripts/stub-telegram.mjs &          # listens on :3457 (PORT=...)
 *   KANBAN_REPORT_TELEGRAM_API_URL=http://127.0.0.1:3457 \
 *   TURNSTILE_SITEVERIFY_URL=http://127.0.0.1:3457/turnstile/v0/siteverify \
 *   KANBAN_TELEGRAM_BOT_TOKEN=stub-bot-token KANBAN_TELEGRAM_CHAT_ID=-100123 \
 *   TURNSTILE_SECRET=1x0000000000000000000000000000000AA \
 *   TURNSTILE_SITE_KEY=1x00000000000000000000AA \
 *   KANBAN_REAP_ENABLED=false KANBAN_DEPLOY_DRIFT_INTERVAL_MS=0 \
 *   npm --prefix server start
 *
 * (A dummy KANBAN_TELEGRAM_BOT_TOKEN also arms the reclaim notifier, which
 * talks to the real api.telegram.org; KANBAN_REAP_ENABLED=false keeps it
 * from ever firing and KANBAN_DEPLOY_DRIFT_INTERVAL_MS=0 keeps the drift
 * alert off. Leave KANBAN_TELEGRAM_BACKUP_ENABLED unset.)
 *
 * Endpoints:
 *   POST /bot<token>/sendMessage       records the JSON body; answers like
 *                                      Telegram ({ok:true,result:{...}}) or
 *                                      per the current mode
 *   POST /turnstile/v0/siteverify      {success:true, action:"bug-report",
 *                                      hostname:<STUB_TURNSTILE_HOSTNAME|localhost>}
 *   GET  /__messages                   every recorded sendMessage body (JSON)
 *   POST /__mode?mode=ok|500|429|403   how the next sendMessage calls answer
 *   POST /__reset                      clears recorded messages, mode -> ok
 *
 * The bot token in the path is never printed: each request is logged as
 * `sendMessage chat=<id> chars=<n>`.
 */
import http from 'node:http';

const PORT = Number(process.env.PORT) || 3457;
const TURNSTILE_HOSTNAME = process.env.STUB_TURNSTILE_HOSTNAME || 'localhost';

let mode = 'ok';
let messages = [];
let nextId = 1;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://stub');
  const raw = await readBody(req);

  if (req.method === 'GET' && url.pathname === '/__messages') return send(res, 200, messages);
  if (req.method === 'POST' && url.pathname === '/__reset') {
    messages = [];
    mode = 'ok';
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/__mode') {
    mode = url.searchParams.get('mode') || 'ok';
    console.log(`[stub-telegram] mode=${mode}`);
    return send(res, 200, { ok: true, mode });
  }

  if (req.method === 'POST' && url.pathname === '/turnstile/v0/siteverify') {
    console.log('[stub-telegram] turnstile siteverify -> success');
    return send(res, 200, { success: true, action: 'bug-report', hostname: TURNSTILE_HOSTNAME });
  }

  if (req.method === 'POST' && /^\/bot[^/]+\/sendMessage$/.test(url.pathname)) {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { ok: false, error_code: 400, description: 'Bad Request: invalid JSON' });
    }
    messages.push({ receivedAt: new Date().toISOString(), mode, body });
    const chars = typeof body?.text === 'string' ? body.text.length : 0;
    console.log(`[stub-telegram] sendMessage chat=${body?.chat_id} chars=${chars} mode=${mode}`);
    if (mode === '500') return send(res, 500, { ok: false, error_code: 500, description: 'Internal Server Error' });
    if (mode === '403') {
      return send(res, 403, { ok: false, error_code: 403, description: 'Forbidden: bot is not a member of the channel chat' });
    }
    if (mode === '429') {
      return send(res, 429, {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 1',
        parameters: { retry_after: 1 },
      });
    }
    return send(res, 200, {
      ok: true,
      result: { message_id: nextId++, chat: { id: body?.chat_id }, date: Math.floor(Date.now() / 1000) },
    });
  }

  send(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stub-telegram] Telegram Bot API stub listening on http://127.0.0.1:${PORT}`);
});
