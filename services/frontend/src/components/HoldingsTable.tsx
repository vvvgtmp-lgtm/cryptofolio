import { Link } from 'react-router-dom';
import { useCoinMap } from '../hooks/market';
import { formatPct, formatQty, formatUsd } from '../lib/format';
import type { Holding } from '../lib/types';
import { CoinIcon } from './CoinIcon';
import { PnlText } from './PnlText';
import { EmptyState } from './ui';

export function HoldingsTable({ holdings }: { holdings: Holding[] }) {
  const coins = useCoinMap();
  if (holdings.length === 0) return <EmptyState title="No holdings yet">Add a buy transaction to get started.</EmptyState>;
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-muted">
          <tr className="border-b border-border">
            <th className="px-5 py-2 font-medium">Asset</th>
            <th className="px-3 py-2 text-right font-medium">Quantity</th>
            <th className="px-3 py-2 text-right font-medium">Avg cost</th>
            <th className="px-3 py-2 text-right font-medium">Price</th>
            <th className="px-3 py-2 text-right font-medium">Value</th>
            <th className="px-3 py-2 text-right font-medium">Unrealized P/L</th>
            <th className="px-5 py-2 text-right font-medium">Alloc.</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => {
            const coin = coins.get(h.coinId);
            return (
              <tr key={h.coinId} className="border-b border-border/60 last:border-0 hover:bg-surface-2/50">
                <td className="px-5 py-3">
                  <Link to={`/markets/${h.coinId}`} className="flex items-center gap-2.5">
                    <CoinIcon coinId={h.coinId} image={coin?.image} />
                    <span className="font-medium">{coin?.name ?? h.coinId}</span>
                    <span className="text-xs uppercase text-muted">{coin?.symbol}</span>
                  </Link>
                </td>
                <td className="num px-3 py-3 text-right">{formatQty(h.quantity)}</td>
                <td className="num px-3 py-3 text-right text-muted">{formatUsd(h.avgCostUsd)}</td>
                <td className="num px-3 py-3 text-right">{formatUsd(h.priceUsd)}</td>
                <td className="num px-3 py-3 text-right font-medium">{formatUsd(h.valueUsd)}</td>
                <td className="px-3 py-3 text-right"><PnlText value={h.unrealizedPnlUsd} pct={h.unrealizedPnlPct} /></td>
                <td className="num px-5 py-3 text-right text-muted">{formatPct(h.allocationPct).replace('+', '')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
