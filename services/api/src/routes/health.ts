import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { RouteContext } from './context.js';

async function check(fn: () => Promise<unknown>, timeoutMs = 2000): Promise<'ok' | 'error'> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return 'ok';
  } catch {
    return 'error';
  }
}

export function healthRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  // Liveness: the process is up. Never checks dependencies.
  app.get('/api/healthz', { logLevel: 'warn' }, async () => ({ status: 'ok' }));

  // Readiness: can we serve traffic? The price-service is deliberately NOT checked:
  // it is a soft dependency and must not take the api out of rotation.
  app.get('/api/readyz', { logLevel: 'warn' }, async (_request, reply) => {
    const checks: Record<string, 'ok' | 'error'> = {
      postgres: await check(() => sql`select 1`.execute(deps.db)),
      redis: await check(() => deps.redis.ping()),
      storage: await check(() => deps.storage.ping()),
    };
    const ready = Object.values(checks).every((v) => v === 'ok');
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });
}
