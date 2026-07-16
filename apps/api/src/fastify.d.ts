import type { WebUser } from '@justybase/contracts';

declare module 'fastify' {
  interface FastifyRequest {
    sessionId: string | null;
    user: WebUser | null;
  }
}
