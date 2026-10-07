import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/client';
import type { Dashboard, Holding, Portfolio, PortfolioSummary, SnapshotPoint, Totals, Transaction } from '../lib/types';

const PORTFOLIO_KEYS = ['dashboard', 'portfolios', 'portfolio', 'holdings', 'transactions', 'snapshots'];

export function useInvalidatePortfolioData() {
  const qc = useQueryClient();
  return () => Promise.all(PORTFOLIO_KEYS.map((key) => qc.invalidateQueries({ queryKey: [key] })));
}

export const useDashboard = () =>
  useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Dashboard>('/dashboard'), refetchInterval: 60_000 });

export const usePortfolios = () =>
  useQuery({ queryKey: ['portfolios'], queryFn: () => api.get<{ items: PortfolioSummary[]; stale: boolean }>('/portfolios') });

export const usePortfolio = (id: string) =>
  useQuery({ queryKey: ['portfolio', id], queryFn: () => api.get<Portfolio>(`/portfolios/${id}`) });

export const useHoldings = (id: string) =>
  useQuery({
    queryKey: ['holdings', id],
    queryFn: () => api.get<{ holdings: Holding[]; totals: Totals; stale: boolean }>(`/portfolios/${id}/holdings`),
    refetchInterval: 60_000,
  });

export const useTransactions = (id: string) =>
  useQuery({ queryKey: ['transactions', id], queryFn: () => api.get<{ items: Transaction[] }>(`/portfolios/${id}/transactions`) });

export const useSnapshots = (id: string, days = 30) =>
  useQuery({ queryKey: ['snapshots', id, days], queryFn: () => api.get<{ points: SnapshotPoint[] }>(`/portfolios/${id}/snapshots?days=${days}`) });

export function useCreatePortfolio() {
  const invalidate = useInvalidatePortfolioData();
  return useMutation({ mutationFn: (name: string) => api.post<Portfolio>('/portfolios', { name }), onSuccess: invalidate });
}

export function useRenamePortfolio(id: string) {
  const invalidate = useInvalidatePortfolioData();
  return useMutation({ mutationFn: (name: string) => api.patch<Portfolio>(`/portfolios/${id}`, { name }), onSuccess: invalidate });
}

export function useDeletePortfolio() {
  const invalidate = useInvalidatePortfolioData();
  return useMutation({ mutationFn: (id: string) => api.del(`/portfolios/${id}`), onSuccess: invalidate });
}

export interface NewTransaction {
  coinId: string;
  type: 'buy' | 'sell';
  quantity: string;
  priceUsd: string;
  feeUsd: string;
  executedAt: string;
  note?: string;
}

export function useAddTransaction(portfolioId: string) {
  const invalidate = useInvalidatePortfolioData();
  return useMutation({
    mutationFn: (input: NewTransaction) => api.post<Transaction>(`/portfolios/${portfolioId}/transactions`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteTransaction() {
  const invalidate = useInvalidatePortfolioData();
  return useMutation({ mutationFn: (id: string) => api.del(`/transactions/${id}`), onSuccess: invalidate });
}
