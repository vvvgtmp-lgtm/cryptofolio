import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const required = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  PRICE_SERVICE_URL: 'http://localhost:8000',
  JWT_ACCESS_SECRET: 'access-secret-0123456789abcdef-0123',
  JWT_REFRESH_SECRET: 'refresh-secret-0123456789abcdef-012',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
  S3_BUCKET_AVATARS: 'cf-avatars',
  S3_BUCKET_IMPORTS: 'cf-imports',
  S3_BUCKET_EXPORTS: 'cf-exports',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(required);
    expect(config.PORT).toBe(3000);
    expect(config.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(config.REFRESH_TOKEN_TTL_DAYS).toBe(7);
    expect(config.COOKIE_SECURE).toBe(false);
    expect(config.JOBS_STREAM).toBe('jobs');
    expect(config.LOGIN_RATE_LIMIT_PER_MINUTE).toBe(10);
  });

  it('coerces numbers and booleans from strings', () => {
    const config = loadConfig({ ...required, PORT: '8080', COOKIE_SECURE: 'true' });
    expect(config.PORT).toBe(8080);
    expect(config.COOKIE_SECURE).toBe(true);
  });

  it('names every missing variable', () => {
    expect(() => loadConfig({ REDIS_URL: 'redis://x' })).toThrow(/DATABASE_URL.*JWT_ACCESS_SECRET/s);
  });

  it('rejects JWT secrets shorter than 32 characters', () => {
    expect(() => loadConfig({ ...required, JWT_ACCESS_SECRET: 'only-sixteen-chr' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('refuses example secrets outside local development', () => {
    const example = { JWT_ACCESS_SECRET: 'change-me-local-dev-access-secret-00000', JWT_REFRESH_SECRET: 'change-me-local-dev-refresh-secret-0000' };
    expect(() => loadConfig({ ...required, ...example, APP_ENV: 'local' })).not.toThrow();
    expect(() => loadConfig({ ...required, ...example, APP_ENV: 'production' })).toThrow(/change-me/);
  });

  it('refuses identical access and refresh secrets outside local development', () => {
    const same = 'x'.repeat(40);
    expect(() => loadConfig({ ...required, JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same, APP_ENV: 'staging' })).toThrow(/must differ/);
  });

  it('trusts exactly one proxy hop by default', () => {
    expect(loadConfig(required).TRUST_PROXY_HOPS).toBe(1);
  });
});
