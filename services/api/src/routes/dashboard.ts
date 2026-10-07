import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { computeHoldings } from '../lib/holdings.js';
import { loadTransactions, toTxInput } from '../lib/portfolios.js';
import { pricesOrEmpty } from '../lib/priceClient.js';
import { parse } from '../lib/validation.js';
import type { RouteContext } from './context.js';

export function dashboardRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const { db, prices } = deps;

  app.get('/api/dashboard', async (request) => {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), request.query);
    const portfolios = await db.selectFrom('portfolios').select(['id', 'name']).where('user_id', '=', request.userId).orderBy('created_at').execute();
    const txs = await loadTransactions(db, { userId: request.userId });
    const quotes = await pricesOrEmpty(prices, txs.map((tx) => tx.coin_id));
    const combined = computeHoldings(txs.map(toTxInput), quotes.prices);

    const history = await db
      .selectFrom('portfolio_snapshots as s')
      .innerJoin('portfolios as p', 'p.id', 's.portfolio_id')
      .select(['s.date', sql<string>`sum(s.value_usd)`.as('value')])
      .where('p.user_id', '=', request.userId)
      .where('s.date', '>=', sql<string>`current_date - ${days}::int`)
      .groupBy('s.date')
      .orderBy('s.date')
      .execute();

    return {
      totals: combined.totals,
      holdings: combined.holdings,
      portfolios: portfolios.map((p) => ({
        id: p.id,
        name: p.name,
        totals: computeHoldings(txs.filter((tx) => tx.portfolio_id === p.id).map(toTxInput), quotes.prices).totals,
      })),
      history: history.map((h) => ({ date: h.date, valueUsd: Number(h.value) })),
      stale: quotes.stale,
    };
  });
}
