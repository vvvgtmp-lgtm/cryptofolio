import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { aggregatePositions, OversellError, type TxInput } from '../lib/holdings.js';
import { getOwnedPortfolio, loadTransactions, lockOwnedPortfolio, toTxDto, toTxInput } from '../lib/portfolios.js';
import { assertKnownCoin } from '../lib/priceClient.js';
import { decimalString, parse, uuidParam } from '../lib/validation.js';
import type { RouteContext } from './context.js';

const createTx = z.object({
  coinId: z.string().min(1).max(100),
  type: z.enum(['buy', 'sell']),
  quantity: decimalString(),
  priceUsd: decimalString({ allowZero: true }),
  feeUsd: decimalString({ allowZero: true }).default('0'),
  executedAt: z.coerce.date().optional(),
  note: z.string().trim().max(200).optional(),
});

const FUTURE_TOLERANCE_MS = 5 * 60_000;

function assertNoOversell(txs: TxInput[], message?: string): void {
  try {
    aggregatePositions(txs);
  } catch (err) {
    if (err instanceof OversellError) throw new HttpError(422, 'insufficient_holdings', message ?? err.message);
    throw err;
  }
}

export function transactionRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const { db, prices } = deps;

  app.get('/api/portfolios/:id/transactions', async (request) => {
    const { id } = parse(uuidParam, request.params);
    await getOwnedPortfolio(db, request.userId, id);
    const rows = await loadTransactions(db, { userId: request.userId, portfolioId: id });
    return { items: rows.map(toTxDto) };
  });

  app.post('/api/portfolios/:id/transactions', async (request, reply) => {
    const { id } = parse(uuidParam, request.params);
    const body = parse(createTx, request.body);
    const executedAt = body.executedAt ?? new Date();
    if (executedAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) throw badRequest('executedAt cannot be in the future');
    await getOwnedPortfolio(db, request.userId, id);
    await assertKnownCoin(prices, body.coinId);

    // Check + insert under the portfolio lock so concurrent requests are serialised.
    const row = await db.transaction().execute(async (trx) => {
      await lockOwnedPortfolio(trx, request.userId, id);
      const existing = await loadTransactions(trx, { userId: request.userId, portfolioId: id, coinId: body.coinId });
      assertNoOversell([
        ...existing.map(toTxInput),
        { coinId: body.coinId, type: body.type, quantity: body.quantity, priceUsd: body.priceUsd, feeUsd: body.feeUsd, executedAt },
      ]);
      return trx
        .insertInto('transactions')
        .values({
          portfolio_id: id,
          coin_id: body.coinId,
          type: body.type,
          quantity: body.quantity,
          price_usd: body.priceUsd,
          fee_usd: body.feeUsd,
          executed_at: executedAt,
          note: body.note ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    return reply.status(201).send(toTxDto(row));
  });

  app.delete('/api/transactions/:id', async (request, reply) => {
    const { id } = parse(uuidParam, request.params);
    const tx = await db
      .selectFrom('transactions as t')
      .innerJoin('portfolios as p', 'p.id', 't.portfolio_id')
      .selectAll('t')
      .where('t.id', '=', id)
      .where('p.user_id', '=', request.userId)
      .executeTakeFirst();
    if (!tx) throw notFound('Transaction');

    await db.transaction().execute(async (trx) => {
      await lockOwnedPortfolio(trx, request.userId, tx.portfolio_id);
      const remaining = (await loadTransactions(trx, { userId: request.userId, portfolioId: tx.portfolio_id, coinId: tx.coin_id }))
        .filter((row) => row.id !== id)
        .map(toTxInput);
      assertNoOversell(remaining, 'Deleting this transaction would leave a later sell without enough holdings');
      await trx.deleteFrom('transactions').where('id', '=', id).execute();
    });
    return reply.status(204).send();
  });
}
