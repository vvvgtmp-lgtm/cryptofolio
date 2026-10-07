# CryptoFolio — Execution Plan

> Read `business-requirements.md` first: it is the source of truth for behaviour and the normative
> interface contract (section 7). This plan fixes the **architecture, technology, conventions and task
> order** of a reference implementation that satisfies it. It deliberately contains **no source
> code**: you implement every task yourself, test-first.
>
> Work in task order. For each task, write the named tests first, watch them fail, implement, make
> them pass, run the task's acceptance commands, then commit (one or more commits per task).

## 1. Technology (use these versions)

| Area | Choice |
|---|---|
| Frontend | React 18, Vite, TypeScript 5, TanStack Query 5, React Router 6, Recharts 2, Tailwind CSS 4 (`@tailwindcss/vite`), lucide-react, Vitest; ESLint **9** + typescript-eslint + eslint-plugin-react-hooks 5 |
| API | Node 22, TypeScript 5 (ESM, `module: NodeNext`), Fastify 5 (+ @fastify/cookie, swagger, swagger-ui), Kysely + pg, node-pg-migrate 7 (SQL files), ioredis, zod **3**, fast-jwt, bcryptjs, decimal.js, prom-client, AWS SDK v3 (client-s3, s3-request-presigner), Vitest, ESLint |
| Price service | Python 3.12, FastAPI, uvicorn, httpx, redis-py, pydantic-settings, prometheus-client; pytest, fakeredis, ruff |
| Worker | Python 3.12, redis-py, psycopg 3 (+ pool), boto3, APScheduler 3, reportlab, httpx, prometheus-client, pydantic-settings; pytest, ruff |
| Infra | postgres:16-alpine, redis:7-alpine, **pgsty/minio** (community MinIO build that also ships `mc`), nginxinc/nginx-unprivileged:1.27-alpine, node:22-alpine, python:3.12-slim |

## 2. Architecture

```
browser ──► gateway (nginx :80→8080) ──► /            frontend (static SPA on nginx :8080)
                                     ├─► /api/*        api (:3000)
                                     └─► /cf-*/…       minio (:9000)  (pre-signed object URLs)
api ──HTTP──► price-service (:8000) ──► mock | binance | coingecko
api ──XADD──► Redis Stream "jobs" ──XREADGROUP (group "workers")──► worker (health/metrics :9100)
api, worker ──► Postgres        api, worker, price-service ──► Redis
api (signs URLs, HeadBucket), worker (get/put objects) ──► MinIO
migrate (one-off, api image): SQL migrations + demo seed      minio-init (one-off): buckets
```

- **Networks:** `edge` holds gateway, frontend, api and minio. `backend` holds api, price-service,
  worker, postgres, redis and minio.
- **Published ports:** only the gateway publishes one (`${GATEWAY_PORT:-80}:8080`).
- **Image names:** `${IMAGE_REGISTRY:-cryptofolio}/<service>:${IMAGE_TAG:-local}`. The `migrate`
  service reuses the api image with a different command.
- **Startup order:** app services depend on `postgres`/`redis`/`minio` being healthy and on
  `migrate`/`minio-init` having completed successfully. The price-service is only
  `service_started`, because it is a soft dependency.

### Repository layout
```
.env.example  Makefile  README.md  docker-compose.yml  docker-compose.test.yml
scripts/test.sh  scripts/smoke.mjs
gateway/{Dockerfile, templates/default.conf.template}
services/frontend  services/api  services/price-service  services/worker
docs/architecture.md  docs/services/<service>.md
```
No code is shared between services. Each has its own image, test stage and (later) its own pipeline.
The average-cost math therefore exists twice, in the api (TS) and in the worker (Python), each with
its own tests.

## 3. Data, keys and conventions

### 3.1 PostgreSQL schema (one SQL migration)

