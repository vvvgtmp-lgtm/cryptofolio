import type { Redis } from 'ioredis';

export interface JobQueue {
  enqueue(jobId: string): Promise<void>;
}

/** Publishes job ids to a Redis Stream consumed by the worker's consumer group. */
export class RedisJobQueue implements JobQueue {
  constructor(private readonly redis: Redis, private readonly stream: string) {}

  async enqueue(jobId: string): Promise<void> {
    await this.redis.xadd(this.stream, 'MAXLEN', '~', '10000', '*', 'job_id', jobId);
  }
}
