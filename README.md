# CryptoFolio: a 3-tier microservice app for DevOps training

CryptoFolio is a small but realistic **crypto portfolio tracker**. You can register, keep several
portfolios, record buy/sell transactions and see live value and profit/loss. It also has charts,
a watchlist, price alerts, avatar upload, CSV import/export and PDF reports.

The app itself is the teaching vehicle. It has several services in different languages, a
database, a cache and queue, object storage and background jobs. Everything is configured by
environment variables and ships with health checks, metrics and tests. That makes it good
material for lessons on **infrastructure provisioning, containers, CI/CD and cloud deployment (GCP)**.

## Quick start

```bash
git clone https://github.com/vvvgtmp-lgtm/cryptofolio.git && cd cryptofolio
cp .env.example .env
docker compose up -d --build        # or: make up
```

Open **http://localhost** and log in with **demo@cryptofolio.local / demo1234**, or register a new user.

| Command       | What it does                                                        |
|---------------|---------------------------------------------------------------------|
| `make up`     | build and start everything                                          |
| `make ps`     | container status (all long-running services should be `healthy`)   |
| `make logs s=api` | follow one service's JSON logs                                  |
| `make test`   | lint + unit + integration tests of every service, in containers     |
| `make smoke`  | end-to-end smoke test against the running stack (needs Node ≥ 18)   |
| `make down`   | stop (keep data) · `make clean` stop and delete all data            |

> Port 80 busy? Set `GATEWAY_PORT=8080` **and** `S3_PUBLIC_ENDPOINT=http://localhost:8080` in `.env`
> (presigned file URLs must use the address your browser uses).

## Architecture

```
                        ┌──────────────────── edge network ───────────────────┐
 browser ──► gateway (nginx :80) ──► /          frontend  (React SPA, nginx)
                                 ├─► /api/*     api       (Node/TypeScript, Fastify)
                                 └─► /cf-*/*    minio     (presigned uploads/downloads)
                        └─────────────────────────────────────────────────────┘
                        ┌─────────────────── backend network ─────────────────┐
 api ──HTTP──► price-service (Python/FastAPI) ──► CoinGecko or built-in mock feed
 api ──XADD──► Redis Stream "jobs" ──XREADGROUP──► worker (Python) ── scheduler
 api, worker ──► Postgres        api, worker, price-service ──► Redis
 api (sign URLs), worker (read/write objects) ──► MinIO
 migrate (one-off): SQL migrations + demo seed      minio-init (one-off): buckets
                        └─────────────────────────────────────────────────────┘
```

| Service         | Stack                     | Responsibility | Health / metrics |
|-----------------|---------------------------|----------------|------------------|
| `gateway`       | nginx (unprivileged)      | the only published port; routing, request ids, JSON access logs | `/gateway/healthz` |
| `frontend`      | React 18 + Vite, nginx    | single-page app; config injected at start (`/config.js`) | `/healthz` |
| `api`           | Node 22, Fastify, Kysely  | auth (JWT + refresh cookie), portfolios, P/L, watchlist, alerts, presigned URLs, job API | `/api/healthz`, `/api/readyz`, `/metrics` |
| `price-service` | Python 3.12, FastAPI      | market data with Redis cache and "last known good" fallback | `/healthz`, `/readyz`, `/metrics` |
| `worker`        | Python 3.12               | Redis Stream consumer (CSV import/export, PDF reports) + scheduler (price alerts every minute, hourly portfolio snapshots) | `:9100/healthz`, `/readyz`, `/metrics` |
| `migrate`       | api image, one-off        | `node-pg-migrate` SQL migrations + demo data | exits 0 |
| `minio-init`    | `mc`, one-off             | creates the private buckets | exits 0 |

### What each infrastructure component is used for