| Table | Columns / constraints |
|---|---|
| users | id uuid PK default gen_random_uuid(), email text unique, password_hash, display_name, avatar_key null, created_at |
| portfolios | id, user_id → users ON DELETE CASCADE, name, base_currency default 'usd', created_at; UNIQUE(user_id, name) |
| transactions | id, portfolio_id → portfolios CASCADE, coin_id text, type CHECK buy/sell, quantity numeric(38,18) CHECK > 0, price_usd numeric(38,18) ≥ 0, fee_usd numeric(38,18) default 0 ≥ 0, executed_at timestamptz, note null, created_at; INDEX(portfolio_id, executed_at) |
| watchlist | (user_id, coin_id) PK, created_at |
| alerts | id, user_id, coin_id, direction CHECK above/below, target_price numeric(38,18) > 0, active bool default true, triggered_at null, created_at; partial INDEX(coin_id) WHERE active |
| notifications | id, user_id, title, body, read_at null, created_at; INDEX(user_id, created_at desc) |
| portfolio_snapshots | (portfolio_id, date) PK, value_usd numeric(38,2) |
| jobs | id, user_id, type CHECK export_csv/import_csv/report_pdf, status CHECK queued/running/done/failed default queued, params jsonb, result_key null, result jsonb null, error null, attempts int default 0, created_at, updated_at; INDEX(user_id, created_at desc) |

- Configure the pg driver to return `date` columns as `YYYY-MM-DD` strings, with no timezone shifts.
- **Locking rule:** every writer that validates holdings takes `SELECT … FROM portfolios WHERE id=$1
  AND user_id=$2 FOR UPDATE` inside its transaction, then loads, validates and writes. Writers are the
  api's create/delete transaction and the worker's CSV import. This is what makes concurrent sells
  safe.
- Numeric input limits: at most 20 integer digits and 18 decimals.

### 3.2 Redis
| Key / stream | Purpose |
|---|---|
| `cache:<provider>:price:<id>` (TTL 60 s), `cache:<provider>:coins` (1 h), `cache:<provider>:history:<id>:<days>` (10 min) | price cache, **namespaced by provider** |
| `lkg:<provider>:…` (no TTL) | last-known-good copy, served with `stale: true` when the provider fails |
| `ratelimit:login:<ip>`, `ratelimit:register:<ip>` | fixed 60 s window counters |
| `refresh:<jti>` → userId (TTL = refresh lifetime) | refresh-token allow list; GETDEL on refresh (rotation), DEL on logout |
| stream `jobs` (MAXLEN ~10000), field `job_id`; consumer group `workers`; consumer name = container hostname | job queue |

### 3.3 Object storage
- Buckets (names from env): `cf-avatars`, `cf-imports`, `cf-exports`. All private.
- Object keys:
  - avatars `<userId>/<uuid>`;
  - imports `<userId>/<uuid>.csv`;
  - exports `<userId>/<jobId>.csv|.pdf`.
- **Two S3 clients in the api:**
  - an *internal* one (`S3_ENDPOINT=http://minio:9000`) for HeadBucket;
  - a *public* one (`S3_PUBLIC_ENDPOINT=http://localhost`) used **only to sign URLs** that the browser
    calls through the gateway.
- Path-style addressing; presigned TTL 15 min.
- Presigned PUTs **sign the Content-Type**: avatars ∈ png/jpeg/webp/gif, imports `text/csv`.
- Downloads set `response-content-disposition: attachment; filename="…"`.

### 3.4 Price-service contract (internal, port 8000)
- `GET /coins` → `{coins:[{id,symbol,name,image,current_price,change_24h,market_cap}],stale}`.
- `GET /prices?ids=` (1–100 ids) → `{prices:{id:{usd,change_24h}},stale}`.
- `GET /history/{id}?days=1|7|30|365` → `{id,days,points:[[ts_ms,price]],stale}`.
- Errors: 400 for bad input, 404 for an unknown coin, 503 `{"detail":"price provider unavailable"}`
  when the provider fails and nothing is cached.
- The api maps snake_case to camelCase and maps 503/network errors to 502
  `price_service_unavailable`.
- Providers:
  - **mock** (default): 20-coin catalogue `(id, symbol, name, base_price, supply)`. The price is a
    pure function of (coin id, time): a sum of sine waves with a per-coin phase, within about ±12% of
    the base. Stablecoins stay within ±0.1%.
  - **binance** (free, no key): `https://data-api.binance.vision`.
    - `GET /api/v3/ticker/24hr?symbols=[…]` fetches all coins in one call.
    - `GET /api/v3/klines?symbol=<SYM>USDT&interval=5m|1h|4h|1d&limit=289|169|181|366` gives history.
    - USDT is the quote currency, so Tether = $1.
    - Market cap = price × catalogue supply; no logos.
  - **coingecko** (optional): `/coins/markets`, `/simple/price`, `/coins/{id}/market_chart`, with an
    optional free Demo key header.
