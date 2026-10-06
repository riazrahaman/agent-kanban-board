#!/usr/bin/env node
/**
 * Zero-dependency local stand-in for GitHub's "create an issue" endpoint
 * (`POST /repos/:owner/:repo/issues`), for demoing/testing Report-a-bug
 * (v2.16.0) without filing a real issue or needing a real PAT.
 *
 * Point the server at it instead of https://api.github.com:
 *
 *   node scripts/stub-github-issues.mjs &
 *   KANBAN_REPORT_GITHUB_API_URL=http://localhost:3456 \
 *   KANBAN_REPORT_GITHUB_TOKEN=stub-token \
 *   KANBAN_REPORT_REPO=owner/repo \
 *   TURNSTILE_SECRET=1x0000000000000000000000000000000AA \
 *   TURNSTILE_SITE_KEY=1x00000000000000000000AA \
 *   npm --prefix server start
 *
 * Every request it receives is printed (method, path, and the parsed JSON
 * body — title/body/labels), so you can see exactly what the server would
 * have sent to the real GitHub API. It always answers 201 with a fake
 * issue number + html_url; it does not implement the 422/429/5xx/label
 * fallback paths the real server-side retry logic handles (those are
 * covered by server/test/kanban.bugreports.test.js's injected fetch, which
 * does not need this stub).
 */
import http from 'node:http';

const PORT = Number(process.env.PORT) || 3456;
const ISSUES_PATH = /^\/repos\/([^/]+)\/([^/]+)\/issues\/?$/;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    console.log(`[stub-github] ${req.method} ${req.url}`);

    const match = ISSUES_PATH.exec(req.url || '');
    if (req.method !== 'POST' || !match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found (stub only implements POST /repos/:owner/:repo/issues)' }));
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Bad JSON body' }));
      return;
    }

    console.log('--- payload the real board would have sent to GitHub ---');
    console.log(JSON.stringify(payload, null, 2));
    console.log('----------------------------------------------------------');

    const [, owner, repo] = match;
    const number = Math.floor(Math.random() * 1000) + 1;
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      number,
      html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
    }));
  });
});

server.listen(PORT, () => {
  console.log(`[stub-github] GitHub issues stub listening on http://localhost:${PORT}`);
  console.log('[stub-github] point KANBAN_REPORT_GITHUB_API_URL at this URL to demo Report-a-bug without a real PAT.');
});
