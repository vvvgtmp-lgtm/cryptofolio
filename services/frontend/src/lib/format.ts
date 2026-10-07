const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usdSmall = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 4 });
const usdCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const qty = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 });

export function formatUsd(value: number | null | undefined): string {
  if (value == null) return '—';
  return value !== 0 && Math.abs(value) < 1 ? usdSmall.format(value) : usd.format(value);
}

export function formatPct(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export const formatQty = (value: number) => qty.format(value);
export const formatCompactUsd = (value: number) => usdCompact.format(value);

export function pnlClass(value: number | null | undefined): 'text-gain' | 'text-loss' | 'text-muted' {
  if (value == null || value === 0) return 'text-muted';
  return value > 0 ? 'text-gain' : 'text-loss';
}