- The history point spacing for days 1/7/30/365 is 300 s / 1 h / 4 h / 1 d.

### 3.5 Holdings math (both api and worker)
- Replay transactions sorted by `executed_at`, with **buys before sells at equal timestamps**, using
  exact decimals:
  - a buy adds quantity × price + fee to the cost basis;
  - a sell first checks that quantity ≤ held quantity (else raise an oversell error), then realizes
    quantity × price − fee − avg × quantity and removes avg × quantity from the cost basis.
- Open positions only appear in holdings. Totals are built as follows:
  - **Value, cost and unrealized P/L:** only priced coins count.
  - **24h change:** Σ(value − value/(1 + change%/100)).
  - **Realized P/L:** summed over all positions.
- Money is rounded to 2 dp; percentages are null when the denominator is 0.

## 4. Tasks

Each task lists **tests to write first** and **acceptance** checks. "Integration" tests run against
`docker-compose.test.yml`, which must always be invoked as
`docker compose -p cryptofolio-test -f docker-compose.test.yml …`. It publishes Postgres, Redis and
MinIO on host ports 55432/56379/59000, with a tmpfs database.

### T1 — Repository skeleton and infrastructure
- **Files:** `.gitignore`, `.env.example` (every variable documented; `COMPOSE_PROJECT_NAME`
  commented out), `Makefile` (env, up, down, clean, ps, logs, test, smoke), `docker-compose.yml` with
  postgres, redis (appendonly), minio (curl healthcheck on `/minio/health/live`) and minio-init (runs
  `mc mb --ignore-existing` for 3 buckets, anonymous access `none`). Add named volumes and the
  `edge`/`backend` networks.
- **Acceptance:** `docker compose up -d`; 3 services are healthy and minio-init exits 0.

### T2 — Price service: scaffold + mock provider
- **Files:** Dockerfile (targets base/deps/test/runtime; runtime is non-root and runs uvicorn in
  factory mode), pyproject (ruff E,F,I,UP,B; ignore E501), `app/config.py`, `app/logging_setup.py`
  (JSON formatter), `app/providers/{base,catalogue,mock}.py`.
- **Tests first** (`test_mock_provider.py`):
  - deterministic for the same timestamp;
  - moves over time;
  - stays within 0.85–1.15 × base;
  - unknown ids omitted;
  - change_24h equals the price 24 h ago;
  - list sorted by market cap with bitcoin first;
  - history point counts 288/168/180/365 (+ up to 2), ascending, ending at now;
  - unknown coin raises; unsupported days raise.
- **Acceptance:** `docker build --target test services/price-service` then run the image: ruff clean,
  all tests pass.

### T3 — Price service: cache with last-known-good
- **Files:** `app/metrics.py` (request histogram, cache events hit/miss/stale, upstream errors),
  `app/cache.py` `PriceService(provider, redis, ttls…, key_prefix)`.
- **Tests first** (`test_cache.py`, fakeredis):
  - second call is served from cache;
  - only missing ids are fetched;
  - TTL is set and lkg has no TTL;
  - lkg is served with stale=true when the provider is down;
  - raises when down with an empty cache;
  - unknown ids are not returned;
  - coins lkg fallback;
  - history is cached;
  - unknown coin propagates;
  - **cache is namespaced per provider**.

### T4 — Price service: real providers + HTTP API + compose
- **Files:** `providers/coingecko.py`, `providers/binance.py` (both with an injectable httpx
  transport for tests; every transport error / status ≥400 / bad JSON becomes ProviderError),
  `app/main.py` (`create_app`, request-id middleware, `/healthz`, `/readyz` (Redis ping), `/metrics`,
  `/coins`, `/prices`, `/history`; `build_service` picks the provider by `PRICE_PROVIDER` and uses the
  provider name as the cache key prefix).
- **Tests first:**
  - **coingecko:** parses prices and sends the key; no call for empty ids; 429/network/invalid JSON →
    error; 404 → unknown coin; tolerates null fields.
  - **binance:** one call covers the catalogue; symbols exclude USDTUSDT; market cap = price × supply
    and sorted; Tether is $1; only known ids requested; no call without known ids; history uses the
    right interval and limit per days; flat Tether history; 400/418/429/500/network/bad JSON → error.
  - **api:** health, ready, metrics exposed, coins shape, prices, 400 for empty/over-100 ids, history
    days validation, 404 for an unknown coin, 503 when the provider is down with no cache,
    `build_service` selects binance with prefix `binance:`.
