import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Deps } from './deps.js';
import { registerErrorHandler } from './lib/errors.js';
import { createTokenService } from './lib/tokens.js';
import { setupAuth } from './plugins/auth.js';
import { registerMetrics } from './plugins/metrics.js';
import { alertRoutes } from './routes/alerts.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import type { RouteContext } from './routes/context.js';
import { healthRoutes } from './routes/health.js';
import { jobRoutes } from './routes/jobs.js';
import { marketRoutes } from './routes/market.js';
import { meRoutes } from './routes/me.js';
import { notificationRoutes } from './routes/notifications.js';
import { portfolioRoutes } from './routes/portfolios.js';
import { transactionRoutes } from './routes/transactions.js';
import { uploadRoutes } from './routes/uploads.js';
import { watchlistRoutes } from './routes/watchlist.js';

export function buildApp(deps: Deps): FastifyInstance {
  const options: FastifyServerOptions = {
    logger: {
      level: deps.config.LOG_LEVEL,
      base: { service: 'api' },
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    // Trust only the last N X-Forwarded-For hops (our own proxies); earlier entries are client-controlled.
    trustProxy: (_address: string, hop: number) => hop < deps.config.TRUST_PROXY_HOPS,
  };
  const app = Fastify(options);

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  registerErrorHandler(app);
  registerMetrics(app);
  app.register(cookie);
  app.register(swagger, { openapi: { info: { title: 'CryptoFolio API', version: '1.0.0' } } });
  app.register(swaggerUi, { routePrefix: '/api/docs' });

  const tokens = createTokenService(deps.config);
  const ctx: RouteContext = { deps, tokens, authenticate: setupAuth(app, tokens) };

  app.register(async (api) => {
    // Public routes
    healthRoutes(api, ctx);
    authRoutes(api, ctx);
    marketRoutes(api, ctx);

    // Everything registered in here requires a valid access token.
    api.register(async (secured) => {
      secured.addHook('preHandler', ctx.authenticate);
      meRoutes(secured, ctx);
      watchlistRoutes(secured, ctx);
      alertRoutes(secured, ctx);
      notificationRoutes(secured, ctx);
      portfolioRoutes(secured, ctx);
      transactionRoutes(secured, ctx);
      dashboardRoutes(secured, ctx);
      uploadRoutes(secured, ctx);
      jobRoutes(secured, ctx);
    });
  });

  return app;
}
