import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/client';
import type { Job, JobType } from '../lib/types';

const isActive = (job: Job) => job.status === 'queued' || job.status === 'running';

export const useJobs = () =>
  useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.get<{ items: Job[] }>('/jobs'),
    refetchInterval: (query) => (query.state.data?.items.some(isActive) ? 1500 : 10_000),
  });

export interface CreateJobInput {
  type: JobType;
  params: { portfolioId: string; key?: string };
}

export function useCreateJob() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: CreateJobInput) => api.post<Job>('/jobs', input), onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }) });
}
