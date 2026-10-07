import type { FastifyInstance } from 'fastify';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { JobsTable } from '../db/database.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { getOwnedPortfolio } from '../lib/portfolios.js';
import type { Storage } from '../lib/storage.js';
import { parse, uuidParam } from '../lib/validation.js';
import type { RouteContext } from './context.js';

const portfolioParams = z.object({ portfolioId: z.string().uuid() });
const createJob = z.discriminatedUnion('type', [
  z.object({ type: z.literal('export_csv'), params: portfolioParams }),
  z.object({ type: z.literal('report_pdf'), params: portfolioParams }),
  z.object({ type: z.literal('import_csv'), params: portfolioParams.extend({ key: z.string().min(1).max(200) }) }),
]);

async function toJobDto(job: Selectable<JobsTable>, storage: Storage) {
  const downloadable = job.status === 'done' && job.result_key && job.type !== 'import_csv';
  const filename = typeof job.result?.filename === 'string' ? job.result.filename : undefined;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    params: job.params,
    result: job.result,
    error: job.error,
    attempts: job.attempts,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    downloadUrl: downloadable ? await storage.presignGet('exports', job.result_key!, filename) : null,
  };
}

export function jobRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const { db, storage, queue } = deps;

  app.post('/api/jobs', async (request, reply) => {
    const body = parse(createJob, request.body);
    await getOwnedPortfolio(db, request.userId, body.params.portfolioId);
    if (body.type === 'import_csv' && !body.params.key.startsWith(`${request.userId}/`)) throw badRequest('Invalid upload key');

    const job = await db
      .insertInto('jobs')
      .values({ user_id: request.userId, type: body.type, params: JSON.stringify(body.params) })
      .returningAll()
      .executeTakeFirstOrThrow();
    try {
      await queue.enqueue(job.id);
    } catch (err) {
      request.log.error({ err, jobId: job.id }, 'failed to enqueue job');
      await db.updateTable('jobs').set({ status: 'failed', error: 'Could not enqueue job', updated_at: new Date() }).where('id', '=', job.id).execute();
      throw new HttpError(503, 'queue_unavailable', 'Background jobs are temporarily unavailable');
    }
    return reply.status(202).send(await toJobDto(job, storage));
  });

  app.get('/api/jobs', async (request) => {
    const jobs = await db.selectFrom('jobs').selectAll().where('user_id', '=', request.userId).orderBy('created_at', 'desc').limit(20).execute();
    return { items: await Promise.all(jobs.map((j) => toJobDto(j, storage))) };
  });

  app.get('/api/jobs/:id', async (request) => {
    const { id } = parse(uuidParam, request.params);
    const job = await db.selectFrom('jobs').selectAll().where('id', '=', id).where('user_id', '=', request.userId).executeTakeFirst();
    if (!job) throw notFound('Job');
    return toJobDto(job, storage);
  });
}
