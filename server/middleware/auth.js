/**
 * Authentication middleware for Agent Kanban API (spec Sec 6.3 A07, KB-04).
 *
 * Protects mutating endpoints (POST, PATCH, PUT, DELETE) when KANBAN_AUTH_TOKEN
 * is configured in the environment. Also extracts caller identity (agent_id, role)
 * from headers (X-Agent-Id, X-Agent-Role) or request body.
 */

export function createAuthMiddleware() {
  return (req, res, next) => {
    // Extract caller identity
    const agentId = req.headers['x-agent-id'] || req.body?.agent_id || null;
    const role = (req.headers['x-agent-role'] || req.body?.role || 'human').toLowerCase();
    req.caller = { agent_id: agentId, role };

    const requiredToken = process.env.KANBAN_AUTH_TOKEN || process.env.API_TOKEN;
    if (!requiredToken) {
      // In unauthenticated standalone mode, allow mutations
      return next();
    }

    // Only mutating requests require authentication (A07)
    const isMutation = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);
    if (!isMutation) {
      return next();
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