- **Compose:** add price-service (backend only) with a python-urllib healthcheck.
- **Acceptance:** container healthy; `/prices?ids=bitcoin` answers from inside the container.

### T5 — API: scaffold, schema, migrations, seed, health, metrics
- **Files:** package.json scripts (build, lint = `eslint . && tsc --noEmit`, test, test:integration),
  tsconfig (+ a build config), Dockerfile (deps/build/test/prod-deps/runtime; runtime runs as `node`),
  `src/config.ts` (zod env schema; fail fast listing every problem), `src/lib/errors.ts` (HttpError +
  central error handler mapping zod → 400 `validation_error`, unknown → 500 without leaking),
  `src/lib/validation.ts` (uuid param, bounded decimal-string schema), `src/db/{database,migrate,seed}.ts`,
  `migrations/<ts>_init.sql`, `src/plugins/metrics.ts` (a registry per app instance), health routes,
  `app.ts`, `server.ts` (SIGTERM → close app → close deps), and `docker-compose.test.yml` (infra +
  migrate).
- **Config rules:** JWT secrets ≥ 32 chars. When `APP_ENV != local`, refuse `change-me` placeholders
  and equal access/refresh secrets. Also `TRUST_PROXY_HOPS` (default 1), login/register rate limits
  (default 10/min), and `COOKIE_SECURE`.
- **Tests first:**
  - **unit config:** defaults applied, coercion, missing vars named, short secret rejected, placeholder
    secret refused outside local, identical secrets refused outside local, trust-proxy default 1.
  - **integration health:** liveness ok; readiness checks postgres + redis (+ storage later); metrics
    exposed; request id echoed; JSON 404 for unknown routes.
- **Seed** (idempotent, enabled by `SEED_DEMO_DATA=true`): demo user, "Long-term HODL"
  (BTC/ETH/SOL buys + one ETH sell), "Active Trading" (DOGE/ADA/LINK), watchlist, alert BTC above
  80,000, a welcome notification, 30 days of synthetic snapshots.
- **Acceptance:** migrate prints "applied 1 migration(s)" then "applied 0" on a rerun; the api is
  healthy in compose.

### T6 — API: authentication and profile
- **Files:** `lib/tokens.ts` (fast-jwt; access typ, refresh typ with `jti`), `lib/rateLimit.ts`,
  `plugins/auth.ts` (Bearer preHandler; `request.userId`), `routes/auth.ts`, `routes/me.ts`. All
  protected routes are registered inside one encapsulated plugin with the preHandler.
- **Fastify `trustProxy`:** pass a function `(addr, hop) => hop < TRUST_PROXY_HOPS`.
- **Tests first:**
  - **unit tokens:** round trip; access ≠ refresh; expired rejected; tampered rejected.
  - **integration:**
    - registration and cookies: register normalises email and sets an httpOnly/SameSite=Strict
      cookie with path `/api/auth`; duplicate → 409; short password → 400;
    - login: correct password only;
    - rate limits: login rate limited; **spoofed X-Forwarded-For cannot bypass the login limit**;
      **register rate limited**;
    - refresh: works from the cookie; no cookie or an access token → 401; **refresh token is
      single-use**; **logout revokes the refresh token**;
    - profile: /me requires auth; PATCH /me.

### T7 — API: price client, market proxy, watchlist, alerts, notifications
- **Files:** `lib/priceClient.ts` (HTTP client with timeout; `assertKnownCoin`; `pricesOrEmpty`
  degrades to `{prices:{}, stale:true}` on 502), `routes/{market,watchlist,alerts,notifications}.ts`,
  and a FakePriceClient in the test helpers.
- **Tests first:**
  - **unit:** mapping; no call for empty ids; 404 → not found; 5xx/network → 502; pricesOrEmpty.
  - **integration:**
    - market: coins public; prices; history days validation / 404; 502 when down;
    - watchlist: add/list/remove, idempotent; unknown coin 400; per-user;
    - alerts: create/list with current price/delete; validation; another user's → 404; list still
      works when prices are down;
    - notifications: list/unread count/mark one/mark all; another user's → 404.

