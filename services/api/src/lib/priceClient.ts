import { badRequest, HttpError, notFound } from './errors.js';

export interface Quote {
  usd: number;
  change24h: number;
}
export interface CoinDto {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  currentPrice: number;
  change24h: number;
  marketCap: number;
}
export interface PriceHistory {
  id: string;
  days: number;
  points: [number, number][];
  stale: boolean;
}

export interface PriceClient {
  getCoins(): Promise<{ coins: CoinDto[]; stale: boolean }>;
  getPrices(ids: string[]): Promise<{ prices: Record<string, Quote>; stale: boolean }>;
  getHistory(id: string, days: number): Promise<PriceHistory>;
}

interface RawCoin {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  current_price: number;
  change_24h: number;
  market_cap: number;
}

const unavailable = () => new HttpError(502, 'price_service_unavailable', 'Price service is unavailable');

export class HttpPriceClient implements PriceClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 5000) {}

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw unavailable();
    }
    if (res.status === 404) throw notFound('Coin');
    if (!res.ok) throw unavailable();
    return (await res.json()) as T;
  }

  async getCoins() {
    const data = await this.get<{ coins: RawCoin[]; stale: boolean }>('/coins');
    return {
      coins: data.coins.map((c) => ({
        id: c.id, symbol: c.symbol, name: c.name, image: c.image,
        currentPrice: c.current_price, change24h: c.change_24h, marketCap: c.market_cap,
      })),
      stale: data.stale,
    };
  }

  async getPrices(ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return { prices: {}, stale: false };
    const data = await this.get<{ prices: Record<string, { usd: number; change_24h: number }>; stale: boolean }>(
      `/prices?ids=${encodeURIComponent(unique.join(','))}`,
    );
    const prices = Object.fromEntries(
      Object.entries(data.prices).map(([id, q]) => [id, { usd: q.usd, change24h: q.change_24h }]),
    );
    return { prices, stale: data.stale };
  }

  getHistory(id: string, days: number) {
    return this.get<PriceHistory>(`/history/${encodeURIComponent(id)}?days=${days}`);
  }
}

/** 400 unless the coin exists in the price-service catalogue. */
export async function assertKnownCoin(prices: PriceClient, coinId: string): Promise<CoinDto> {
  const { coins } = await prices.getCoins();
  const coin = coins.find((c) => c.id === coinId);
  if (!coin) throw badRequest(`Unknown coin: ${coinId}`);
  return coin;
}

/** Prices, or an empty stale result when the price-service is down (pages keep working). */
export async function pricesOrEmpty(prices: PriceClient, ids: string[]) {
  try {
    return await prices.getPrices(ids);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 502) return { prices: {} as Record<string, Quote>, stale: true };
    throw err;
  }
}
