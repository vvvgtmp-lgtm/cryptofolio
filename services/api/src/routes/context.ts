import type { FastifyRequest } from 'fastify';
import type { Deps } from '../deps.js';
import type { TokenService } from '../lib/tokens.js';

export interface RouteContext {
  deps: Deps;
  tokens: TokenService;
  /** preHandler that sets request.userId or throws 401. */
  authenticate: (request: FastifyRequest) => Promise<void>;
}
