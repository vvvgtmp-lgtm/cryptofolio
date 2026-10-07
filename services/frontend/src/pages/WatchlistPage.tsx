import { Link } from 'react-router-dom';
import { CoinIcon } from '../components/CoinIcon';
import { Card, EmptyState, ErrorBanner, PageHeader, Spinner, StaleBadge } from '../components/ui';
import { WatchButton } from '../components/WatchButton';
import { useWatchlist } from '../hooks/market';
import { formatPct, formatUsd, pnlClass } from '../lib/format';

export function WatchlistPage() {
  const { data, isLoading, error } = useWatchlist();
  return (
    <>
      <PageHeader title="Watchlist" actions={<StaleBadge stale={data?.stale} />} />
      <ErrorBanner error={error} />
      {isLoading && <Spinner />}
      {data && data.items.length === 0 && (
        <EmptyState title="Your watchlist is empty">
          Star coins on the <Link to="/markets" className="text-accent hover:underline">Markets</Link> page.
        </EmptyState>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data?.items.map((c) => (
          <Link key={c.id} to={`/markets/${c.id}`}>
            <Card className="transition hover:border-accent/60">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2.5">
                  <CoinIcon coinId={c.id} image={c.image} size={28} />
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs uppercase text-muted">{c.symbol}</span>
                </span>
                <WatchButton coinId={c.id} />
              </div>
              <p className="num mt-4 text-2xl font-semibold">{formatUsd(c.currentPrice)}</p>
              <p className={`num mt-1 text-sm ${pnlClass(c.change24h)}`}>{formatPct(c.change24h)} (24h)</p>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
