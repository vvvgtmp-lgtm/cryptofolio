import { Download, FileText, Upload } from 'lucide-react';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { Button, Card, EmptyState, ErrorBanner, errorMessage, Field, inputClass, PageHeader, SectionTitle } from '../components/ui';
import { useCreateJob, useJobs } from '../hooks/jobs';
import { useInvalidatePortfolioData, usePortfolios } from '../hooks/portfolios';
import { api } from '../lib/client';
import type { Job, UploadTarget } from '../lib/types';
import { uploadFile } from '../lib/upload';

const MAX_CSV_BYTES = 1024 * 1024;
const JOB_LABELS: Record<Job['type'], string> = { export_csv: 'CSV export', import_csv: 'CSV import', report_pdf: 'PDF report' };
const STATUS_STYLES: Record<Job['status'], string> = {
  queued: 'bg-surface-2 text-muted',
  running: 'bg-accent/15 text-accent',
  done: 'bg-gain/15 text-gain',
  failed: 'bg-loss/15 text-loss',
};

export function FilesPage() {
  const portfolios = usePortfolios();
  const jobs = useJobs();
  const createJob = useCreateJob();
  const invalidatePortfolios = useInvalidatePortfolioData();
  const [portfolioId, setPortfolioId] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const selected = portfolioId || portfolios.data?.items[0]?.id || '';
  const names = new Map((portfolios.data?.items ?? []).map((p) => [p.id, p.name]));

  // When an import finishes, refresh portfolio data so new transactions show up everywhere.
  const doneImports = jobs.data?.items.filter((j) => j.type === 'import_csv' && j.status === 'done').length ?? 0;
  const seenImports = useRef<number | null>(null);
  useEffect(() => {
    if (seenImports.current !== null && doneImports > seenImports.current) void invalidatePortfolios();
    seenImports.current = doneImports;
  }, [doneImports, invalidatePortfolios]);

  async function onCsv(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !selected) return;
    if (!file.name.toLowerCase().endsWith('.csv')) return setImportError('Please choose a .csv file.');
    if (file.size > MAX_CSV_BYTES) return setImportError('CSV files are limited to 1 MB.');
    setUploading(true);
    setImportError(null);
    try {
      const { uploadUrl, key } = await api.post<UploadTarget>('/uploads/import-url');
      await uploadFile(uploadUrl, new File([file], file.name, { type: 'text/csv' }));
      await createJob.mutateAsync({ type: 'import_csv', params: { portfolioId: selected, key } });
    } catch (err) {
      setImportError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <PageHeader title="Import / Export" subtitle="Files are processed in the background by the worker and stored in object storage." />
      {portfolios.data?.items.length === 0 ? (
        <EmptyState title="Create a portfolio first" />
      ) : (
        <Card>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,280px)_1fr]">
            <Field label="Portfolio">
              <select className={inputClass} value={selected} onChange={(e) => setPortfolioId(e.target.value)}>
                {portfolios.data?.items.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            <div className="flex flex-wrap items-end gap-2">
              <Button variant="ghost" disabled={!selected || createJob.isPending} onClick={() => createJob.mutate({ type: 'export_csv', params: { portfolioId: selected } })}>
                <Download size={15} />Export CSV
              </Button>
              <Button variant="ghost" disabled={!selected || createJob.isPending} onClick={() => createJob.mutate({ type: 'report_pdf', params: { portfolioId: selected } })}>
                <FileText size={15} />PDF report
              </Button>
              <label className={`inline-flex cursor-pointer items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-bg hover:brightness-110 ${uploading || !selected ? 'pointer-events-none opacity-50' : ''}`}>
                <Upload size={15} />
                {uploading ? 'Uploading…' : 'Import CSV'}
                <input type="file" accept=".csv,text/csv" className="sr-only" onChange={onCsv} />
              </label>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <ErrorBanner error={createJob.error} />
            {importError && <ErrorBanner error={new Error(importError)} />}
          </div>
          <details className="mt-4 text-sm text-muted">
            <summary className="cursor-pointer">CSV format</summary>
            <pre className="num mt-2 overflow-x-auto rounded-lg bg-bg p-3 text-xs">{`date,type,coin_id,quantity,price_usd,fee_usd,note
2024-01-31T12:00:00Z,buy,bitcoin,0.5,42000,10,first buy
2024-03-01T09:30:00Z,sell,bitcoin,0.1,61000,5,`}</pre>
          </details>
        </Card>
      )}
      <Card>
        <SectionTitle>Recent jobs</SectionTitle>
        <ErrorBanner error={jobs.error} />
        {jobs.data?.items.length === 0 && <EmptyState title="No jobs yet" />}
        <ul className="divide-y divide-border">
          {jobs.data?.items.map((job) => (
            <li key={job.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <span>
                <span className="font-medium">{JOB_LABELS[job.type]}</span>
                <span className="ml-2 text-muted">{names.get(job.params.portfolioId ?? '') ?? 'deleted portfolio'}</span>
                <span className="ml-2 text-xs text-muted">{new Date(job.createdAt).toLocaleString()}</span>
              </span>
              <span className="flex items-center gap-3">
                {job.status === 'done' && job.downloadUrl && (
                  <a href={job.downloadUrl} className="text-accent hover:underline">Download {job.result?.filename}</a>
                )}
                {job.status === 'done' && job.type === 'import_csv' && <span className="text-muted">{job.result?.imported} transactions imported</span>}
                {job.status === 'failed' && <span className="max-w-md text-loss">{job.error}</span>}
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[job.status]}`}>{job.status}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
