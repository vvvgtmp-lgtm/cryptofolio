# api

Node 22 + TypeScript, Fastify 5, Kysely/pg, ioredis, fast-jwt, AWS SDK v3. Port 3000. OpenAPI UI at `/api/docs`.

| Area | Endpoints |
|------|-----------|
| Health | `GET /api/healthz`, `GET /api/readyz` (postgres, redis, storage), `GET /metrics` |
| Auth | `POST /api/auth/register · login · refresh · logout` |
| Profile | `GET/PATCH /api/me`, `POST /api/me/avatar/upload-url`, `PUT /api/me/avatar` |
| Portfolios | `GET/POST /api/portfolios`, `GET/PATCH/DELETE /api/portfolios/:id`, `GET …/:id/holdings`, `GET …/:id/snapshots?days=`, `GET/POST …/:id/transactions`, `DELETE /api/transactions/:id`, `GET /api/dashboard` |
| Market (public) | `GET /api/market/coins`, `GET /api/market/prices?ids=`, `GET /api/market/history/:id?days=1\|7\|30\|365` |
| Watchlist / alerts | `GET/POST /api/watchlist`, `DELETE /api/watchlist/:coinId`, `GET/POST /api/alerts`, `DELETE /api/alerts/:id` |
| Notifications | `GET /api/notifications?unread=`, `POST /api/notifications/:id/read`, `POST /api/notifications/read-all` |
| Files & jobs | `POST /api/uploads/import-url`, `POST /api/jobs`, `GET /api/jobs`, `GET /api/jobs/:id` |

Errors are always `{"error":{"code","message","details?"}}`. Notable codes: `validation_error` (400), `invalid_credentials` (401), `rate_limited` (429), `insufficient_holdings` (422), `price_service_unavailable` (502).

- **Migrations:** `migrations/*.sql` (node-pg-migrate). Add a new timestamped file and never edit an applied one. The `migrate` container runs `node dist/db/migrate.js`.
- **Tests:** `npm test` (unit), `npm run test:integration` (needs `docker-compose.test.yml`), `npm run lint`.

Env: see the api section of `.env.example` (`DATABASE_URL`, `REDIS_URL`, `PRICE_SERVICE_URL`, `JWT_*`, `COOKIE_SECURE`, `LOGIN_RATE_LIMIT_PER_MINUTE`, `JOBS_STREAM`, `S3_*`).
