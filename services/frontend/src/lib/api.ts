export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface RequestOptions {
  /** attach the access token and refresh it on 401 (default true) */
  auth?: boolean;
  retry?: boolean;
}

/**
 * Access token lives in memory only; the refresh token is an httpOnly cookie
 * the browser sends to /api/auth/* automatically.
 */
export class ApiClient {
  private accessToken: string | null = null;
  private refreshing: Promise<boolean> | null = null;
  onUnauthorized: (() => void) | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  get<T>(path: string, options?: RequestOptions) {
    return this.request<T>('GET', path, undefined, options);
  }
  post<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>('POST', path, body, options);
  }
  put<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>('PUT', path, body, options);
  }
  patch<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>('PATCH', path, body, options);
  }
  del<T = void>(path: string, options?: RequestOptions) {
    return this.request<T>('DELETE', path, undefined, options);
  }

  private async request<T>(method: Method, path: string, body?: unknown, { auth = true, retry = true }: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
    });

    if (res.status === 401 && auth && retry) {
      if (await this.refresh()) return this.request<T>(method, path, body, { auth, retry: false });
      this.onUnauthorized?.();
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
      throw new ApiError(res.status, data?.error?.code ?? 'http_error', data?.error?.message ?? `Request failed (${res.status})`, data?.error?.details);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Exchanges the refresh cookie for a new access token. Concurrent callers share one request. */
  refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/auth/refresh`, { method: 'POST', credentials: 'include' });
        if (!res.ok) {
          this.accessToken = null;
          return false;
        }
        this.accessToken = ((await res.json()) as { accessToken: string }).accessToken;
        return true;
      } catch {
        this.accessToken = null;
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}
