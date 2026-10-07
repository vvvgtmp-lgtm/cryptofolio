import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/client';
import type { AppNotification } from '../lib/types';

export const useNotifications = () =>
  useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: AppNotification[]; unreadCount: number }>('/notifications'),
    refetchInterval: 30_000,
  });

function useInvalidate() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['notifications'] }), qc.invalidateQueries({ queryKey: ['alerts'] })]);
}

export function useMarkRead() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.post(`/notifications/${id}/read`), onSuccess: invalidate });
}

export function useMarkAllRead() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: invalidate });
}
