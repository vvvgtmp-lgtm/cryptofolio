export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: string;
}
export interface AuthResponse {
  accessToken: string;
  user: User;
}
export interface Coin {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  currentPrice: number;
  change24h: number;
  marketCap: number;
}
export interface Totals {
  valueUsd: number;
  costBasisUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number | null;
  realizedPnlUsd: number;
  change24hUsd: number;
  change24hPct: number | null;
  missingPrices: string[];
}
export interface Holding {
  coinId: string;
  quantity: number;
  avgCostUsd: number;
  costBasisUsd: number;
  realizedPnlUsd: number;
  priceUsd: number | null;
  change24hPct: number | null;
  valueUsd: number | null;
  unrealizedPnlUsd: number | null;
  unrealizedPnlPct: number | null;
  allocationPct: number | null;
}
export interface Portfolio {
  id: string;
  name: string;
  createdAt: string;
}
export interface PortfolioSummary extends Portfolio {
  totals: Totals;
}
export interface Transaction {
  id: string;
  portfolioId: string;
  coinId: string;
  type: 'buy' | 'sell';
  quantity: number;
  priceUsd: number;
  feeUsd: number;
  totalUsd: number;
  executedAt: string;
  note: string | null;
}
export interface SnapshotPoint {
  date: string;
  valueUsd: number;
}
export interface Dashboard {
  totals: Totals;
  holdings: Holding[];
  portfolios: { id: string; name: string; totals: Totals }[];
  history: SnapshotPoint[];
  stale: boolean;
}
export interface PriceHistory {
  id: string;
  days: number;
  points: [number, number][];
  stale: boolean;
}
export interface Alert {
  id: string;
  coinId: string;
  direction: 'above' | 'below';
  targetPrice: number;
  active: boolean;
  triggeredAt: string | null;
  createdAt: string;
  currentPrice: number | null;
}
export interface AppNotification {
  id: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}
export type JobType = 'export_csv' | 'import_csv' | 'report_pdf';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  params: { portfolioId?: string; key?: string };
  result: { filename?: string; rows?: number; imported?: number } | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  downloadUrl: string | null;
}
export interface UploadTarget {
  uploadUrl: string;
  key: string;
}
