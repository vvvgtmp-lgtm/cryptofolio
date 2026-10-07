import { Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { PnlText } from '../components/PnlText';
import { Button, Card, EmptyState, ErrorBanner, inputClass, PageHeader, Spinner, StaleBadge } from '../components/ui';
import { useCreatePortfolio, useDeletePortfolio, usePortfolios } from '../hooks/portfolios';
import { formatUsd } from '../lib/format';

export function PortfoliosPage() {
  const { data, isLoading, error } = usePortfolios();
  const create = useCreatePortfolio();
  const remove = useDeletePortfolio();
  const [name, setName] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate(name.trim(), { onSuccess: () => setName('') });
  }

  return (
    <>
      <PageHeader title="Portfolios" actions={<StaleBadge stale={data?.stale} />} />
      <Card>
        <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row">
          <input className={inputClass} placeholder="New portfolio name" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" disabled={create.isPending} className="shrink-0">Create portfolio</Button>
        </form>
        <div className="mt-3"><ErrorBanner error={create.error ?? remove.error} /></div>
      </Card>
      {isLoading && <Spinner />}
      <ErrorBanner error={error} />
      {data && data.items.length === 0 && <EmptyState title="No portfolios yet">Create one above to start tracking.</EmptyState>}
      <div className="grid gap-4 md:grid-cols-2">
        {data?.items.map((p) => (
          <Card key={p.id} className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <Link to={`/portfolios/${p.id}`} className="text-lg font-semibold hover:text-accent">{p.name}</Link>
              <button
                type="button"
                aria-label={`Delete ${p.name}`}
                className="text-muted hover:text-loss"
                onClick={() => window.confirm(`Delete "${p.name}" and all its transactions?`) && remove.mutate(p.id)}
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div><p className="text-xs text-muted">Value</p><p className="num mt-1 font-medium">{formatUsd(p.totals.valueUsd)}</p></div>
              <div><p className="text-xs text-muted">24h</p><p className="mt-1"><PnlText value={p.totals.change24hUsd} /></p></div>
              <div><p className="text-xs text-muted">Unrealized</p><p className="mt-1"><PnlText value={p.totals.unrealizedPnlUsd} /></p></div>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
