import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, registerUser, resetState, type TestApp } from './helpers.js';

describe('auth', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await buildTestApp();
  });
  beforeEach(() => resetState(t.deps));
  afterAll(() => t.close());

  const login = (email: string, password: string) =>
    t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

  it('registers, normalises email and sets an httpOnly refresh cookie', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: '  Alice@Example.COM ', password: 'password123', displayName: 'Alice' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ email: 'alice@example.com', displayName: 'Alice', avatarUrl: null });
    expect(res.json().accessToken).toEqual(expect.any(String));
    const cookie = res.cookies.find((c) => c.name === 'cf_refresh');
    expect(cookie).toMatchObject({ httpOnly: true, path: '/api/auth', sameSite: 'Strict' });
  });

  it('rejects a duplicate email with 409', async () => {
    await registerUser(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'alice@example.com', password: 'password123', displayName: 'A' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a short password with a validation error', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'bob@example.com', password: 'short', displayName: 'Bob' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('logs in with the right password only', async () => {
    await registerUser(t.app);
    expect((await login('alice@example.com', 'password123')).statusCode).toBe(200);
    const bad = await login('alice@example.com', 'wrong-password');
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('invalid_credentials');
    expect((await login('nobody@example.com', 'password123')).statusCode).toBe(401);
  });

  it('rate limits login attempts per IP', async () => {
    for (let i = 0; i < 5; i++) await login('alice@example.com', 'nope-nope');
    const res = await login('alice@example.com', 'nope-nope');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
  });

  it('issues a new access token from the refresh cookie', async () => {
    const reg = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'carol@example.com', password: 'password123', displayName: 'Carol' },
    });
    const refreshCookie = reg.cookies.find((c) => c.name === 'cf_refresh')!.value;
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cf_refresh: refreshCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toEqual(expect.any(String));
  });

  it('refuses refresh without a cookie or with an access token', async () => {
    const { token } = await registerUser(t.app);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/refresh' })).statusCode).toBe(401);
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cf_refresh: token } });
    expect(res.statusCode).toBe(401);
  });

  it('does not let a spoofed X-Forwarded-For bypass the login rate limit', async () => {
    // The gateway APPENDS the real client address; only that last hop may be trusted.
    const attempt = (i: number) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'alice@example.com', password: 'nope-nope' },
        headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.9` },
      });
    for (let i = 0; i < 5; i++) await attempt(i);
    expect((await attempt(99)).statusCode).toBe(429);
  });

  it('rate limits registrations per IP', async () => {
    const register = (i: number) =>
      t.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: `u${i}@example.com`, password: 'password123', displayName: 'U' } });
    for (let i = 0; i < 5; i++) expect((await register(i)).statusCode).toBe(201);
    expect((await register(5)).statusCode).toBe(429);
  });

  it('refresh tokens are single-use (rotated)', async () => {
    const reg = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'dan@example.com', password: 'password123', displayName: 'Dan' } });
    const first = reg.cookies.find((c) => c.name === 'cf_refresh')!.value;
    const refreshed = await t.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cf_refresh: first } });
    expect(refreshed.statusCode).toBe(200);
    const second = refreshed.cookies.find((c) => c.name === 'cf_refresh')!.value;
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cf_refresh: first } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cf_refresh: second } })).statusCode).toBe(200);
  });

  it('logout revokes the refresh token', async () => {
    const reg = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'eve@example.com', password: 'password123', displayName: 'Eve' } });
    const cookie = reg.cookies.find((c) => c.name === 'cf_refresh')!.value;
    await t.app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { cf_refresh: cookie } });
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cf_refresh: cookie } })).statusCode).toBe(401);
  });

  it('logout clears the cookie', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(res.statusCode).toBe(204);
    expect(res.cookies.find((c) => c.name === 'cf_refresh')?.value).toBe('');
  });

  it('GET /api/me requires a valid bearer token', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    const bad = await t.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer nope' } });
    expect(bad.statusCode).toBe(401);
    const { headers, userId } = await registerUser(t.app);
    const res = await t.app.inject({ method: 'GET', url: '/api/me', headers });
    expect(res.json()).toMatchObject({ id: userId, email: 'alice@example.com' });
  });

  it('PATCH /api/me updates the display name', async () => {
    const { headers } = await registerUser(t.app);
    const res = await t.app.inject({ method: 'PATCH', url: '/api/me', headers, payload: { displayName: 'Alice Cooper' } });
    expect(res.json().displayName).toBe('Alice Cooper');
  });
});
