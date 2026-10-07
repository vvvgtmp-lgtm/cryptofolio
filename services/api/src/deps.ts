import { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import type { Config } from './config.js';
import { createDb, type DB } from './db/database.js';
import { HttpPriceClient, type PriceClient } from './lib/priceClient.js';
import { type JobQueue, RedisJobQueue } from './lib/queue.js';
import { S3Storage, type Storage } from './lib/storage.js';

/** Everything with I/O that route handlers need. Tests swap parts of it for fakes. */
export interface Deps {
  config: Config;
  db: Kysely<DB>;
  redis: Redis;
  prices: PriceClient;
  storage: Storage;
  queue: JobQueue;
}

export function createDeps(config: Config): Deps {
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
  return {
    config,
    db: createDb(config.DATABASE_URL),
    redis,
    prices: new HttpPriceClient(config.PRICE_SERVICE_URL),
    storage: new S3Storage(config),
    queue: new RedisJobQueue(redis, config.JOBS_STREAM),
  };
}

export async function closeDeps(deps: Deps): Promise<void> {
  await deps.db.destroy();
  deps.redis.disconnect();
}