### T8 — API: holdings math
- **File:** `lib/holdings.ts` (see 3.5).
- **Unit tests first:**
  - fees in the cost basis;
  - average of buys;
  - realized P/L on sells;
  - oversell throws;
  - sell dated before the buy throws;
  - buy before sell at equal timestamps;
  - exact decimals (0.1 + 0.2 − 0.3 = 0);
  - value/unrealized/allocation;
  - 24h change;
  - closed positions keep realized P/L;
  - missing prices reported without crashing;
  - empty portfolio.

### T9 — API: portfolios, transactions, holdings, snapshots, dashboard
- **Files:** `lib/portfolios.ts` (`getOwnedPortfolio` 404, **`lockOwnedPortfolio` with FOR UPDATE**,
  `loadTransactions`, DTO mappers), `routes/{portfolios,transactions,dashboard}.ts`.
- **Transaction writes:** create and delete run in **one DB transaction under the portfolio lock**.
- **Integration tests first:**
  - portfolios: CRUD; duplicate name 409 (other users may reuse it); **every portfolio route returns
    404 for another user**; malformed id 400;
  - holdings and validation: holdings computed; oversell 422; back-dated sell 422; validation (unknown
    coin, 0, negative, bad type, future date); **huge number → 400**;
  - deletions: deleting a needed buy → 422, deleting the sell OK; another user's transaction → 404;
  - ordering and resilience: list newest first with totals; holdings still 200 with null values when
    prices are down; snapshots in date order within the window;
  - dashboard: aggregates and sums history by date;
  - concurrency: **12 concurrent sells of 1 held BTC → exactly one 201 and eleven 422, and holdings
    still 200**.

### T10 — API: storage, uploads, avatar, jobs
- **Files:** `lib/storage.ts` (two clients; `requestChecksumCalculation/responseChecksumValidation:
  WHEN_REQUIRED`; `presignPut(bucket, key, contentType)` with content-type as a signed header;
  `presignGet` with a download name), `lib/queue.ts` (XADD with MAXLEN ~), `routes/{uploads,jobs}.ts`,
  avatar routes in `me.ts`. Readiness also checks storage.
- **Tests first:**
  - **unit storage:** URL on the public endpoint, path-style, 900 s; no checksum params; content type
    is signed; content-disposition.
  - **integration:**
    - readiness includes storage;
    - avatar round trip via a real presigned PUT/GET against MinIO;
    - **only raster image types get an upload URL**;
    - **storage rejects a PUT whose Content-Type differs from the signed one** (both buckets);
    - another user's avatar key → 400;
    - import URL scoped to the user;
    - export job queued and on the stream;
    - another user's portfolio or key → 404/400;
    - unknown type 400;
    - download URL once done; jobs private.

### T11 — Worker: scaffold, adapters, positions
- **Files:** Dockerfile (test stage runs integration tests only with `INTEGRATION=1`),
  `worker/{config,logging_setup,metrics,db,storage,prices,portfolio}.py`. boto3 is configured with
  path style and checksum calculation `when_required`; the price client chunks ids by 100.
- **Unit tests first:** positions (average cost with fees, realized P/L, oversell, sell before buy,
  same-timestamp ordering, exact decimals); price client (chunking, no call for empty ids, errors,
  coin index).

### T12 — Worker: CSV format and PDF report
- **Files:** `csv_io.py` (build/parse, `CsvImportError(errors)`, max 5000 rows, same numeric bounds
  as the api, no future dates, coin_id ≤ 100 chars), `report.py` (reportlab table, escaped text).
- **Unit tests first:**
  - round trip;
  - naive dates → UTC, fee default 0;
  - BOM, blank lines, missing note column;
  - empty file, header only, wrong header;
  - row-numbered errors covering every field;
  - NaN/Infinity rejected;
  - too many rows;
  - **out-of-range numbers** and **future dates / long coin ids** as row errors;
  - PDF starts with `%PDF`, including for an empty portfolio.

### T13 — Worker: job handlers and stream consumer
- **Files:** `jobs.py` (Job, JobOutcome, `PermanentJobError`, handlers for export_csv, import_csv and
  report_pdf; the import runs in one transaction under the portfolio `FOR UPDATE` lock), `consumer.py`.
