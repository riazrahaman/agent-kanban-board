import cors from 'cors';

/**
 * Configures CORS with strict origin restrictions (spec Sec 6.3 A05, KB-06).
 *
 * Defaults to loopback / local origins only (never wildcard '*').
 * Can be overridden with comma-separated origins via KANBAN_ALLOWED_ORIGIN.
 */
export function configureCors() {
  const configured = process.env.KANBAN_ALLOWED_ORIGIN || process.env.ALLOWED_ORIGIN;

  const defaultOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:4000',
    'http://127.0.0.1:4000',
  ];

  const allowedOrigins = configured
    ? configured.split(',').map((o) => o.trim()).filter(Boolean)
    : defaultOrigins;

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
