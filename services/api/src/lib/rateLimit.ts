import type { Redis } from 'ioredis';

/** Fixed-window counter in Redis. Returns true when the caller is over the limit. */
export async function isRateLimited(redis: Redis, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count > limit;
}
