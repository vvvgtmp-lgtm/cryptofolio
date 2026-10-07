import type { Kysely, Selectable } from 'kysely';
import type { DB, TransactionsTable } from '../db/database.js';
import { notFound } from './errors.js';
import type { TxInput } from './holdings.js';

export type TxRow = Selectable<TransactionsTable>;

/** Throws 404 for a missing portfolio AND for someone else's portfolio (no information leak). */
export async function getOwnedPortfolio(db: Kysely<DB>, userId: string, portfolioId: string) {
  const portfolio = await db
    .selectFrom('portfolios')
    .selectAll()
    .where('id', '=', portfolioId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!portfolio) throw notFound('Portfolio');
  return portfolio;
}

/**
 * Same as getOwnedPortfolio but takes a row lock (SELECT ... FOR UPDATE) for the rest of the
 * transaction. Every writer that validates holdings (api and worker import) takes this lock,
 * so concurrent sells cannot both pass the oversell check.
 */
export async function lockOwnedPortfolio(db: Kysely<DB>, userId: string, portfolioId: string) {
  const portfolio = await db
    .selectFrom('portfolios')
    .selectAll()
    .where('id', '=', portfolioId)
    .where('user_id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  if (!portfolio) throw notFound('Portfolio');
  return portfolio;
}

export async function loadTransactions(
  db: Kysely<DB>,
  filter: { userId: string; portfolioId?: string; coinId?: string },
): Promise<TxRow[]> {
  let query = db
    .selectFrom('transactions as t')
    .innerJoin('portfolios as p', 'p.id', 't.portfolio_id')
    .selectAll('t')
    .where('p.user_id', '=', filter.userId);
  if (filter.portfolioId) query = query.where('t.portfolio_id', '=', filter.portfolioId);
  if (filter.coinId) query = query.where('t.coin_id', '=', filter.coinId);
  return query.orderBy('t.executed_at', 'desc').orderBy('t.created_at', 'desc').execute();
}

export const toTxInput = (row: TxRow): TxInput => ({
  coinId: row.coin_id,
  type: row.type,
  quantity: row.quantity,
  priceUsd: row.price_usd,
  feeUsd: row.fee_usd,
  executedAt: row.executed_at,
});

export const toTxDto = (row: TxRow) => ({
  id: row.id,
  portfolioId: row.portfolio_id,
  coinId: row.coin_id,
  type: row.type,
  quantity: Number(row.quantity),
  priceUsd: Number(row.price_usd),
  feeUsd: Number(row.fee_usd),
  totalUsd: Math.round((Number(row.quantity) * Number(row.price_usd) + Number(row.fee_usd)) * 100) / 100,
  executedAt: row.executed_at,
  note: row.note,
});
