import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context.js';

export function uploadRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  // The browser PUTs the CSV straight to object storage, then creates an import_csv job with the key.
  app.post('/api/uploads/import-url', async (request) => {
    const key = `${request.userId}/${randomUUID()}.csv`;
    return { uploadUrl: await deps.storage.presignPut('imports', key, 'text/csv'), key };
  });
}
