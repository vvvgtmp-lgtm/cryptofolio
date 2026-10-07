import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { UsersTable } from '../db/database.js';
import { conflict, HttpError, isUniqueViolation, unauthorized } from '../lib/errors.js';
import { isRateLimited } from '../lib/rateLimit.js';
import { parse } from '../lib/validation.js';
import type { RouteContext } from './context.js';
import { toUserDto } from './me.js';

export const REFRESH_COOKIE = 'cf_refresh';
const COOKIE_PATH = '/api/auth';

const email = z.string().trim().toLowerCase().email().max(254);
const registerBody = z.object({
  email,
  password: z.string().min(8).max(128),
  displayName: z.string().trim().min(1).max(60),
});
const loginBody = z.object({ email, password: z.string().min(1).max(128) });

export function authRoutes(app: FastifyInstance, { deps, tokens }: RouteContext): void {
  const { db, redis, config } = deps;

  const refreshTtlSeconds = config.REFRESH_TOKEN_TTL_DAYS * 86_400;
  // Every refresh token has an id (jti) stored in Redis: refresh consumes it (rotation),
  // logout deletes it, so a stolen or logged-out token stops working immediately.
  const refreshKey = (jti: string) => `refresh:${jti}`;

  const issueTokens = async (reply: FastifyReply, user: Selectable<UsersTable>) => {
    const jti = randomUUID();
    await redis.set(refreshKey(jti), user.id, 'EX', refreshTtlSeconds);
    reply.setCookie(REFRESH_COOKIE, tokens.signRefresh(user.id, jti), {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.COOKIE_SECURE,
      path: COOKIE_PATH,
      maxAge: refreshTtlSeconds,
    });
    return { accessToken: tokens.signAccess(user.id), user: toUserDto(user) };
  };

  app.post('/api/auth/register', async (request, reply) => {
    if (await isRateLimited(redis, `ratelimit:register:${request.ip}`, config.REGISTER_RATE_LIMIT_PER_MINUTE, 60)) {
      throw new HttpError(429, 'rate_limited', 'Too many sign-ups from this address, try again in a minute');
    }
    const body = parse(registerBody, request.body);
    try {
      const user = await db
        .insertInto('users')
        .values({ email: body.email, password_hash: await bcrypt.hash(body.password, 10), display_name: body.displayName })
        .returningAll()
        .executeTakeFirstOrThrow();
      reply.status(201);
      return issueTokens(reply, user);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('Email is already registered');
      throw err;
    }
  });

  app.post('/api/auth/login', async (request, reply) => {
    if (await isRateLimited(redis, `ratelimit:login:${request.ip}`, config.LOGIN_RATE_LIMIT_PER_MINUTE, 60)) {
      throw new HttpError(429, 'rate_limited', 'Too many login attempts, try again in a minute');
    }
    const body = parse(loginBody, request.body);
    const user = await db.selectFrom('users').selectAll().where('email', '=', body.email).executeTakeFirst();
    if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
      throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
    }
    return issueTokens(reply, user);
  });

  app.post('/api/auth/refresh', async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE];
    if (!token) throw unauthorized('No refresh token');
    let claims: { sub: string; jti: string };
    try {
      claims = tokens.verifyRefresh(token);
    } catch {
      reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      throw unauthorized('Invalid refresh token');
    }
    // GETDEL makes each refresh token single-use: a replayed (rotated or logged-out) token fails.
    const owner = await redis.getdel(refreshKey(claims.jti));
    if (owner !== claims.sub) {
      reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      throw unauthorized('Refresh token has been revoked');
    }
    const user = await db.selectFrom('users').selectAll().where('id', '=', claims.sub).executeTakeFirst();
    if (!user) throw unauthorized('Invalid refresh token');
    return issueTokens(reply, user);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE];
    if (token) {
      try {
        await redis.del(refreshKey(tokens.verifyRefresh(token).jti));
      } catch {
        // invalid or expired token: nothing to revoke
      }
    }
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
    return reply.status(204).send();
  });
}
