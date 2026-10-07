import { Decimal } from 'decimal.js';
import type { Quote } from './priceClient.js';

export interface TxInput {
  coinId: string;
  type: 'buy' | 'sell';
  quantity: string | number;
  priceUsd: string | number;
  feeUsd: string | number;
  executedAt: Date;
}

export interface Position {
  coinId: string;
  quantity: Decimal;
  costBasis: Decimal;
  realizedPnl: Decimal;
}

export interface Holding {
  coinId: string;
  quantity: number;
  avgCostUsd: number;
  costBasisUsd: number;
  realizedPnlUsd: number;
  priceUsd: number | null;
  change24hPct: number | null;
  valueUsd: number | null;
  unrealizedPnlUsd: number | null;
  unrealizedPnlPct: number | null;
  allocationPct: number | null;
}

export interface Totals {
  valueUsd: number;
  costBasisUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number | null;
  realizedPnlUsd: number;
  change24hUsd: number;
  change24hPct: number | null;
  missingPrices: string[];
}

export class OversellError extends Error {
  constructor(public readonly coinId: string, public readonly available: string, public readonly requested: string) {
    super(`Cannot sell ${requested} ${coinId}: only ${available} held at that time`);
  }
}

const money = (d: Decimal) => d.toDecimalPlaces(2).toNumber();
const typeRank = (t: TxInput['type']) => (t === 'buy' ? 0 : 1);

/** Replays transactions in time order using the average-cost method. */
export function aggregatePositions(txs: TxInput[]): Map<string, Position> {
  const sorted = [...txs].sort(
    (a, b) => a.executedAt.getTime() - b.executedAt.getTime() || typeRank(a.type) - typeRank(b.type),
  );
  const positions = new Map<string, Position>();
  for (const tx of sorted) {
    const p = positions.get(tx.coinId) ?? {
      coinId: tx.coinId, quantity: new Decimal(0), costBasis: new Decimal(0), realizedPnl: new Decimal(0),
    };
    const qty = new Decimal(tx.quantity);
    const price = new Decimal(tx.priceUsd);
    const fee = new Decimal(tx.feeUsd);
    if (tx.type === 'buy') {
      p.quantity = p.quantity.plus(qty);
      p.costBasis = p.costBasis.plus(qty.times(price)).plus(fee);
    } else {
      if (qty.greaterThan(p.quantity)) throw new OversellError(tx.coinId, p.quantity.toString(), qty.toString());
      const costRemoved = p.costBasis.dividedBy(p.quantity).times(qty);
      p.realizedPnl = p.realizedPnl.plus(qty.times(price)).minus(fee).minus(costRemoved);
      p.quantity = p.quantity.minus(qty);
      p.costBasis = p.quantity.isZero() ? new Decimal(0) : p.costBasis.minus(costRemoved);
    }
    positions.set(tx.coinId, p);
  }
  return positions;
}

export function computeHoldings(txs: TxInput[], prices: Record<string, Quote>): { holdings: Holding[]; totals: Totals } {
  const positions = [...aggregatePositions(txs).values()];
  let value = new Decimal(0);
  let pricedCost = new Decimal(0);
  let change24h = new Decimal(0);
  const missingPrices: string[] = [];

  const open = positions.filter((p) => p.quantity.greaterThan(0));
  const rows = open.map((p) => {
    const quote = prices[p.coinId];
    const base = {
      coinId: p.coinId,
      quantity: p.quantity.toNumber(),
      avgCostUsd: money(p.costBasis.dividedBy(p.quantity)),
      costBasisUsd: money(p.costBasis),
      realizedPnlUsd: money(p.realizedPnl),
    };
    if (!quote) {
      missingPrices.push(p.coinId);
      return { ...base, priceUsd: null, change24hPct: null, valueD: null as Decimal | null, unrealizedPnlUsd: null, unrealizedPnlPct: null };
    }
    const valueD = p.quantity.times(quote.usd);
    const unrealized = valueD.minus(p.costBasis);
    const previous = valueD.dividedBy(1 + quote.change24h / 100);
    value = value.plus(valueD);
    pricedCost = pricedCost.plus(p.costBasis);
    change24h = change24h.plus(valueD.minus(previous));
    return {
      ...base,
      priceUsd: quote.usd,
      change24hPct: quote.change24h,
      valueD,
      unrealizedPnlUsd: money(unrealized),
      unrealizedPnlPct: p.costBasis.isZero() ? null : money(unrealized.dividedBy(p.costBasis).times(100)),
    };
  });

  const holdings: Holding[] = rows
    .map(({ valueD, ...row }) => ({
      ...row,
      valueUsd: valueD ? money(valueD) : null,
      allocationPct: valueD && !value.isZero() ? money(valueD.dividedBy(value).times(100)) : null,
    }))
    .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));

  const unrealizedTotal = value.minus(pricedCost);
  const previousTotal = value.minus(change24h);
  const totals: Totals = {
    valueUsd: money(value),
    costBasisUsd: money(pricedCost),
    unrealizedPnlUsd: money(unrealizedTotal),
    unrealizedPnlPct: pricedCost.isZero() ? null : money(unrealizedTotal.dividedBy(pricedCost).times(100)),
    realizedPnlUsd: money(positions.reduce((sum, p) => sum.plus(p.realizedPnl), new Decimal(0))),
    change24hUsd: money(change24h),
    change24hPct: previousTotal.greaterThan(0) ? money(change24h.dividedBy(previousTotal).times(100)) : null,
    missingPrices,
  };
  return { holdings, totals };
}
