import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/validation.js';
import type { RouteContext } from './context.js';

const idsQuery = z.object({ ids: z.string().min(1) });
const historyQuery = z.object({ days: z.coerce.number().pipe(z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(365)])).default(7) });

export function marketRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  app.get('/api/market/coins', async () => deps.prices.getCoins());

  app.get('/api/market/prices', async (request) => {
    const { ids } = parse(idsQuery, request.query);
    return deps.prices.getPrices(ids.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  });

  app.get('/api/market/history/:id', async (request) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(100) }), request.params);
    const { days } = parse(historyQuery, request.query);
    return deps.prices.getHistory(id, days);
  });
}
