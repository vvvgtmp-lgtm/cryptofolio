import type { FastifyInstance } from 'fastify';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { AlertsTable } from '../db/database.js';
import { notFound } from '../lib/errors.js';
import { assertKnownCoin, pricesOrEmpty } from '../lib/priceClient.js';
import { parse, uuidParam } from '../lib/validation.js';
import type { RouteContext } from './context.js';

const createAlert = z.object({
  coinId: z.string().min(1).max(100),
  direction: z.enum(['above', 'below']),
  targetPrice: z.coerce.number().positive(),
});

const toAlertDto = (a: Selectable<AlertsTable>, currentPrice: number | null) => ({
  id: a.id,
  coinId: a.coin_id,
  direction: a.direction,
  targetPrice: Number(a.target_price),
  active: a.active,
  triggeredAt: a.triggered_at,
  createdAt: a.created_at,
  currentPrice,
});

export function alertRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const { db, prices } = deps;

  app.get('/api/alerts', async (request) => {
    const alerts = await db.selectFrom('alerts').selectAll().where('user_id', '=', request.userId).orderBy('created_at', 'desc').execute();
    const quotes = await pricesOrEmpty(prices, alerts.map((a) => a.coin_id));
    return { items: alerts.map((a) => toAlertDto(a, quotes.prices[a.coin_id]?.usd ?? null)), stale: quotes.stale };
  });

  app.post('/api/alerts', async (request, reply) => {
    const body = parse(createAlert, request.body);
    const coin = await assertKnownCoin(prices, body.coinId);
    const alert = await db
      .insertInto('alerts')
      .values({ user_id: request.userId, coin_id: body.coinId, direction: body.direction, target_price: body.targetPrice })
      .returningAll()
      .executeTakeFirstOrThrow();
    return reply.status(201).send(toAlertDto(alert, coin.currentPrice));
  });

  app.delete('/api/alerts/:id', async (request, reply) => {
    const { id } = parse(uuidParam, request.params);
    const result = await db.deleteFrom('alerts').where('id', '=', id).where('user_id', '=', request.userId).executeTakeFirst();
    if (result.numDeletedRows === 0n) throw notFound('Alert');
    return reply.status(204).send();
  });
}
