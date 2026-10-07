import { createSigner, createVerifier } from 'fast-jwt';
import type { Config } from '../config.js';

export interface TokenService {
  signAccess(userId: string): string;
  signRefresh(userId: string, jti: string): string;
  verifyAccess(token: string): { sub: string };
  verifyRefresh(token: string): { sub: string; jti: string };
}

type TokenConfig = Pick<
  Config,
  'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET' | 'ACCESS_TOKEN_TTL_SECONDS' | 'REFRESH_TOKEN_TTL_DAYS'
>;

function assertType(payload: { sub?: unknown; typ?: unknown }, typ: 'access' | 'refresh') {
  if (payload.typ !== typ || typeof payload.sub !== 'string') throw new Error(`not a ${typ} token`);
  return { sub: payload.sub };
}

export function createTokenService(config: TokenConfig): TokenService {
  const signAccess = createSigner({ key: config.JWT_ACCESS_SECRET, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS * 1000 });
  const signRefresh = createSigner({ key: config.JWT_REFRESH_SECRET, expiresIn: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000 });
  const verifyAccess = createVerifier({ key: config.JWT_ACCESS_SECRET });
  const verifyRefresh = createVerifier({ key: config.JWT_REFRESH_SECRET });
  return {
    signAccess: (userId) => signAccess({ sub: userId, typ: 'access' }),
    signRefresh: (userId, jti) => signRefresh({ sub: userId, typ: 'refresh', jti }),
    verifyAccess: (token) => assertType(verifyAccess(token), 'access'),
    verifyRefresh: (token) => {
      const payload = verifyRefresh(token);
      if (typeof payload.jti !== 'string') throw new Error('refresh token without jti');
      return { ...assertType(payload, 'refresh'), jti: payload.jti };
    },
  };
}
