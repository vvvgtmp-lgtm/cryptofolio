import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers.js';

describe('health', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await buildTestApp();
  });
  afterAll(() => t.close());

  it('liveness is always ok', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('readiness checks postgres and redis', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toMatchObject({ postgres: 'ok', redis: 'ok' });
  });

  it('exposes prometheus metrics', async () => {
    await t.app.inject({ method: 'GET', url: '/api/healthz' });
    const res = await t.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('http_request_duration_seconds');
  });

  it('echoes the request id', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/healthz', headers: { 'x-request-id': 'abc-123' } });
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});
