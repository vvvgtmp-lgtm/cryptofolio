import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { conflict, isUniqueViolation } from '../lib/errors.js';
import { computeHoldings } from '../lib/holdings.js';
import { getOwnedPortfolio, loadTransactions, toTxInput } from '../lib/portfolios.js';
import { pricesOrEmpty } from '../lib/priceClient.js';
import { parse, uuidParam } from '../lib/validation.js';
import type { RouteContext } from './context.js';

const portfolioBody = z.object({ name: z.string().trim().min(1).max(60) });
const daysQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

const toPortfolioDto = (p: { id: string; name: string; created_at: Date }) => ({ id: p.id, name: p.name, createdAt: p.created_at });

export function portfolioRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const { db, prices } = deps;

  app.get('/api/portfolios', async (request) => {
    const portfolios = await db.selectFrom('portfolios').selectAll().where('user_id', '=', request.userId).orderBy('created_at').execute();
    const txs = await loadTransactions(db, { userId: request.userId });
    const quotes = await pricesOrEmpty(prices, txs.map((tx) => tx.coin_id));
    const items = portfolios.map((p) => ({
      ...toPortfolioDto(p),
      totals: computeHoldings(txs.filter((tx) => tx.portfolio_id === p.id).map(toTxInput), quotes.prices).totals,
    }));
    return { items, stale: quotes.stale };
  });

  app.post('/api/portfolios', async (request, reply) => {
    const { name } = parse(portfolioBody, request.body);
    try {
      const portfolio = await db.insertInto('portfolios').values({ user_id: request.userId, name }).returningAll().executeTakeFirstOrThrow();
      return reply.status(201).send(toPortfolioDto(portfolio));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`You already have a portfolio named "${name}"`);
      throw err;
    }
  });

  app.get('/api/portfolios/:id', async (request) => {
    const { id } = parse(uuidParam, request.params);
    return toPortfolioDto(await getOwnedPortfolio(db, request.userId, id));
  });

  app.patch('/api/portfolios/:id', async (request) => {
    const { id } = parse(uuidParam, request.params);
    const { name } = parse(portfolioBody, request.body);
    await getOwnedPortfolio(db, request.userId, id);
    try {
      const updated = await db.updateTable('portfolios').set({ name }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      return toPortfolioDto(updated);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`You already have a portfolio named "${name}"`);
      throw err;
    }
  });

  app.delete('/api/portfolios/:id', async (request, reply) => {
    const { id } = parse(uuidParam, request.params);
    await getOwnedPortfolio(db, request.userId, id);
    await db.deleteFrom('portfolios').where('id', '=', id).execute();
    return reply.status(204).send();
  });

  app.get('/api/portfolios/:id/holdings', async (request) => {
    const { id } = parse(uuidParam, request.params);
    await getOwnedPortfolio(db, request.userId, id);
    const txs = await loadTransactions(db, { userId: request.userId, portfolioId: id });
    const quotes = await pricesOrEmpty(prices, txs.map((tx) => tx.coin_id));
    return { ...computeHoldings(txs.map(toTxInput), quotes.prices), stale: quotes.stale };
  });

  app.get('/api/portfolios/:id/snapshots', async (request) => {
    const { id } = parse(uuidParam, request.params);
    const { days } = parse(daysQuery, request.query);
    await getOwnedPortfolio(db, request.userId, id);
    const rows = await db
      .selectFrom('portfolio_snapshots')
      .select(['date', 'value_usd'])
      .where('portfolio_id', '=', id)
      .where('date', '>=', sql<string>`current_date - ${days}::int`)
      .orderBy('date')
      .execute();
    return { points: rows.map((r) => ({ date: r.date, valueUsd: Number(r.value_usd) })) };
  });
}
