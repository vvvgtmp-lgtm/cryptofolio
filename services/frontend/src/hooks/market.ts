import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../lib/client';
import type { Coin, PriceHistory } from '../lib/types';

export const useCoins = () =>
  useQuery({
    queryKey: ['coins'],
    queryFn: () => api.get<{ coins: Coin[]; stale: boolean }>('/market/coins'),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

/** id -> Coin lookup for names, symbols and icons. */
export function useCoinMap(): Map<string, Coin> {
  const { data } = useCoins();
  return useMemo(() => new Map((data?.coins ?? []).map((c) => [c.id, c])), [data]);
}

export const usePriceHistory = (id: string, days: number) =>
  useQuery({ queryKey: ['history', id, days], queryFn: () => api.get<PriceHistory>(`/market/history/${id}?days=${days}`) });

export const useWatchlist = () =>
  useQuery({ queryKey: ['watchlist'], queryFn: () => api.get<{ items: Coin[]; stale: boolean }>('/watchlist') });

export function useToggleWatchlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ coinId, watched }: { coinId: string; watched: boolean }) =>
      watched ? api.del(`/watchlist/${coinId}`) : api.post('/watchlist', { coinId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['watchlist'] }),
  });
}
