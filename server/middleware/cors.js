import cors from 'cors';

/**
 * Configures CORS with strict origin restrictions (spec Sec 6.3 A05, KB-06).
 *
 * Defaults to the local Vite client origin (never wildcard '*').
 * The configured value is a single origin; additional origins must be
 * deliberately configured by the operator.
 *
 * D8 (v3.12.6): that localhost default is a DEVELOPMENT convenience. Booting a
 * production deployment with it silently means the browser client served from
 * the real host is rejected (or, if an operator "fixes" it with a wildcard, the
 * API is opened to every origin). Production therefore refuses to start unless
 * an explicit allowlist is configured - or `KANBAN_ALLOW_DEV_CORS=1` says the
 * dev default is intentional (a local production-mode test, a same-host proxy).
 * Non-production keeps the historical default unchanged.
 */
export function configureCors() {
  const env = process.env;
  const rawValue = env.KANBAN_ALLOWED_ORIGIN;
  const configured = String(rawValue ?? '').trim();
  // An explicitly blank value stays a client error below (it is not "unset").
  const hasConfigured = rawValue !== undefined && rawValue !== null && configured !== '';
  const allowDevCors = env.KANBAN_ALLOW_DEV_CORS === '1';
  if (env.NODE_ENV === 'production' && !hasConfigured && !allowDevCors) {
    throw new Error(
      'Refusing to start: KANBAN_ALLOWED_ORIGIN is unset while NODE_ENV=production, so CORS ' +
      'would fall back to the localhost development origin (http://localhost:5173). ' +
      'Set KANBAN_ALLOWED_ORIGIN to one or more explicit origins, or set ' +
      'KANBAN_ALLOW_DEV_CORS=1 to accept the development default deliberately.'
    );
  }

  const raw = rawValue === undefined || rawValue === null ? 'http://localhost:5173' : configured;
  // Split + trim BEFORE normalization so the wildcard/empty rejections operate
  // on the raw user input (a `*` must still be rejected even though it lacks a
  // scheme and would otherwise be normalized to `https://*`).
  const rawOrigins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (rawOrigins.length === 0 || rawOrigins.includes('*')) {
    throw new Error('KANBAN_ALLOWED_ORIGIN must be one or more explicit origins');
  }

  // BUG-11 (v2.7.0): a bare host without a scheme (e.g. `example.com` from
  // RENDER_EXTERNAL_HOSTNAME) is not a valid CORS origin. Normalize it by
  // prefixing `https://` so the allowlist still matches the browser's full
  // origin string. Origins already carrying `://` pass through unchanged.
  const allowedOrigins = rawOrigins.map((o) => (o.includes('://') ? o : `https://${o}`));

  return cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. curl, server-to-server, mobile)
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Origin not allowed: omit Access-Control-Allow-Origin header
      return callback(null, false);
    },
    credentials: true,
  });
}