- **Consumer behaviour:**
  - ensure the group; XAUTOCLAIM idle messages (60 s); XREADGROUP (block 5 s);
  - mark the job running and increment attempts;
  - permanent error → failed; other error → requeue until 3 attempts, then failed;
  - always XACK; skip done/failed jobs; ignore invalid job ids.
- **Integration tests first** (INTEGRATION=1; run inside network `cryptofolio-test_default`):
  - handlers: export writes the object + filename; import inserts all rows; import oversell → nothing
    inserted; unknown coins; row errors; missing file / foreign key / foreign portfolio; PDF;
    export→import round trip keeps 18 decimals;
  - consumer: end to end; permanent error no retry; retry then fail after 3; reclaim from a dead
    consumer; skip finished jobs; garbage messages acked; unknown type fails.

### T14 — Worker: scheduler, health server, entrypoint, compose
- **Files:** `scheduled.py`:
  - `evaluate_alert` (inclusive);
  - `check_alerts`: claims each alert with `UPDATE … WHERE active RETURNING`, so it is safe with many
    workers, and inserts a notification;
  - `take_snapshots`: upserts today; skips portfolios with a missing price; empty portfolios → 0.

  Also `health.py` (tiny HTTP server: /healthz = consumer heartbeat, /readyz, /metrics) and `main.py`
  (APScheduler: alerts every `ALERT_CHECK_INTERVAL_SECONDS` starting now, snapshots hourly at :00 and
  at start; SIGTERM stops cleanly). Set the httpx logger to WARNING.
- **Tests first:** evaluate_alert table; health endpoints; alerts trigger once and skip unpriced coins;
  no price call when there are no alerts; snapshot values + upsert.
- **Compose:** worker (backend only), python healthcheck on 9100.
- **Acceptance:** logs show "worker started" and both scheduled tasks finishing;
  `docker compose up -d --scale worker=2` shows 2 consumers in `XINFO CONSUMERS jobs workers`.

### T15 — Frontend: scaffold, API client, auth, layout, container
- **Files:**
  - `lib/api.ts`: access token in memory, `credentials: include`, a single-flight refresh on 401 that
    retries once, `onUnauthorized`, an `ApiError` carrying the error code;
  - `lib/format.ts`: set `minimumFractionDigits: 0` explicitly for compact USD, because container
    ICU differs;
  - types, `config.ts` reading `window.__CONFIG__`;
  - auth context (resumes the session via refresh on load), RequireAuth, UI kit, Layout (nav + env
    badge), login (with a demo helper), register, profile, not-found;
  - `nginx.conf` (SPA fallback, `/config.js` no-store, `/assets` immutable, `/healthz`);
  - `docker-entrypoint.d/40-runtime-config.sh` writes `config.js` from env (the file must exist in
    the image and be writable by uid 101).
- **Tests first** (Vitest):
  - api client: bearer + JSON; refresh-once-and-retry; **concurrent 401s share one refresh**; failed
    refresh → onUnauthorized; auth:false never refreshes; error mapping; 204.
  - formatters.

### T16 — Gateway and end-to-end wiring
- **File:** `gateway/templates/default.conf.template` (envsubst of the bucket names).
  - JSON access log; map the request id (reuse or mint); Docker DNS resolver with variable upstreams.
  - **All `proxy_set_header` lines at server level.** A location that sets its own loses the
    server-level ones.
  - `/api/` → api, `/` → frontend.
  - `~ ^/(bucket1|bucket2|bucket3)/` → minio with **Host and path unchanged** (both are signed),
    buffering off, plus `add_header` CSP `default-src 'none'; img-src 'self'; style-src
    'unsafe-inline'; sandbox`, `X-Content-Type-Options: nosniff` and the request id again. Setting
    `add_header` in a location drops the server-level ones.
- **Acceptance (curl through :80):**
  - `/gateway/healthz` ok; `/api/readyz` ready; `/metrics` returns the SPA, not metrics;
    `/portfolios` returns 200 (SPA);
  - demo login → dashboard with value > 0;
  - a presigned avatar PUT through the gateway returns 200;
  - gateway logs are JSON.

### T17–T19 — Frontend pages
- **T17:** hooks + dashboard (4 stats, 30-day chart, allocation donut, holdings, portfolio list),
  portfolios, portfolio detail (rename, delete, stats, charts, holdings, transactions with delete,
  add-transaction modal that shows API errors).
  - Allocation legend: stack from the `lg` breakpoint up so it never overflows.
  - Recharts: disable animations, which otherwise replay on every refetch.
