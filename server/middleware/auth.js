/**
 * Authentication middleware for Agent Kanban API (spec Sec 6.3 A07, KB-04).
 *
 * Protects every mutating endpoint with the configured shared token. A missing
 * token is a configuration failure, not permission to run an open write API.
 */

export function createAuthMiddleware() {
  return (req, res, next) => {
    // Extract caller identity
    const agentId = req.headers['x-agent-id'] || req.body?.agent_id || null;
    const rawRole = req.headers['x-agent-role'] || req.body?.role || null;
    const role = typeof rawRole === 'string' ? rawRole.toLowerCase() : null;
    req.caller = { agent_id: agentId, role };

    const isMutation = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);
    if (!isMutation) {
      return next();
    }

    const requiredToken = process.env.KANBAN_AUTH_TOKEN;
    if (!requiredToken) {
      console.error('[kanban auth] KANBAN_AUTH_TOKEN is not configured; refusing mutation');
      return res.status(503).json({
        error: 'Mutating API is unavailable until KANBAN_AUTH_TOKEN is configured',
      });
    }

    const authHeader = req.headers['authorization'];
    const apiTokenHeader = req.headers['x-api-token'];

    let providedToken = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      providedToken = authHeader.slice(7).trim();
    } else if (apiTokenHeader) {
      providedToken = apiTokenHeader.trim();
    }

    if (!providedToken || providedToken !== requiredToken) {
      console.warn(
        `[kanban auth failure] 401 on ${req.method} ${req.originalUrl} (agent: ${agentId || 'anonymous'})`
      );
      return res.status(401).json({
        error: 'Unauthorized: valid token required for mutating operations',
      });
    }

    next();
  };
}
