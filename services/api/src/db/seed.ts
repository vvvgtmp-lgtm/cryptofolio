import bcrypt from 'bcryptjs';
import type { Kysely } from 'kysely';
import type { DB } from './database.js';

export const DEMO_EMAIL = 'demo@cryptofolio.local';
export const DEMO_PASSWORD = 'demo1234';

const DAY_MS = 86_400_000;

/** Inserts a demo user with sample data. Idempotent: returns false if the user already exists. */
export async function seedDemoData(db: Kysely<DB>, now = new Date()): Promise<boolean> {
  const existing = await db.selectFrom('users').select('id').where('email', '=', DEMO_EMAIL).executeTakeFirst();
  if (existing) return false;

  const daysAgo = (d: number) => new Date(now.getTime() - d * DAY_MS);

  await db.transaction().execute(async (trx) => {
    const user = await trx
      .insertInto('users')
      .values({ email: DEMO_EMAIL, password_hash: await bcrypt.hash(DEMO_PASSWORD, 10), display_name: 'Demo Trader' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const [longTerm, trading] = await trx
      .insertInto('portfolios')
      .values([
        { user_id: user.id, name: 'Long-term HODL' },
        { user_id: user.id, name: 'Active Trading' },
      ])
      .returning(['id', 'name'])
      .execute();

    const txs: Array<[string, string, 'buy' | 'sell', string, string, string, number]> = [
      [longTerm.id, 'bitcoin', 'buy', '0.5', '42000', '10', 400],
      [longTerm.id, 'ethereum', 'buy', '4', '2200', '5', 300],
      [longTerm.id, 'solana', 'buy', '50', '95', '2', 200],
      [longTerm.id, 'ethereum', 'sell', '1', '3500', '5', 60],
      [trading.id, 'dogecoin', 'buy', '10000', '0.08', '1', 90],
      [trading.id, 'cardano', 'buy', '2000', '0.35', '1', 45],
      [trading.id, 'chainlink', 'buy', '40', '12', '1', 20],
    ];
    await trx
      .insertInto('transactions')
      .values(
        txs.map(([portfolio_id, coin_id, type, quantity, price_usd, fee_usd, ago]) => ({
          portfolio_id, coin_id, type, quantity, price_usd, fee_usd, executed_at: daysAgo(ago),
        })),
      )
      .execute();

    await trx
      .insertInto('watchlist')
      .values(['bitcoin', 'ethereum', 'solana', 'avalanche-2'].map((coin_id) => ({ user_id: user.id, coin_id })))
      .execute();

    await trx
      .insertInto('alerts')
      .values({ user_id: user.id, coin_id: 'bitcoin', direction: 'above', target_price: '80000' })
      .execute();

    // 30 days of synthetic history so the chart is not empty on first run.
    // The worker writes real snapshots from then on.
    const snapshots = [];
    for (let i = 30; i >= 1; i--) {
      const date = daysAgo(i).toISOString().slice(0, 10);
      const drift = 0.9 + (0.1 * (30 - i)) / 30 + 0.02 * Math.sin(i / 2);
      snapshots.push({ portfolio_id: longTerm.id, date, value_usd: (48000 * drift).toFixed(2) });
      snapshots.push({ portfolio_id: trading.id, date, value_usd: (3000 * drift).toFixed(2) });
    }
    await trx.insertInto('portfolio_snapshots').values(snapshots).execute();

    await trx
      .insertInto('notifications')
      .values({ user_id: user.id, title: 'Welcome to CryptoFolio', body: 'This demo account comes with two sample portfolios.' })
      .execute();
  });
  return true;
}
