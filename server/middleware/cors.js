import cors from 'cors';

/**
 * Configures CORS with strict origin restrictions (spec Sec 6.3 A05, KB-06).
 *
 * Defaults to the local Vite client origin (never wildcard '*').
 * The configured value is a single origin; additional origins must be
 * deliberately configured by the operator.
 */
export function configureCors() {
  const raw = (process.env.KANBAN_ALLOWED_ORIGIN || 'http://localhost:5173').trim();
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
