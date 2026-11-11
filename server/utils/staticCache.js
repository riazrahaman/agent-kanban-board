/**
 * B6 (v3.12.4) — cache policy for the built SPA.
 *
 * The old server used a bare `express.static(clientDist)` with no
 * `Cache-Control`, so browsers fell back to heuristic caching: every visitor
 * re-validated (or, worse, served a stale shell) on each load, and the
 * content-hashed `/assets/*` bundle — the one thing that is safe to cache
 * forever — got no immutable hint at all.
 *
 * The policy has three cases, expressed as a pure function so it can be unit
 * tested without a built `client/dist`:
 *
 *   1. HTML (`index.html`, including the SPA fallback): `no-cache` — it is the
 *      pointer into the hashed bundle, so it must be revalidated or a client
 *      can pin an old shell that references deleted asset URLs. (`no-cache`
 *      still permits a 304 when unchanged.) This case is checked FIRST: an
 *      ancestor directory named `assets` must never make the shell immutable.
 *   2. Content-hashed build output (`/assets/index-CoxX6heE.js`): Vite emits a
 *      new filename when the content changes, so a year + `immutable` is the
 *      correct, cheapest lifetime.
 *   3. Unhashed static files (`/favicon.svg`, `/landing/*.png`, `/media/*.mp4`):
 *      a short public lifetime. They keep stable names, so caching them forever
 *      would make a replaced file invisible; an hour is a safe middle ground.
 */

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const HTML_CACHE_CONTROL = 'no-cache';
export const STATIC_CACHE_CONTROL = 'public, max-age=3600';

function lastSegment(filePath) {
  const normalised = String(filePath ?? '').replace(/\\/g, '/');
  return normalised.slice(normalised.lastIndexOf('/') + 1).toLowerCase();
}

/**
 * Resolves the `Cache-Control` value for a file served out of `client/dist`.
 *
 * @param {string} filePath Absolute or relative path of the file being served.
 * @returns {string} The Cache-Control header value.
 */
export function staticCacheControl(filePath) {
  const normalised = String(filePath ?? '').replace(/\\/g, '/').toLowerCase();
  const name = lastSegment(normalised);

  // `index.html` and any other HTML entry: the revalidation point. Checked
  // BEFORE the `assets` segment test so an ANCESTOR directory named `assets`
  // (e.g. `/opt/assets/kanban/client/dist/index.html`) can never mark the shell
  // immutable — the shell must always revalidate.
  if (name.endsWith('.html')) return HTML_CACHE_CONTROL;

  // Vite's build output directory. Checking the SEGMENT (not a substring)
  // keeps a hypothetical `myassets/` directory from being treated as hashed.
  const segments = normalised.split('/');
  if (segments.includes('assets')) return IMMUTABLE_CACHE_CONTROL;

  return STATIC_CACHE_CONTROL;
}

/**
 * `express.static({ setHeaders })` adapter. Exported so the HTTP-level test can
 * mount a temp directory with the exact production wiring.
 *
 * @param {import('express').Response} res
 * @param {string} filePath
 */
export function setStaticHeaders(res, filePath) {
  res.setHeader('Cache-Control', staticCacheControl(filePath));
}
