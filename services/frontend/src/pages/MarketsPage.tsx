import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CoinIcon } from '../components/CoinIcon';
import { Card, ErrorBanner, inputClass, PageHeader, Spinner, StaleBadge } from '../components/ui';
import { WatchButton } from '../components/WatchButton';
import { useCoins } from '../hooks/market';
import { formatCompactUsd, formatPct, formatUsd, pnlClass } from '../lib/format';

export function MarketsPage() {
  const { data, isLoading, error } = useCoins();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const coins = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.coins ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q));
  }, [data, query]);

  return (
    <>
      <PageHeader title="Markets" subtitle="Top coins by market cap" actions={<StaleBadge stale={data?.stale} />} />
      <input className={`${inputClass} max-w-sm`} placeholder="Search coins…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ErrorBanner error={error} />
      {isLoading ? (
        <Spinner />
      ) : (
        <Card>
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-muted">
                <tr className="border-b border-border">
                  <th className="w-10 px-5 py-2" />
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Coin</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-3 py-2 text-right font-medium">24h</th>
                  <th className="px-5 py-2 text-right font-medium">Market cap</th>
                </tr>
              </thead>
              <tbody>
                {coins.map((c, i) => (
                  <tr key={c.id} onClick={() => navigate(`/markets/${c.id}`)} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-surface-2/50">
                    <td className="px-5 py-3"><WatchButton coinId={c.id} /></td>
                    <td className="num px-3 py-3 text-muted">{i + 1}</td>
                    <td className="px-3 py-3">
                      <span className="flex items-center gap-2.5">
                        <CoinIcon coinId={c.id} image={c.image} />
                        <span className="font-medium">{c.name}</span>
                        <span className="text-xs uppercase text-muted">{c.symbol}</span>
                      </span>
                    </td>
                    <td className="num px-3 py-3 text-right">{formatUsd(c.currentPrice)}</td>
                    <td className={`num px-3 py-3 text-right ${pnlClass(c.change24h)}`}>{formatPct(c.change24h)}</td>
                    <td className="num px-5 py-3 text-right text-muted">{formatCompactUsd(c.marketCap)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
