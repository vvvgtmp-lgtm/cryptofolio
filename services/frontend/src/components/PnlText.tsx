import { formatPct, formatUsd, pnlClass } from '../lib/format';

export function PnlText({ value, pct }: { value: number | null; pct?: number | null }) {
  return (
    <span className={`num ${pnlClass(value)}`}>
      {formatUsd(value)}
      {pct != null && <span className="ml-1 text-xs opacity-80">({formatPct(pct)})</span>}
    </span>
  );
}
