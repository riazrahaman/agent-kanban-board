/**
 * A6 (v3.12.4) — security response headers, including a tuned CSP.
 *
 * The server previously sent ZERO security headers: no `X-Content-Type-Options`,
 * no framing protection, no referrer policy, no CSP. This middleware is mounted
 * first in `createApp` so it covers EVERY response — API JSON, the SPA shell,
 * hashed assets, the `/api/events` SSE stream, and error responses alike.
 *
 * The CSP below is derived from the real client asset graph, not from a
 * template. Each non-`'self'` source is listed because the client genuinely
 * loads it:
 *
 *   - `script-src https://challenges.cloudflare.com` — the bug-report sheet
 *     loads Turnstile's `api.js` (client/src/components/BugReportDialog.tsx).
 *     The script is created lazily and is the only remote script on the board.
 *     Cloudflare documents this exact allow-list as the supported alternative
 *     to their nonce/strict-dynamic approach (their api.js creates only
 *     src-bearing <script> elements: no eval, no Function, no inline script).
 *   - `style-src https://fonts.googleapis.com` — index.html links the IBM Plex
 *     Sans / Instrument Serif / JetBrains Mono stylesheet used by the About and
 *     Field Guide views.
 *   - `font-src https://fonts.gstatic.com` — the font FILES that stylesheet
 *     references (the second preconnect in index.html points here).
 *   - `connect-src https://abacus-production-cbb0.up.railway.app` — the public
 *     visit counter fetched by client/src/lib/useVisitCount.ts. `'self'` also
 *     covers the SSE stream (`/api/events`) and every `/api/*` call.
 *   - `connect-src https://challenges.cloudflare.com` — Turnstile's own
 *     challenge traffic (and its pre-clearance fetch); the widget's iframe is
 *     admitted by `frame-src`.
 *
 * `script-src` does NOT contain `'unsafe-inline'`. The only inline script on
 * the board is the tiny pre-paint theme bootstrap in client/index.html (it must
 * run synchronously in <head> to avoid a flash of the wrong theme), so it is
 * allowed by its SHA-256 hash instead. The hash is pinned by
 * server/test/kanban.headers.test.js, which re-hashes the script in
 * client/index.html — editing that script without updating the hash fails the
 * suite rather than silently breaking theme bootstrapping in the browser.
 *
 * `style-src` keeps `'unsafe-inline'` because React style props are emitted as
 * style ATTRIBUTES (the board's inline card colours, the Field Guide's layout
 * values); hashes do not apply to attributes without `'unsafe-hashes'`, which
 * would be broader than the attribute case we actually use.
 */

/**
 * SHA-256 of the inline <head> theme bootstrap in client/index.html, base64.
 * Pinned by server/test/kanban.headers.test.js.
 */
export const INLINE_THEME_SCRIPT_SHA256 =
  "'sha256-x9b46pAjEzvQ0MwRsE8iGqr61CrU15qXfE6bE1ntqgc='";

/** The exact policy shipped on every response. Exported so tests can pin it. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${INLINE_THEME_SCRIPT_SHA256} https://challenges.cloudflare.com`,
  // 'unsafe-inline' is for React style attributes only — see the header comment.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://abacus-production-cbb0.up.railway.app https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Minimal Permissions-Policy: deny the powerful features this board never uses.
 * Nothing here is used by the client (no camera/mic/geolocation/payment/USB),
 * so a denial can only be protective. `fullscreen` is deliberately NOT denied —
 * the About page's walkthrough video uses the browser's fullscreen control.
 */
export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

/** Headers that are identical on every response. */
export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': PERMISSIONS_POLICY,
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
});

/**
 * Factory matching the other `server/middleware/*` modules.
 *
 * `setHeader` is safe on the SSE path: headers are set before the route calls
 * `flushHeaders()`, and the values are constant strings (no buffering, no
 * per-chunk work), so it cannot corrupt the stream.
 *
 * @returns {(req: import('express').Request, res: import('express').Response, next: Function) => void}
 */
export function createSecurityHeadersMiddleware() {
  return function securityHeaders(req, res, next) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }
    next();
  };
}
