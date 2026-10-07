# frontend

React 18 + Vite + TypeScript, TanStack Query, React Router, Recharts, Tailwind 4. Built into static files served by nginx-unprivileged on 8080 (`/healthz`).

- **Runtime config:** `docker-entrypoint.d/40-runtime-config.sh` writes `/config.js` from `APP_ENV` and `API_BASE_URL` at start. One image serves every environment.
- **Auth:** access token in memory, refresh via httpOnly cookie; `src/lib/api.ts` retries once after a single-flight refresh.
- **Uploads:** presigned PUT straight to object storage (`src/lib/upload.ts`).
- Dev: `npm run dev` (Vite on :5173, proxies `/api` to the gateway on :80).
- Tests: `npm run lint && npm test` (Vitest: API client + formatters). CI: `docker build --target test services/frontend`.

Env: `APP_ENV`, `API_BASE_URL` (default `/api`).
