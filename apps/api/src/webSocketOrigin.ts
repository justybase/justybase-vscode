import type { FastifyReply, FastifyRequest, preValidationHookHandler } from 'fastify';

/**
 * Browser WebSocket handshakes are not protected by CORS. When an explicit
 * web-origin allowlist is configured, require the handshake Origin to match
 * it before cookie authentication is attempted.
 */
export function createWebSocketOriginGuard(origins: readonly string[]): preValidationHookHandler {
  const allowedOrigins = new Set(origins);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    // An empty list means the API is used same-origin or by non-browser
    // clients. Keep that existing mode backwards compatible.
    if (allowedOrigins.size === 0) return;
    const origin = request.headers.origin;
    if (typeof origin === 'string' && allowedOrigins.has(origin)) return;
    return reply.code(403).send({ code: 'FORBIDDEN', message: 'WebSocket origin is not allowed.' });
  };
}