| Component | Used for | In GCP this becomes |
|-----------|----------|---------------------|
| **Postgres 16** | users, portfolios, transactions, watchlist, alerts, notifications, daily snapshots, job records | Cloud SQL for PostgreSQL |
| **Redis 7** | price cache + last-known-good, job queue (Redis Streams consumer group), login rate limiting | Memorystore for Redis |
| **MinIO (S3 API)** | avatars, uploaded CSVs, generated CSV/PDF exports, all private and reached via presigned URLs | Cloud Storage (S3-interoperable XML API with HMAC keys) |
| **gateway** | TLS-less edge routing | External HTTPS Load Balancer / GKE Ingress |
| **migrate** | schema changes before rollout | Cloud Run Job / Kubernetes Job / pipeline step |
| **minio-init** | bucket creation | Terraform `google_storage_bucket` |

## Configuration

Every setting is an environment variable. See **`.env.example`** for the documented list.
Highlights:

| Variable | Default | Notes |
|----------|---------|-------|
| `PRICE_PROVIDER` | `mock` | `mock` = offline deterministic prices (best for classrooms); `binance` = **real prices, free, no API key, no quota** (20 coins, no logos); `coingecko` = real prices for the top 100 coins with logos (keyless access is rate limited to ~5-15 calls/min; a free CoinGecko Demo key in `COINGECKO_API_KEY` raises that) |
| `GATEWAY_PORT` / `S3_PUBLIC_ENDPOINT` | `80` / `http://localhost` | must describe the same address |
| `IMAGE_REGISTRY` / `IMAGE_TAG` | `cryptofolio` / `local` | image names `<registry>/<service>:<tag>`, which is what CI pushes |
| `SEED_DEMO_DATA` | `true` | the migrate job creates the demo user |
| `ALERT_CHECK_INTERVAL_SECONDS` | `60` | worker alert scheduler |

## Things to try in class

- Real prices: set `PRICE_PROVIDER=binance` in `.env` and run `docker compose up -d price-service`. Only that one container changes; portfolios keep working because coin ids are the same for every provider. Switch back to `mock` the same way.

- `docker compose up -d --scale worker=3`, then `docker compose exec redis redis-cli XINFO CONSUMERS jobs workers`. The consumer group spreads jobs across workers.
- `docker compose stop worker`, export a CSV (it stays *queued*), then `start worker` and watch it complete. Kill a worker mid-job and the message is reclaimed after 60 s (`XAUTOCLAIM`).
- `docker compose stop price-service`. The UI keeps working: holdings show "—" and a *stale prices* badge appears, and `/api/readyz` stays ready because it is a soft dependency.
- `docker compose stop redis` → `/api/readyz` returns 503 and shows which check failed.
- Change `APP_ENV` and restart only `frontend`. The same image shows a different environment badge (runtime config).
- `curl -s localhost/api/healthz -H 'x-request-id: demo-1'`, then `docker compose logs | grep demo-1` to trace one request across gateway and api.
- `docker compose exec api node -e "fetch('http://127.0.0.1:3000/metrics').then(r=>r.text()).then(console.log)"`: Prometheus metrics (not exposed publicly).
- `docker build --target test services/api`: every Dockerfile has a `test` stage for CI.
- `docker compose exec postgres psql -U cryptofolio -c 'select * from pgmigrations'`: migration history.

## Notes on images

- **MinIO:** the official `minio/minio` and `minio/mc` Docker images are no longer published, so this project uses the
  community build `pgsty/minio` (same `minio server` binary, and it ships `mc`). Any S3-compatible server works:
  only `S3_ENDPOINT` and the credentials matter to the app.
- **Tests:** `docker-compose.test.yml` is always run with `-p cryptofolio-test` (see `scripts/test.sh`), so it can
  never reuse or replace the containers of your running dev stack.

## Repository layout

```
gateway/                  nginx edge config (template rendered at start)
services/frontend/        React SPA              services/api/        Node/TS API + migrations
services/price-service/   Python market data     services/worker/     Python jobs + scheduler
docker-compose.yml        the whole stack        docker-compose.test.yml  test infra + runners
scripts/test.sh           CI-style test runner   scripts/smoke.mjs    end-to-end smoke test
docs/                     architecture and per-service docs
```

See [docs/architecture.md](docs/architecture.md) for request flows and [docs/services/](docs/services) for each service's API, configuration and operational notes.
