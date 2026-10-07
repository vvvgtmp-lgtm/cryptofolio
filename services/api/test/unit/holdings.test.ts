import { describe, expect, it } from 'vitest';
import { aggregatePositions, computeHoldings, OversellError, type TxInput } from '../../src/lib/holdings.js';

let clock = 0;
const tx = (coinId: string, type: 'buy' | 'sell', quantity: string, priceUsd: string, feeUsd = '0', at?: number): TxInput => ({
  coinId, type, quantity, priceUsd, feeUsd, executedAt: new Date(at ?? ++clock * 1000),
});

describe('aggregatePositions', () => {
  it('includes fees in cost basis', () => {
    const p = aggregatePositions([tx('bitcoin', 'buy', '2', '100', '10')]).get('bitcoin')!;
    expect(p.quantity.toString()).toBe('2');
    expect(p.costBasis.toString()).toBe('210');
  });

  it('averages the cost of several buys', () => {
    const p = aggregatePositions([tx('bitcoin', 'buy', '1', '100'), tx('bitcoin', 'buy', '1', '200')]).get('bitcoin')!;
    expect(p.costBasis.dividedBy(p.quantity).toString()).toBe('150');
  });

  it('realises P/L on sells at average cost, net of fees', () => {
    const p = aggregatePositions([tx('bitcoin', 'buy', '2', '100'), tx('bitcoin', 'sell', '1', '150', '1')]).get('bitcoin')!;
    expect(p.realizedPnl.toString()).toBe('49');
    expect(p.quantity.toString()).toBe('1');
    expect(p.costBasis.toString()).toBe('100');
  });

  it('throws OversellError when selling more than held', () => {
    expect(() => aggregatePositions([tx('bitcoin', 'buy', '1', '100'), tx('bitcoin', 'sell', '1.5', '100')])).toThrow(OversellError);
  });

  it('throws when a sell is dated before the buy', () => {
    expect(() => aggregatePositions([tx('bitcoin', 'buy', '1', '100', '0', 5000), tx('bitcoin', 'sell', '1', '100', '0', 1000)])).toThrow(OversellError);
  });

  it('applies buys before sells on the same timestamp', () => {
    expect(() => aggregatePositions([tx('bitcoin', 'sell', '1', '100', '0', 7000), tx('bitcoin', 'buy', '1', '100', '0', 7000)])).not.toThrow();
  });

  it('uses exact decimal arithmetic (0.1 + 0.2 - 0.3 = 0)', () => {
    const p = aggregatePositions([
      tx('ethereum', 'buy', '0.1', '10'),
      tx('ethereum', 'buy', '0.2', '10'),
      tx('ethereum', 'sell', '0.3', '10'),
    ]).get('ethereum')!;
    expect(p.quantity.isZero()).toBe(true);
    expect(p.costBasis.isZero()).toBe(true);
  });
});

describe('computeHoldings', () => {
  const prices = { bitcoin: { usd: 50000, change24h: 25 }, ethereum: { usd: 3000, change24h: 0 } };

  it('computes value, unrealized P/L and allocation', () => {
    const { holdings, totals } = computeHoldings(
      [tx('bitcoin', 'buy', '1', '40000'), tx('ethereum', 'buy', '10', '2000')],
      prices,
    );
    expect(holdings.map((h) => [h.coinId, h.valueUsd, h.allocationPct])).toEqual([
      ['bitcoin', 50000, 62.5],
      ['ethereum', 30000, 37.5],
    ]);
    expect(totals).toMatchObject({ valueUsd: 80000, costBasisUsd: 60000, unrealizedPnlUsd: 20000, unrealizedPnlPct: 33.33 });
  });

  it('computes the 24h change from each coin change', () => {
    const { totals } = computeHoldings([tx('bitcoin', 'buy', '1', '40000')], prices);
    expect(totals.change24hUsd).toBe(10000);
    expect(totals.change24hPct).toBe(25);
  });

  it('drops closed positions from holdings but keeps realized P/L in totals', () => {
    const { holdings, totals } = computeHoldings([tx('bitcoin', 'buy', '1', '40000'), tx('bitcoin', 'sell', '1', '45000')], prices);
    expect(holdings).toHaveLength(0);
    expect(totals.realizedPnlUsd).toBe(5000);
  });

  it('reports missing prices without crashing', () => {
    const { holdings, totals } = computeHoldings([tx('solana', 'buy', '3', '100'), tx('bitcoin', 'buy', '1', '40000')], prices);
    const sol = holdings.find((h) => h.coinId === 'solana')!;
    expect(sol).toMatchObject({ valueUsd: null, priceUsd: null, unrealizedPnlUsd: null, costBasisUsd: 300 });
    expect(totals.valueUsd).toBe(50000);
    expect(totals.missingPrices).toEqual(['solana']);
  });

  it('handles an empty portfolio', () => {
    expect(computeHoldings([], prices).totals).toEqual({
      valueUsd: 0, costBasisUsd: 0, unrealizedPnlUsd: 0, unrealizedPnlPct: null,
      realizedPnlUsd: 0, change24hUsd: 0, change24hPct: null, missingPrices: [],
    });
  });
});
