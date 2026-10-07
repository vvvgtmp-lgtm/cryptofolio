import type { FastifyInstance } from 'fastify';
import client from 'prom-client';

/** Prometheus metrics at GET /metrics (internal only; the gateway does not route it). */
export function registerMetrics(app: FastifyInstance): client.Registry {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });

  app.addHook('onResponse', async (request, reply) => {
    httpDuration
      .labels(request.method, request.routeOptions.url ?? 'unmatched', String(reply.statusCode))
      .observe(reply.elapsedTime / 1000);
  });
  app.get('/metrics', { logLevel: 'warn' }, async (_request, reply) =>
    reply.type(registry.contentType).send(await registry.metrics()),
  );
  return registry;
}
