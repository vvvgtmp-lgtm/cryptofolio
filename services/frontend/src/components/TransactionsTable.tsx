import { Trash2 } from 'lucide-react';
import { useDeleteTransaction } from '../hooks/portfolios';
import { formatQty, formatUsd } from '../lib/format';
import type { Transaction } from '../lib/types';
import { EmptyState, ErrorBanner } from './ui';

export function TransactionsTable({ items }: { items: Transaction[] }) {
  const remove = useDeleteTransaction();
  if (items.length === 0) return <EmptyState title="No transactions yet" />;
  return (
    <div className="space-y-3">
      <ErrorBanner error={remove.error} />
      <div className="-mx-5 overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-muted">
            <tr className="border-b border-border">
              <th className="px-5 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Asset</th>
              <th className="px-3 py-2 text-right font-medium">Quantity</th>
              <th className="px-3 py-2 text-right font-medium">Price</th>
              <th className="px-3 py-2 text-right font-medium">Fee</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
              <th className="px-3 py-2 font-medium">Note</th>
              <th className="px-5 py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((tx) => (
              <tr key={tx.id} className="border-b border-border/60 last:border-0">
                <td className="num px-5 py-3 text-muted">{new Date(tx.executedAt).toLocaleString()}</td>
                <td className="px-3 py-3">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium uppercase ${tx.type === 'buy' ? 'bg-gain/15 text-gain' : 'bg-loss/15 text-loss'}`}>{tx.type}</span>
                </td>
                <td className="px-3 py-3">{tx.coinId}</td>
                <td className="num px-3 py-3 text-right">{formatQty(tx.quantity)}</td>
                <td className="num px-3 py-3 text-right">{formatUsd(tx.priceUsd)}</td>
                <td className="num px-3 py-3 text-right text-muted">{formatUsd(tx.feeUsd)}</td>
                <td className="num px-3 py-3 text-right">{formatUsd(tx.totalUsd)}</td>
                <td className="max-w-40 truncate px-3 py-3 text-muted">{tx.note}</td>
                <td className="px-5 py-3 text-right">
                  <button
                    type="button"
                    aria-label="Delete transaction"
                    className="text-muted hover:text-loss disabled:opacity-40"
                    disabled={remove.isPending}
                    onClick={() => window.confirm('Delete this transaction?') && remove.mutate(tx.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
