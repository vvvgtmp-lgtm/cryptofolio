import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertKnownCoin } from '../lib/priceClient.js';
import { parse } from '../lib/validation.js';
import type { RouteContext } from './context.js';

export function watchlistRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const { db, prices } = deps;

  app.get('/api/watchlist', async (request) => {
    const rows = await db.selectFrom('watchlist').select('coin_id').where('user_id', '=', request.userId).orderBy('created_at').execute();
    const { coins, stale } = await prices.getCoins();
    const byId = new Map(coins.map((c) => [c.id, c]));
    const items = rows.map((r) => byId.get(r.coin_id)).filter((c) => c !== undefined);
    return { items, stale };
  });

  app.post('/api/watchlist', async (request, reply) => {
    const { coinId } = parse(z.object({ coinId: z.string().min(1).max(100) }), request.body);
    await assertKnownCoin(prices, coinId);
    await db.insertInto('watchlist').values({ user_id: request.userId, coin_id: coinId }).onConflict((oc) => oc.doNothing()).execute();
    return reply.status(201).send({ coinId });
  });

  app.delete('/api/watchlist/:coinId', async (request, reply) => {
    const { coinId } = parse(z.object({ coinId: z.string().min(1).max(100) }), request.params);
    await db.deleteFrom('watchlist').where('user_id', '=', request.userId).where('coin_id', '=', coinId).execute();
    return reply.status(204).send();
  });
}
