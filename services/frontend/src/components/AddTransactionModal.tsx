import { type ChangeEvent, type FormEvent, useState } from 'react';
import { useCoins } from '../hooks/market';
import { useAddTransaction } from '../hooks/portfolios';
import { formatUsd } from '../lib/format';
import { Button, ErrorBanner, Field, inputClass, Modal } from './ui';

function toLocalInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

const initialForm = (coinId: string) => ({
  coinId,
  type: 'buy' as 'buy' | 'sell',
  quantity: '',
  priceUsd: '',
  feeUsd: '',
  executedAt: toLocalInput(new Date()),
  note: '',
});

export function AddTransactionModal({ portfolioId, open, onClose, defaultCoinId = 'bitcoin' }: { portfolioId: string; open: boolean; onClose: () => void; defaultCoinId?: string }) {
  const { data } = useCoins();
  const add = useAddTransaction(portfolioId);
  const [form, setForm] = useState(() => initialForm(defaultCoinId));
  const coin = data?.coins.find((c) => c.id === form.coinId);

  const set = (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  function close() {
    add.reset();
    setForm(initialForm(defaultCoinId));
    onClose();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    add.mutate(
      {
        coinId: form.coinId,
        type: form.type,
        quantity: form.quantity,
        priceUsd: form.priceUsd || String(coin?.currentPrice ?? ''),
        feeUsd: form.feeUsd || '0',
        executedAt: new Date(form.executedAt).toISOString(),
        note: form.note || undefined,
      },
      { onSuccess: close },
    );
  }

  return (
    <Modal open={open} title="Add transaction" onClose={close}>
      <form onSubmit={submit} className="space-y-4">
        <ErrorBanner error={add.error} />
        <div className="grid grid-cols-2 gap-2">
          {(['buy', 'sell'] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setForm((f) => ({ ...f, type }))}
              className={`rounded-lg border py-2 text-sm font-medium uppercase ${form.type === type ? (type === 'buy' ? 'border-gain bg-gain/15 text-gain' : 'border-loss bg-loss/15 text-loss') : 'border-border text-muted'}`}
            >
              {type}
            </button>
          ))}
        </div>
        <Field label="Coin">
          <select className={inputClass} value={form.coinId} onChange={set('coinId')}>
            {(data?.coins ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.symbol.toUpperCase()})
              </option>
            ))}
          </select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Quantity">
            <input className={`${inputClass} num`} inputMode="decimal" required pattern="^\d+(\.\d{1,18})?$" placeholder="0.5" value={form.quantity} onChange={set('quantity')} />
          </Field>
          <Field label="Price (USD)" hint={coin ? `Market: ${formatUsd(coin.currentPrice)}` : undefined}>
            <input className={`${inputClass} num`} inputMode="decimal" pattern="^\d+(\.\d{1,18})?$" placeholder={coin ? String(coin.currentPrice) : ''} value={form.priceUsd} onChange={set('priceUsd')} />
          </Field>
          <Field label="Fee (USD)">
            <input className={`${inputClass} num`} inputMode="decimal" pattern="^\d+(\.\d{1,18})?$" placeholder="0" value={form.feeUsd} onChange={set('feeUsd')} />
          </Field>
          <Field label="Date">
            <input className={inputClass} type="datetime-local" required max={toLocalInput(new Date())} value={form.executedAt} onChange={set('executedAt')} />
          </Field>
        </div>
        <Field label="Note">
          <input className={inputClass} maxLength={200} value={form.note} onChange={set('note')} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button type="submit" disabled={add.isPending}>{add.isPending ? 'Saving…' : 'Add transaction'}</Button>
        </div>
      </form>
    </Modal>
  );
}
