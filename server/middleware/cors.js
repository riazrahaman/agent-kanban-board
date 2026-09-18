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
  const allowedOrigins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (allowedOrigins.length === 0 || allowedOrigins.includes('*')) {
    throw new Error('KANBAN_ALLOWED_ORIGIN must be one or more explicit origins');
  }

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
