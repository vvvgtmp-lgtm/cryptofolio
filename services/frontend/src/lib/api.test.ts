import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: string, init?: RequestInit) => Promise<Response> | Response;
const client = (handler: Handler) => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  return { api: new ApiClient('/api', fetchMock as unknown as typeof fetch), fetchMock };
};
const authHeader = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.Authorization;

describe('ApiClient', () => {
  it('sends the bearer token and a JSON body', async () => {
    const { api, fetchMock } = client(() => json(200, { ok: true }));
    api.setAccessToken('t1');
    await api.post('/portfolios', { name: 'Main' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/portfolios');
    expect(init?.method).toBe('POST');
    expect(authHeader(init)).toBe('Bearer t1');
    expect(init?.body).toBe('{"name":"Main"}');
    expect(init?.credentials).toBe('include');
  });

  it('refreshes once on 401 and retries the request', async () => {
    const { api, fetchMock } = client((url, init) => {
      if (url === '/api/auth/refresh') return json(200, { accessToken: 'new' });
      return authHeader(init) === 'Bearer new' ? json(200, { value: 42 }) : json(401, { error: { code: 'unauthorized', message: 'expired' } });
    });
    api.setAccessToken('old');
    expect(await api.get<{ value: number }>('/me')).toEqual({ value: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('shares a single refresh between concurrent 401s', async () => {
    let refreshes = 0;
    const { api } = client(async (url, init) => {
      if (url === '/api/auth/refresh') {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { accessToken: 'new' });
      }
      return authHeader(init) === 'Bearer new' ? json(200, {}) : json(401, {});
    });
    api.setAccessToken('old');
    await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);
    expect(refreshes).toBe(1);
  });

  it('calls onUnauthorized and throws when refresh fails', async () => {
    const { api } = client(() => json(401, { error: { code: 'unauthorized', message: 'nope' } }));
    const onUnauthorized = vi.fn();
    api.onUnauthorized = onUnauthorized;
    await expect(api.get('/me')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('does not refresh for auth:false requests', async () => {
    const { api, fetchMock } = client(() => json(401, { error: { code: 'invalid_credentials', message: 'Invalid email or password' } }));
    await expect(api.post('/auth/login', {}, { auth: false })).rejects.toMatchObject({ code: 'invalid_credentials', message: 'Invalid email or password' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps error bodies and non-JSON errors to ApiError', async () => {
    const { api } = client(() => json(422, { error: { code: 'insufficient_holdings', message: 'Cannot sell', details: { x: 1 } } }));
    const err = await api.post('/x', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'insufficient_holdings', details: { x: 1 } });
    const { api: api2 } = client(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(api2.get('/x')).rejects.toMatchObject({ status: 502, code: 'http_error' });
  });

  it('returns undefined for 204', async () => {
    const { api } = client(() => new Response(null, { status: 204 }));
    expect(await api.del('/watchlist/bitcoin')).toBeUndefined();
  });
});
