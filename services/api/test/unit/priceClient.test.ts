import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/lib/errors.js';
import { HttpPriceClient, pricesOrEmpty } from '../../src/lib/priceClient.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('HttpPriceClient', () => {
  const client = new HttpPriceClient('http://prices.test');

  it('maps snake_case prices to camelCase', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { prices: { bitcoin: { usd: 1, change_24h: 2 } }, stale: false }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await client.getPrices(['bitcoin', 'bitcoin'])).toEqual({ prices: { bitcoin: { usd: 1, change24h: 2 } }, stale: false });
    expect(fetchMock.mock.calls[0][0]).toBe('http://prices.test/prices?ids=bitcoin');
  });

  it('does not call the service for an empty id list', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await client.getPrices([])).toEqual({ prices: {}, stale: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps coins', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, {
      coins: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', image: null, current_price: 5, change_24h: 1, market_cap: 9 }],
      stale: true,
    })));
    expect(await client.getCoins()).toEqual({
      coins: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', image: null, currentPrice: 5, change24h: 1, marketCap: 9 }],
      stale: true,
    });
  });

  it('turns 404 into not_found and 5xx / network errors into 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(404, { detail: 'unknown' })));
    await expect(client.getHistory('x', 7)).rejects.toMatchObject({ statusCode: 404 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(503, { detail: 'down' })));
    await expect(client.getCoins()).rejects.toMatchObject({ statusCode: 502, code: 'price_service_unavailable' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(client.getCoins()).rejects.toBeInstanceOf(HttpError);
  });

  it('pricesOrEmpty degrades to stale empty prices when the service is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(await pricesOrEmpty(client, ['bitcoin'])).toEqual({ prices: {}, stale: true });
  });
});
