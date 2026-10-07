import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenService } from '../../src/lib/tokens.js';

const tokens = createTokenService({
  JWT_ACCESS_SECRET: 'access-secret-0123456789abcdef-0123',
  JWT_REFRESH_SECRET: 'refresh-secret-0123456789abcdef-012',
  ACCESS_TOKEN_TTL_SECONDS: 60,
  REFRESH_TOKEN_TTL_DAYS: 7,
});

afterEach(() => vi.useRealTimers());

describe('token service', () => {
  it('round-trips access and refresh tokens', () => {
    expect(tokens.verifyAccess(tokens.signAccess('user-1'))).toEqual({ sub: 'user-1' });
    expect(tokens.verifyRefresh(tokens.signRefresh('user-1', 'jti-1'))).toEqual({ sub: 'user-1', jti: 'jti-1' });
  });

  it('does not accept an access token as a refresh token (and vice versa)', () => {
    expect(() => tokens.verifyRefresh(tokens.signAccess('user-1'))).toThrow();
    expect(() => tokens.verifyAccess(tokens.signRefresh('user-1', 'jti-1'))).toThrow();
  });

  it('rejects expired access tokens', () => {
    vi.useFakeTimers();
    const token = tokens.signAccess('user-1');
    vi.setSystemTime(Date.now() + 61_000);
    expect(() => tokens.verifyAccess(token)).toThrow();
  });

  it('rejects tampered tokens', () => {
    const token = tokens.signAccess('user-1');
    expect(() => tokens.verifyAccess(token.slice(0, -2) + 'xx')).toThrow();
  });
});
