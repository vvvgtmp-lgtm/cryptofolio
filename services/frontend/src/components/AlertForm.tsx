import { type FormEvent, useState } from 'react';
import { useCreateAlert } from '../hooks/alerts';
import { useCoins } from '../hooks/market';
import { formatUsd } from '../lib/format';
import { Button, ErrorBanner, Field, inputClass } from './ui';

export function AlertForm({ fixedCoinId }: { fixedCoinId?: string }) {
  const { data } = useCoins();
  const create = useCreateAlert();
  const [coinId, setCoinId] = useState(fixedCoinId ?? 'bitcoin');
  const [direction, setDirection] = useState<'above' | 'below'>('above');
  const [target, setTarget] = useState('');
  const coin = data?.coins.find((c) => c.id === coinId);

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate({ coinId, direction, targetPrice: Number(target) }, { onSuccess: () => setTarget('') });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <ErrorBanner error={create.error} />
      <div className="grid gap-4 sm:grid-cols-3">
        {!fixedCoinId && (
          <Field label="Coin">
            <select className={inputClass} value={coinId} onChange={(e) => setCoinId(e.target.value)}>
              {(data?.coins ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="When price is">
          <select className={inputClass} value={direction} onChange={(e) => setDirection(e.target.value as 'above' | 'below')}>
            <option value="above">at or above</option>
            <option value="below">at or below</option>
          </select>
        </Field>
        <Field label="Target (USD)" hint={coin ? `Now ${formatUsd(coin.currentPrice)}` : undefined}>
          <input className={`${inputClass} num`} type="number" min="0" step="any" required value={target} onChange={(e) => setTarget(e.target.value)} />
        </Field>
      </div>
      <Button type="submit" disabled={create.isPending}>{create.isSuccess && !target ? 'Alert created' : 'Create alert'}</Button>
    </form>
  );
}
