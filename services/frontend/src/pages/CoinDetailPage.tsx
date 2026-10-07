import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { AddTransactionModal } from '../components/AddTransactionModal';
import { AlertForm } from '../components/AlertForm';
import { PriceChart } from '../components/charts';
import { CoinIcon } from '../components/CoinIcon';
import { Button, Card, ErrorBanner, inputClass, PageHeader, SectionTitle, Spinner, StaleBadge } from '../components/ui';
import { WatchButton } from '../components/WatchButton';
import { useCoinMap, usePriceHistory } from '../hooks/market';
import { usePortfolios } from '../hooks/portfolios';
import { formatPct, formatUsd, pnlClass } from '../lib/format';

const RANGES = [
  { days: 1, label: '24H' },
  { days: 7, label: '7D' },
  { days: 30, label: '30D' },
  { days: 365, label: '1Y' },
];

export function CoinDetailPage() {
  const { id = '' } = useParams();
  const coin = useCoinMap().get(id);
  const [days, setDays] = useState(7);
  const history = usePriceHistory(id, days);
  const portfolios = usePortfolios();
  const [portfolioId, setPortfolioId] = useState('');
  const [adding, setAdding] = useState(false);
  const selectedPortfolio = portfolioId || portfolios.data?.items[0]?.id || '';

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <CoinIcon coinId={id} image={coin?.image} size={32} />
            {coin?.name ?? id}
            <span className="text-base uppercase text-muted">{coin?.symbol}</span>
            <WatchButton coinId={id} />
          </span>
        }
        subtitle={
          coin && (
            <span className="num">
              {formatUsd(coin.currentPrice)} <span className={pnlClass(coin.change24h)}>{formatPct(coin.change24h)}</span> (24h)
            </span>
          )
        }
        actions={<StaleBadge stale={history.data?.stale} />}
      />
      <Card>
        <SectionTitle
          actions={
            <div className="flex gap-1 rounded-lg bg-bg p-1">
              {RANGES.map((r) => (
                <button key={r.days} type="button" onClick={() => setDays(r.days)} className={`rounded-md px-3 py-1 text-xs font-medium ${days === r.days ? 'bg-surface-2 text-text' : 'text-muted hover:text-text'}`}>
                  {r.label}
                </button>
              ))}
            </div>
          }
        >
          Price
        </SectionTitle>
        <ErrorBanner error={history.error} />
        {history.data ? <PriceChart points={history.data.points} days={days} /> : <Spinner />}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Price alert</SectionTitle>
          <AlertForm fixedCoinId={id} />
        </Card>
        <Card>
          <SectionTitle>Record a trade</SectionTitle>
          {portfolios.data?.items.length ? (
            <div className="flex flex-col gap-3 sm:flex-row">
              <select className={inputClass} value={selectedPortfolio} onChange={(e) => setPortfolioId(e.target.value)}>
                {portfolios.data.items.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <Button className="shrink-0" onClick={() => setAdding(true)}>Add transaction</Button>
            </div>
          ) : (
            <p className="text-sm text-muted">Create a portfolio first.</p>
          )}
        </Card>
      </div>
      {selectedPortfolio && <AddTransactionModal key={`${selectedPortfolio}-${id}`} portfolioId={selectedPortfolio} defaultCoinId={id} open={adding} onClose={() => setAdding(false)} />}
    </>
  );
}
