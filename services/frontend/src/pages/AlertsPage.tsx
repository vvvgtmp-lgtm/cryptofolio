import { Trash2 } from 'lucide-react';
import { AlertForm } from '../components/AlertForm';
import { Card, EmptyState, ErrorBanner, PageHeader, SectionTitle, Spinner, StaleBadge } from '../components/ui';
import { useAlerts, useDeleteAlert } from '../hooks/alerts';
import { formatUsd } from '../lib/format';

export function AlertsPage() {
  const { data, isLoading, error } = useAlerts();
  const remove = useDeleteAlert();
  return (
    <>
      <PageHeader title="Price alerts" subtitle="The worker checks prices every minute and notifies you once." actions={<StaleBadge stale={data?.stale} />} />
      <Card>
        <SectionTitle>New alert</SectionTitle>
        <AlertForm />
      </Card>
      <Card>
        <SectionTitle>Your alerts</SectionTitle>
        <ErrorBanner error={error ?? remove.error} />
        {isLoading && <Spinner />}
        {data?.items.length === 0 && <EmptyState title="No alerts yet" />}
        <ul className="divide-y divide-border">
          {data?.items.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <span>
                <span className="font-medium">{a.coinId}</span> {a.direction === 'above' ? '≥' : '≤'} <span className="num">{formatUsd(a.targetPrice)}</span>
                <span className="ml-3 text-muted">now <span className="num">{formatUsd(a.currentPrice)}</span></span>
              </span>
              <span className="flex items-center gap-4">
                {a.active ? (
                  <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-xs text-accent">active</span>
                ) : (
                  <span className="rounded-full bg-gain/15 px-2.5 py-0.5 text-xs text-gain">triggered {a.triggeredAt && new Date(a.triggeredAt).toLocaleString()}</span>
                )}
                <button type="button" aria-label="Delete alert" className="text-muted hover:text-loss" onClick={() => remove.mutate(a.id)}>
                  <Trash2 size={15} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
