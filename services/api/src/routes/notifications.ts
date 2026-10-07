import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../lib/errors.js';
import { parse, uuidParam } from '../lib/validation.js';
import type { RouteContext } from './context.js';

export function notificationRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const { db } = deps;

  app.get('/api/notifications', async (request) => {
    const { unread } = parse(z.object({ unread: z.enum(['true', 'false']).optional() }), request.query);
    let query = db
      .selectFrom('notifications')
      .select(['id', 'title', 'body', 'read_at as readAt', 'created_at as createdAt'])
      .where('user_id', '=', request.userId)
      .orderBy('created_at', 'desc')
      .limit(50);
    if (unread === 'true') query = query.where('read_at', 'is', null);
    const items = await query.execute();
    const { count } = await db
      .selectFrom('notifications')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('user_id', '=', request.userId)
      .where('read_at', 'is', null)
      .executeTakeFirstOrThrow();
    return { items, unreadCount: Number(count) };
  });

  app.post('/api/notifications/:id/read', async (request, reply) => {
    const { id } = parse(uuidParam, request.params);
    const result = await db
      .updateTable('notifications')
      .set({ read_at: new Date() })
      .where('id', '=', id)
      .where('user_id', '=', request.userId)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) throw notFound('Notification');
    return reply.status(204).send();
  });

  app.post('/api/notifications/read-all', async (request, reply) => {
    await db.updateTable('notifications').set({ read_at: new Date() }).where('user_id', '=', request.userId).where('read_at', 'is', null).execute();
    return reply.status(204).send();
  });
}
