# CryptoFolio — 3-tier crypto portfolio tracker for DevOps teaching

## Context
A DevOps instructor needs a realistic, polyglot, microservice web app to teach infra provisioning, CI/CD, and (later) GCP deployment. The app itself is a vehicle: clean, readable, fully env-configured, observable, and runnable with a single `docker compose up`. Scope of this work: **app + docker-compose only** (no CI workflows, no Terraform — built live in lessons). Project dir is empty: `/Users/art/Desktop/PicsArt Academy/online-lessons/3-tier-app`.

Agreed decisions: polyglot stack, 4 services + gateway, CoinGecko with mock switch, all four feature groups, monorepo, Nginx gateway, unit + integration tests, service communication = HTTP + Redis Streams job queue.

## Architecture
```
browser ──► gateway (nginx :80) ──► /        frontend (React+Vite, nginx static)
                                 └► /api/*   api (Node 22 + TS, Fastify)
api ──HTTP──► price-service (Python 3.12, FastAPI) ──► CoinGecko | mock
api ──XADD──► Redis Stream "jobs" ──XREADGROUP──► worker (Python 3.12)
api, worker ──► Postgres 16      price-service, api, worker ──► Redis 7
api (presign), worker ──► MinIO (S3 API; GCS-compatible later)
migrate (one-off, api image) runs migrations + seed, then exits
minio-init (one-off, mc) creates buckets, then exits
```

### Services
| Service | Responsibilities |
|---|---|
| gateway | Only published port (80). Routes, gzip, request-id header, `/api` → api:3000 |
| frontend | Pages: login/register, dashboard (total value, 24h change, P/L, allocation donut, value-history line), portfolios CRUD, portfolio detail (holdings table, transactions), add buy/sell tx, markets (coin list + search), coin detail (price chart 1d/7d/30d/1y), watchlist, alerts, notifications bell, profile (avatar upload), import/export page. Runtime config via `/config.js` generated at container start (one image for all envs — teaching point). |
| api | Auth: register/login, bcrypt, JWT access token (15m) + refresh (7d, httpOnly cookie); Redis login rate limit. CRUD: portfolios, transactions, watchlist, alerts. Holdings & P/L computed (avg-cost method) from transactions + prices from price-service. Notifications list/mark-read. Files: presigned PUT for avatar/CSV, presigned GET for downloads. Jobs: create `jobs` row + XADD. OpenAPI docs at `/api/docs`. |
| price-service | Endpoints: `/coins` (top 100 list), `/prices?ids=` (current + 24h change), `/history/{id}?days=`. Provider interface: `CoinGeckoProvider`, `MockProvider` (deterministic random walk seeded by coin id) chosen by `PRICE_PROVIDER`. Redis cache (TTL 60s prices, 1h coin list, 10m history) + last-known-good key → serves stale with `stale: true` on upstream failure. |
| worker | Redis Stream consumer group (`XREADGROUP`, `XACK`, pending retry up to 3, then job `failed`). Job types: `export_csv`, `import_csv`, `report_pdf` (reportlab) → writes to MinIO bucket, updates `jobs` row with object key. Scheduler (APScheduler): alert check every 60s → creates notifications, marks alert triggered; daily 00:00 UTC portfolio snapshots (plus on-startup backfill of today). |

### Data model (Postgres, migrations in `services/api/migrations`)
users(id uuid, email unique, password_hash, display_name, avatar_key, created_at) · portfolios(id, user_id, name, base_currency default 'usd', created_at) · transactions(id, portfolio_id, coin_id, type buy|sell, quantity numeric(38,18), price_usd numeric(38,18), fee_usd, executed_at, note) · watchlist(user_id, coin_id, PK both) · alerts(id, user_id, coin_id, direction above|below, target_price, active, triggered_at) · notifications(id, user_id, title, body, read_at, created_at) · portfolio_snapshots(portfolio_id, date, value_usd, PK both) · jobs(id, user_id, type, status queued|running|done|failed, params jsonb, result_key, error, created_at, updated_at).

### Buckets (MinIO)
`avatars`, `imports`, `exports` — private; access only via presigned URLs (TTL 15 min). Browser reaches MinIO via gateway path `/storage/` so presigned URLs work from one origin (`S3_PUBLIC_ENDPOINT`).

### Cross-cutting (every service)
`/healthz` (liveness) and `/readyz` (checks deps) · Prometheus `/metrics` (prom-client / prometheus-client; worker exposes on :9100) · JSON logs to stdout with request id · config only via env, documented in `.env.example` · multi-stage Dockerfile, non-root user, pinned base images, `.dockerignore` · compose `healthcheck` + `depends_on: condition: service_healthy / service_completed_successfully` · graceful SIGTERM shutdown.

## Repository layout
```
3-tier-app/
├── docker-compose.yml          # full stack
├── docker-compose.test.yml     # postgres/redis/minio for integration tests
├── .env.example  Makefile  README.md
├── gateway/ (nginx.conf, Dockerfile)
├── services/
│   ├── frontend/  (React 18, Vite, TS, TanStack Query, React Router, Recharts, Tailwind)
│   ├── api/       (Fastify, Kysely + pg, node-pg-migrate, zod, @aws-sdk/client-s3 + s3-request-presigner, ioredis, Vitest)
│   ├── price-service/ (FastAPI, httpx, redis-py, pydantic-settings, pytest, ruff)
│   └── worker/    (redis-py, psycopg 3, boto3, APScheduler, reportlab, pytest, ruff)
└── docs/ (architecture.md with diagram, services/*.md, superpowers/specs/…)
```

## Implementation order
0. `git init`; write spec to `docs/superpowers/specs/2026-09-28-cryptofolio-design.md` (this content), user reviews; then writing-plans skill produces the detailed task plan.
1. Skeleton: repo layout, `.env.example`, compose with postgres/redis/minio/minio-init, Makefile.
2. price-service (mock provider first, then CoinGecko, cache, stale fallback) + tests.
3. api: config, db, migrations + seed (demo user `demo@cryptofolio.local` / `demo1234` with sample portfolio), auth, portfolios/transactions/holdings, watchlist, alerts, notifications, files, jobs + tests.
4. worker: stream consumer, export/import/report jobs, scheduler (alerts, snapshots) + tests.
5. frontend: auth flow, all pages, runtime config.
6. gateway + wire everything in compose; health/metrics/logging pass.
7. docs: README (quick start, architecture, env vars, "what each infra component is used for", suggested lesson hooks), per-service docs.

## Verification
- `cp .env.example .env && docker compose up -d --build` → all containers healthy (`docker compose ps`), `migrate` and `minio-init` exited 0.
- `curl localhost/api/healthz`, `/api/readyz`; each service `/metrics` reachable inside network.
- Browser at http://localhost: log in as demo user; dashboard shows value, P/L, charts; add tx updates holdings; add watchlist coin; create alert with target near current mock price → notification appears within ~1 min; upload avatar; export CSV → job done → download works; import CSV adds tx; generate PDF report.
- `PRICE_PROVIDER=coingecko` works with real prices; stop network / bad URL → UI shows stale badge, no crash.
- `make test`: Vitest (api, frontend), pytest (price-service, worker) unit tests pass; integration tests pass against `docker-compose.test.yml`; ESLint + Ruff clean.
- `docker compose down -v && docker compose up -d` reproduces a clean state.
