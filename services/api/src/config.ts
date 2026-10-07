import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default('info'),
  APP_ENV: z.string().default('local'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PRICE_SERVICE_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  REGISTER_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  // Number of reverse proxies in front of the api (gateway = 1; GCP LB + gateway = 2).
  // Only these hops' X-Forwarded-For entries are trusted, so clients cannot spoof their IP.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  JOBS_STREAM: z.string().default('jobs'),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET_AVATARS: z.string().min(1),
  S3_BUCKET_IMPORTS: z.string().min(1),
  S3_BUCKET_EXPORTS: z.string().min(1),
});

export type Config = z.infer<typeof schema>;

/** Outside local development, placeholder or shared JWT secrets would let anyone forge tokens. */
function secretProblems(config: Config): string[] {
  if (config.APP_ENV === 'local') return [];
  const problems: string[] = [];
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
    if (config[key].includes('change-me')) problems.push(`${key}: still contains the "change-me" example value`);
  }
  if (config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET) problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
  return problems;
}

/** Reads configuration from environment variables and fails fast with a readable message. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const problems = secretProblems(result.data);
  if (problems.length) {
    throw new Error(`Insecure configuration for APP_ENV=${result.data.APP_ENV}:\n  ${problems.join('\n  ')}\n  Generate secrets with: openssl rand -base64 48`);
  }
  return result.data;
}
