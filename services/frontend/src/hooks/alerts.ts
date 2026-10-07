import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/client';
import type { Alert } from '../lib/types';

export const useAlerts = () =>
  useQuery({ queryKey: ['alerts'], queryFn: () => api.get<{ items: Alert[]; stale: boolean }>('/alerts'), refetchInterval: 30_000 });

export interface NewAlert {
  coinId: string;
  direction: 'above' | 'below';
  targetPrice: number;
}

export function useCreateAlert() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: NewAlert) => api.post<Alert>('/alerts', input), onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }) });
}

export function useDeleteAlert() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.del(`/alerts/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }) });
}
