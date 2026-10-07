import type { FastifyInstance, FastifyRequest } from 'fastify';
import { unauthorized } from '../lib/errors.js';
import type { TokenService } from '../lib/tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

/** Adds request.userId and returns a preHandler that requires a valid Bearer access token. */
export function setupAuth(app: FastifyInstance, tokens: TokenService) {
  app.decorateRequest('userId', '');
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    try {
      request.userId = tokens.verifyAccess(header.slice('Bearer '.length)).sub;
    } catch {
      throw unauthorized('Invalid or expired token');
    }
  };
}
