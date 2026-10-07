import { useId } from 'react';
import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCompactUsd, formatPct, formatUsd } from '../lib/format';
import type { Holding, SnapshotPoint } from '../lib/types';
import { EmptyState } from './ui';

const PALETTE = ['#7c9cff', '#22c55e', '#f59e0b', '#f43f5e', '#06b6d4', '#a78bfa', '#84cc16', '#ec4899'];
const tooltipStyle = { background: '#121826', border: '1px solid #243049', borderRadius: 8, fontSize: 12 };
const axisProps = { stroke: '#8a94a8', fontSize: 11, tickLine: false, axisLine: false } as const;

type XFormat = (value: string | number) => string;

function LineArea<T extends object>({ data, xKey, yKey, xFormat, height }: { data: T[]; xKey: string; yKey: string; xFormat: XFormat; height: number }) {
  const gradientId = useId();
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c9cff" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#7c9cff" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey={xKey} tickFormatter={xFormat} minTickGap={32} {...axisProps} />
        <YAxis tickFormatter={(v: number) => formatCompactUsd(v)} width={64} domain={['auto', 'auto']} {...axisProps} />
        <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => xFormat(v as string | number)} formatter={(v) => [formatUsd(Number(v)), 'Value']} />
        <Area type="monotone" dataKey={yKey} stroke="#7c9cff" strokeWidth={2} fill={`url(#${gradientId})`} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function ValueChart({ points, height = 240 }: { points: SnapshotPoint[]; height?: number }) {
  if (points.length === 0) return <EmptyState title="No history yet">The worker records portfolio value every hour.</EmptyState>;
  return <LineArea data={points} xKey="date" yKey="valueUsd" xFormat={(d) => String(d).slice(5)} height={height} />;
}

export function PriceChart({ points, days, height = 280 }: { points: [number, number][]; days: number; height?: number }) {
  const data = points.map(([t, price]) => ({ t, price }));
  const xFormat: XFormat = (t) => {
    const d = new Date(Number(t));
    return days === 1 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  return <LineArea data={data} xKey="t" yKey="price" xFormat={xFormat} height={height} />;
}

export function AllocationChart({ holdings }: { holdings: Holding[] }) {
  const priced = holdings.filter((h) => h.valueUsd && h.valueUsd > 0);
  if (priced.length === 0) return <EmptyState title="Nothing to allocate yet" />;
  const top = priced.slice(0, 7).map((h) => ({ name: h.coinId, value: h.valueUsd!, pct: h.allocationPct }));
  const rest = priced.slice(7);
  if (rest.length) {
    top.push({ name: 'other', value: rest.reduce((s, h) => s + h.valueUsd!, 0), pct: rest.reduce((s, h) => s + (h.allocationPct ?? 0), 0) });
  }
  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row lg:flex-col">
      <div className="h-44 w-44 shrink-0">
        <ResponsiveContainer>
          <PieChart>
            <Pie data={top} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="100%" stroke="none" paddingAngle={1} isAnimationActive={false}>
              {top.map((_, i) => (
                <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => formatUsd(Number(v))} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="w-full space-y-2 text-sm">
        {top.map((slice, i) => (
          <li key={slice.name} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />
              {slice.name}
            </span>
            <span className="num text-muted">{formatPct(slice.pct).replace('+', '')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
