import { Link } from 'react-router-dom';
import { AllocationChart, ValueChart } from '../components/charts';
import { HoldingsTable } from '../components/HoldingsTable';
import { PnlText } from '../components/PnlText';
import { Card, EmptyState, ErrorBanner, PageHeader, SectionTitle, Spinner, StaleBadge, Stat } from '../components/ui';
import { useDashboard } from '../hooks/portfolios';
import { formatUsd } from '../lib/format';

export function DashboardPage() {
  const { data, isLoading, error } = useDashboard();
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorBanner error={error} />;
  const { totals } = data;

  return (
    <>
      <PageHeader title="Dashboard" subtitle="All portfolios combined" actions={<StaleBadge stale={data.stale} />} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total value" value={formatUsd(totals.valueUsd)} />
        <Stat label="24h change" value={<PnlText value={totals.change24hUsd} pct={totals.change24hPct} />} />
        <Stat label="Unrealized P/L" value={<PnlText value={totals.unrealizedPnlUsd} pct={totals.unrealizedPnlPct} />} />
        <Stat label="Realized P/L" value={<PnlText value={totals.realizedPnlUsd} />} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle>Value, last 30 days</SectionTitle>
          <ValueChart points={data.history} />
        </Card>
        <Card>
          <SectionTitle>Allocation</SectionTitle>
          <AllocationChart holdings={data.holdings} />
        </Card>
      </div>
      <Card>
        <SectionTitle>Holdings</SectionTitle>
        <HoldingsTable holdings={data.holdings} />
        {totals.missingPrices.length > 0 && <p className="mt-3 text-xs text-warn">No current price for: {totals.missingPrices.join(', ')}</p>}
      </Card>
      <Card>
        <SectionTitle actions={<Link to="/portfolios" className="text-sm text-accent hover:underline">Manage</Link>}>Portfolios</SectionTitle>
        {data.portfolios.length === 0 ? (
          <EmptyState title="No portfolios yet">
            <Link to="/portfolios" className="text-accent hover:underline">Create your first portfolio</Link>
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {data.portfolios.map((p) => (
              <li key={p.id}>
                <Link to={`/portfolios/${p.id}`} className="flex items-center justify-between gap-4 py-3 hover:text-accent">
                  <span className="font-medium">{p.name}</span>
                  <span className="flex items-center gap-6">
                    <span className="num">{formatUsd(p.totals.valueUsd)}</span>
                    <PnlText value={p.totals.unrealizedPnlUsd} pct={p.totals.unrealizedPnlPct} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
