import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/database.js';
import { closeDeps, type Deps } from '../../src/deps.js';
import { HttpError, notFound } from '../../src/lib/errors.js';
import { RedisJobQueue } from '../../src/lib/queue.js';
import { S3Storage } from '../../src/lib/storage.js';
import type { CoinDto, PriceClient, Quote } from '../../src/lib/priceClient.js';

const S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:59000';

/** Defaults target docker-compose.test.yml from the host; containers override via env. */
export const TEST_ENV: Record<string, string> = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://cryptofolio:cryptofolio@localhost:55432/cryptofolio_test',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:56379/0',
  PRICE_SERVICE_URL: 'http://price-service.invalid',
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef-xyz',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef-xyz',
  REGISTER_RATE_LIMIT_PER_MINUTE: '5',
  LOG_LEVEL: 'silent',
  LOGIN_RATE_LIMIT_PER_MINUTE: '5',
  JOBS_STREAM: 'jobs-test',
  S3_ENDPOINT,
  // Tests talk to MinIO directly, so public == internal endpoint here.
  S3_PUBLIC_ENDPOINT: S3_ENDPOINT,
  S3_ACCESS_KEY: 'cryptofolio',
  S3_SECRET_KEY: 'cryptofolio-secret',
  S3_BUCKET_AVATARS: 'cf-avatars',
  S3_BUCKET_IMPORTS: 'cf-imports',
  S3_BUCKET_EXPORTS: 'cf-exports',
};

export async function resetState(deps: Deps): Promise<void> {
  await sql`TRUNCATE users, portfolios, transactions, watchlist, alerts, notifications, portfolio_snapshots, jobs CASCADE`.execute(deps.db);
  await deps.redis.flushdb();
}

export interface TestApp {
  app: FastifyInstance;
  deps: Deps;
  prices: FakePriceClient;
  close: () => Promise<void>;
}

export async function buildTestApp(): Promise<TestApp> {
  const config = loadConfig(TEST_ENV);
  const prices = new FakePriceClient();
  const redis = new Redis(config.REDIS_URL);
  const deps: Deps = {
    config,
    db: createDb(config.DATABASE_URL),
    redis,
    prices,
    storage: new S3Storage(config),
    queue: new RedisJobQueue(redis, config.JOBS_STREAM),
  };
  await resetState(deps);
  const app = buildApp(deps);
  await app.ready();
  return {
    app,
    deps,
    prices,
    close: async () => {
      await app.close();
      await closeDeps(deps);
    },
  };
}

export class FakePriceClient implements PriceClient {
  down = false;
  quotes: Record<string, Quote> = {
    bitcoin: { usd: 50000, change24h: 2 },
    ethereum: { usd: 3000, change24h: -1 },
    solana: { usd: 100, change24h: 5 },
  };

  private check() {
    if (this.down) throw new HttpError(502, 'price_service_unavailable', 'Price service is unavailable');
  }

  async getCoins() {
    this.check();
    const coins: CoinDto[] = Object.entries(this.quotes).map(([id, q]) => ({
      id, symbol: id.slice(0, 3), name: id[0].toUpperCase() + id.slice(1), image: null,
      currentPrice: q.usd, change24h: q.change24h, marketCap: q.usd * 1e6,
    }));
    return { coins, stale: false };
  }

  async getPrices(ids: string[]) {
    this.check();
    return { prices: Object.fromEntries(ids.filter((i) => i in this.quotes).map((i) => [i, this.quotes[i]])), stale: false };
  }

  async getHistory(id: string, days: number) {
    this.check();
    if (!(id in this.quotes)) throw notFound('Coin');
    return { id, days, points: [[1, 1], [2, 2]] as [number, number][], stale: false };
  }
}

export async function registerUser(app: FastifyInstance, email = 'alice@example.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'password123', displayName: email.split('@')[0] },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const body = res.json();
  return {
    token: body.accessToken as string,
    userId: body.user.id as string,
    headers: { authorization: `Bearer ${body.accessToken}` },
  };
}
