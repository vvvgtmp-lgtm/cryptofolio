import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { UsersTable } from '../db/database.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validation.js';
import type { RouteContext } from './context.js';

export const AVATAR_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export function toUserDto(user: Selectable<UsersTable>, avatarUrl: string | null = null) {
  return { id: user.id, email: user.email, displayName: user.display_name, avatarUrl, createdAt: user.created_at };
}

export function meRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const loadUser = async (userId: string) => {
    const user = await deps.db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
    if (!user) throw notFound('User');
    return user;
  };
  const userDto = async (userId: string) => {
    const user = await loadUser(userId);
    return toUserDto(user, user.avatar_key ? await deps.storage.presignGet('avatars', user.avatar_key) : null);
  };

  app.get('/api/me', async (request) => userDto(request.userId));

  app.patch('/api/me', async (request) => {
    const body = parse(z.object({ displayName: z.string().trim().min(1).max(60) }), request.body);
    await deps.db.updateTable('users').set({ display_name: body.displayName }).where('id', '=', request.userId).execute();
    return userDto(request.userId);
  });

  app.post('/api/me/avatar/upload-url', async (request) => {
    // Raster images only: an HTML or SVG "avatar" served from our origin would be stored XSS.
    const { contentType } = parse(z.object({ contentType: z.enum(AVATAR_CONTENT_TYPES) }), request.body ?? {});
    const key = `${request.userId}/${randomUUID()}`;
    return { uploadUrl: await deps.storage.presignPut('avatars', key, contentType), key };
  });

  app.put('/api/me/avatar', async (request) => {
    const { key } = parse(z.object({ key: z.string().max(200) }), request.body);
    if (!new RegExp(`^${request.userId}/[0-9a-f-]{36}$`).test(key)) throw badRequest('Invalid avatar key');
    await deps.db.updateTable('users').set({ avatar_key: key }).where('id', '=', request.userId).execute();
    return userDto(request.userId);
  });
}