- **T18:** markets (search, star), coin detail (range tabs, alert form, record trade), watchlist,
  alerts, notifications page and bell (polls every 30 s).
- **T19:** avatar uploader (allow-listed types, sends the chosen `contentType`), files page (export,
  report, import via presigned PUT with `text/csv`, job list polling every 1.5 s while any job is
  active, refreshes portfolio data when an import completes).
- **Gate per task:** lint + tsc + unit tests + production build. Rebuild the container at the end.

### T20 — Containerised test runner
- **Files:** add `price-service-test`, `api-test`, `worker-test` and `frontend-test` services (each
  built from its `test` target, with integration env pointing at the service names) to
  `docker-compose.test.yml`, and `scripts/test.sh`.
  - `test.sh` uses `-p cryptofolio-test` and a trap that always tears down.
  - It starts the infra with `--wait`, runs minio-init and migrate, then builds and runs each runner.
- **Acceptance:** `make test` ends with "all tests passed" and leaves nothing running. A deliberately
  broken test makes it exit non-zero.

### T21 — Smoke test, docs, final verification
- **`scripts/smoke.mjs`:** gateway, readiness, demo login + dashboard, fresh user, prices, create +
  buy + holdings, oversell 422, CSV export download, CSV import, PDF, avatar round trip (HTML type
  refused, spoofed PUT 403), alert → notification.
- **Docs:** README (see the requirements), `docs/architecture.md` (mermaid topology + flows),
  `docs/services/*.md`.
- **Final verification:**
  - `make clean && make up`, `make smoke`, `make test`;
  - a browser walk-through of every page;
  - `PRICE_PROVIDER=binance` live check;
  - stale fallback with a broken provider URL;
  - only the gateway publishes a port.

## 5. Known pitfalls (read before starting)
1. **Docker images:**
   - The official `minio/minio` and `minio/mc` images can no longer be pulled. Use `pgsty/minio`
     for both the server and the init job (`mc` is included). Healthcheck with curl on
     `/minio/health/live`.
   - Binance's regular API is geo-restricted in some countries; use the market-data host
     `data-api.binance.vision`.
2. **Compose projects:** a `COMPOSE_PROJECT_NAME` in `.env` overrides the top-level `name:` of
   *every* compose file in that directory. The test infrastructure would then **replace the dev
   stack's containers**. Always run test compose with `-p cryptofolio-test`.
3. **Presigned URLs from browsers:**
   - AWS SDK v3 ≥ 3.729 adds CRC32 checksum parameters by default, which browsers cannot satisfy. Set
     checksum calculation/validation to WHEN_REQUIRED in the api and `when_required` in boto3.
   - SigV4 signs Host and path, so the gateway must not rewrite either.
   - `S3_PUBLIC_ENDPOINT` must equal the URL the browser uses, including the port.
4. **nginx:** `proxy_set_header` and `add_header` are **not inherited** by a location that defines its
   own.
5. **Security bugs seen in a previous build** (prevent them):
   - stored XSS from an unsigned content type on same-origin uploads;
   - check-then-insert oversell race;
   - `trustProxy: true` allowing X-Forwarded-For spoofing;
   - a non-revocable refresh JWT;
   - 8-character JWT secrets accepted;
   - price cache not namespaced by provider.
6. **Toolchain:**
   - Under TypeScript NodeNext, `decimal.js` must be imported as `{ Decimal }`.
   - Fastify's types reject a numeric `trustProxy` in an options literal; use the hop function and
     type the options as `FastifyServerOptions`.
   - `eslint-plugin-react-hooks@5` requires ESLint ≤ 9.
   - Pin zod 3.
7. **Formatting:** container Node (alpine ICU) formats `Intl` compact currency differently from
   desktop Node; set fraction digits explicitly. Run unit tests in the container too.
8. **Python lint:** let `ruff format` own line length (ignore E501). Long SQL literals cannot be
   wrapped automatically.
9. **Headless screenshots:** full-page screenshots resize the viewport and can capture Recharts
   mid-layout. Verify chart width by measuring the SVG, not by eye.

## 6. Definition of done
Everything in `business-requirements.md` section 8, plus:
- all tasks' named tests exist and pass;
- `make test`, `make smoke` and the acceptance test pass from a clean clone.
