import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/client';
import type { AuthResponse, User } from '../lib/types';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  user: User | null;
  status: Status;
  login(email: string, password: string): Promise<void>;
  register(email: string, password: string, displayName: string): Promise<void>;
  logout(): Promise<void>;
  setUser(user: User): void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUserState] = useState<User | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  const signOutLocally = useCallback(() => {
    api.setAccessToken(null);
    setUserState(null);
    setStatus('anonymous');
    queryClient.clear();
  }, [queryClient]);

  // On page load, try to resume the session from the refresh cookie.
  useEffect(() => {
    api.onUnauthorized = signOutLocally;
    let cancelled = false;
    (async () => {
      const ok = await api.refresh();
      const me = ok ? await api.get<User>('/me').catch(() => null) : null;
      if (cancelled) return;
      setUserState(me);
      setStatus(me ? 'authenticated' : 'anonymous');
    })();
    return () => {
      cancelled = true;
    };
  }, [signOutLocally]);

  const signIn = useCallback((res: AuthResponse) => {
    api.setAccessToken(res.accessToken);
    setUserState(res.user);
    setStatus('authenticated');
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      status,
      login: async (email, password) => signIn(await api.post<AuthResponse>('/auth/login', { email, password }, { auth: false })),
      register: async (email, password, displayName) =>
        signIn(await api.post<AuthResponse>('/auth/register', { email, password, displayName }, { auth: false })),
      logout: async () => {
        await api.post('/auth/logout', undefined, { auth: false }).catch(() => undefined);
        signOutLocally();
      },
      setUser: setUserState,
    }),
    [user, status, signIn, signOutLocally],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
