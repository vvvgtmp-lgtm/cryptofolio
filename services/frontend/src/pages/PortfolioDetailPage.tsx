import { Pencil, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AddTransactionModal } from '../components/AddTransactionModal';
import { AllocationChart, ValueChart } from '../components/charts';
import { HoldingsTable } from '../components/HoldingsTable';
import { PnlText } from '../components/PnlText';
import { TransactionsTable } from '../components/TransactionsTable';
import { Button, Card, ErrorBanner, inputClass, PageHeader, SectionTitle, Spinner, StaleBadge, Stat } from '../components/ui';
import { useDeletePortfolio, useHoldings, usePortfolio, useRenamePortfolio, useSnapshots, useTransactions } from '../hooks/portfolios';
import { formatUsd } from '../lib/format';

export function PortfolioDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const portfolio = usePortfolio(id);
  const holdings = useHoldings(id);
  const transactions = useTransactions(id);
  const snapshots = useSnapshots(id, 30);
  const rename = useRenamePortfolio(id);
  const remove = useDeletePortfolio();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');

  if (portfolio.isLoading) return <Spinner />;
  if (portfolio.error || !portfolio.data) return <ErrorBanner error={portfolio.error} />;

  function submitRename(e: FormEvent) {
    e.preventDefault();
    rename.mutate(name.trim(), { onSuccess: () => setEditing(false) });
  }

  const totals = holdings.data?.totals;
  const title = editing ? (
    <form onSubmit={submitRename} className="flex gap-2">
      <input className={inputClass} autoFocus required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      <Button type="submit" disabled={rename.isPending}>Save</Button>
      <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
    </form>
  ) : (
    <span className="flex items-center gap-3">
      {portfolio.data.name}
      <button type="button" aria-label="Rename portfolio" className="text-muted hover:text-text" onClick={() => { setName(portfolio.data!.name); setEditing(true); }}>
        <Pencil size={16} />
      </button>
    </span>
  );

  return (
    <>
      <PageHeader
        title={title}
        actions={
          <>
            <StaleBadge stale={holdings.data?.stale} />
            <Button onClick={() => setAdding(true)}><Plus size={16} />Add transaction</Button>
            <Button
              variant="danger"
              onClick={() => window.confirm('Delete this portfolio and all its transactions?') && remove.mutate(id, { onSuccess: () => navigate('/portfolios') })}
            >
              Delete
            </Button>
          </>
        }
      />
      <ErrorBanner error={rename.error ?? remove.error ?? holdings.error} />
      {totals && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Value" value={formatUsd(totals.valueUsd)} />
          <Stat label="Cost basis" value={formatUsd(totals.costBasisUsd)} />
          <Stat label="Unrealized P/L" value={<PnlText value={totals.unrealizedPnlUsd} pct={totals.unrealizedPnlPct} />} />
          <Stat label="Realized P/L" value={<PnlText value={totals.realizedPnlUsd} />} />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle>Value, last 30 days</SectionTitle>
          {snapshots.data ? <ValueChart points={snapshots.data.points} /> : <Spinner />}
        </Card>
        <Card>
          <SectionTitle>Allocation</SectionTitle>
          {holdings.data ? <AllocationChart holdings={holdings.data.holdings} /> : <Spinner />}
        </Card>
      </div>
      <Card>
        <SectionTitle>Holdings</SectionTitle>
        {holdings.data ? <HoldingsTable holdings={holdings.data.holdings} /> : <Spinner />}
      </Card>
      <Card>
        <SectionTitle>Transactions</SectionTitle>
        {transactions.data ? <TransactionsTable items={transactions.data.items} /> : <Spinner />}
      </Card>
      <AddTransactionModal portfolioId={id} open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
