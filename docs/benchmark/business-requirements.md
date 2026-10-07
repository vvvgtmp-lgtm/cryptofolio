# CryptoFolio — Business Requirements

> Build this application from scratch. This document says **what** the system must do and the
> constraints it must respect. Programming languages, frameworks and libraries are your choice unless
> a constraint below says otherwise. Section 7 (Interface contract) is **normative**: an automated
> acceptance test will be run against it.

## 1. Purpose and audience

CryptoFolio is a **crypto portfolio tracker**. Its real purpose is to be a **teaching vehicle for a
DevOps course**. Students will use it to learn:

- infrastructure provisioning;
- containers;
- CI/CD pipelines;
- deployment to **Google Cloud Platform (GCP)**, in later lessons.

The app must therefore be:

- **realistic**: real features, several services, real infrastructure components;
- **operable**: configurable by environment, observable, health-checked, testable in containers;
- **easy to start**: one command brings up everything on a laptop, and it works offline by default.

Users of the product: a learner who wants to track crypto holdings. Users of the repository: a DevOps
instructor and their students.

## 2. Product scope — user stories and acceptance criteria

### 2.1 Accounts and sessions
- **Register** with email, password (min 8 chars) and display name.
  - Emails are case-insensitive and trimmed.
  - A duplicate email is rejected.
- **Log in** with email and password. Wrong credentials give one generic error; it must not reveal
  which of the two was wrong.
- **Stay logged in** across page reloads, for up to 7 days of inactivity, without storing the long-lived
  credential where page scripts can read it.
- **Log out**; after logout the previous session can no longer be resumed.
- **Profile**: change the display name.
- **Avatar**:
  - Upload a picture: PNG, JPEG, WebP or GIF, at most 2 MB.
  - It is shown in the header and on the profile.
- A demo account exists after first start: `demo@cryptofolio.local` / `demo1234`, with two sample
  portfolios, transactions, a watchlist, one alert, one notification and 30 days of value history.

### 2.2 Portfolios
- A user can **create, rename, delete and list** portfolios.
  - Names are unique per user; two users may use the same name.
  - Deleting a portfolio deletes its transactions.
- The portfolio list shows each portfolio's current value, 24h change and unrealized P/L.

### 2.3 Transactions and holdings
- Record a **buy or sell** of a coin with these fields:
  - quantity (up to 18 decimals, greater than 0);
  - price in USD (0 or more);
  - optional fee in USD (0 or more);
  - date/time (not in the future; defaults to now);
  - optional note (max 200 chars).
- Only coins known to the market catalogue (section 2.5) are accepted.
- **Holdings** use the **average-cost method**:
  - a buy adds its quantity × price + fee to the cost basis;
  - a sell realizes P/L = quantity × price − fee − (average cost × quantity);
  - a fully sold coin disappears from holdings, but its realized P/L still counts.
- For each open position, show:
  - quantity, average cost, current price and value;
  - unrealized P/L in $ and %;
  - share of the portfolio (allocation %);
  - the 24h change.
- Totals show value, cost basis, unrealized P/L ($/%), realized P/L and the 24h change ($/%).
- **No overselling, ever.** A sell larger than the quantity held *at that point in time* is rejected.
  "At that point in time" includes:
  - a sell dated before the buys that would cover it;
  - two sells submitted at the same moment: concurrent requests must not both succeed;
  - deleting a buy that a later sell depends on (the deletion is rejected).
- Transactions are listed newest first, with a total of quantity × price + fee.
- Numbers larger than the storage can hold are rejected with a validation error, not a server error.

### 2.4 Dashboard
- Totals across all portfolios: value, 24h change, unrealized P/L, realized P/L.
- An allocation chart by coin.
- A line chart of total portfolio value for the **last 30 days**, built from daily snapshots that the
  system records automatically (at least hourly, and once at start-up).
- A holdings table (all portfolios combined) and a per-portfolio summary list.

### 2.5 Markets
- A list of tracked coins with price, 24h change and market cap, searchable by name or symbol.
- A coin detail page with a price chart for **24H, 7D, 30D and 1Y**.
- From a coin page the user can add the coin to their watchlist, create a price alert, or record a
  trade into one of their portfolios.

### 2.6 Watchlist
- Star or unstar coins. The watchlist page shows the starred coins with price and 24h change.
- Starring an already starred coin is harmless.

### 2.7 Price alerts and notifications
- Create an alert "coin **at or above** / **at or below** target price" (target > 0), list alerts
  with their current price, and delete them.
- A background process checks active alerts about **every minute**. When the condition is met:
  - the alert fires **once**: it becomes inactive and records when it triggered;
  - an in-app **notification** is created.
  - This holds even when several background workers run at the same time.
- Notifications: a bell with the unread count (refreshed at least every 30 s), a list, "mark read"
  and "mark all read".

### 2.8 Files: import, export, reports (background jobs)
- **Export CSV** of a portfolio's transactions, **Import CSV** into a portfolio, and a **PDF report**
  of a portfolio (holdings, values, P/L, realized P/L, date).
- All three run as **background jobs**. The UI shows each job's status (queued, running, done or
  failed); a finished export or report has a download link.
- CSV format (header required; `note` optional; export and import must round-trip exactly):
  `date,type,coin_id,quantity,price_usd,fee_usd,note`. Dates are ISO 8601; a date without a timezone
  means UTC.
- Import validation:
  - A bad file fails the job with **row-specific messages**, for example
    `row 3: quantity must be a positive number`.
  - It covers bad dates, types, numbers, NaN, out-of-range values, future dates, unknown coins,
    an empty file and a wrong header.
  - An import that would oversell is rejected.
  - **Nothing is partially imported.**
  - Maximum 5,000 rows.
- Transient failures are retried a limited number of times (at most 3 attempts). Invalid input is not
  retried. A job whose worker died is picked up again.

### 2.9 Prices
- The system has a **price service** with interchangeable providers, selected by configuration:
  1. an **offline, deterministic simulated feed**, which is the **default**. It must need no internet,
     move over time (so alerts can fire), and stay near realistic levels;
  2. at least one **free real-price provider that needs no API key and has no monthly quota**
     (suitable for a classroom of 30 students);
  3. optionally, other providers.
- The same coin ids must work with every provider, so data created under one provider still works
  after switching.
- Prices are cached. When the provider fails:
  - the last known prices are served and **marked stale**, and the UI shows a "stale prices" badge;
  - with nothing cached, market endpoints report the price service as unavailable. Portfolio,
    dashboard and alert pages still load, showing missing prices as "—".
- Switching provider must never serve the previous provider's cached prices.

## 3. Architecture constraints

- **Separate services**, each in its own container and image:
  - **frontend**: a single-page web app;
  - **api**: business logic and REST API;
  - **price service**: market data, internal only;
  - **worker**: background jobs and scheduled tasks;
  - **gateway**: the single public entry point / reverse proxy.
- At least **two programming languages** across the services, so CI lessons cover different
  toolchains.
- **PostgreSQL** is the system of record.
- **Redis** is used for at least: the price cache, the **job queue** (the worker must support more than
  one running instance at a time) and rate-limit counters.
- **S3-compatible object storage** holds avatars, uploaded CSVs and generated exports.
  - Buckets are private.
  - Browsers upload and download **directly** through short-lived (≤ 15 min) **pre-signed URLs**
    that pass through the gateway.
  - Services never proxy file bytes through the API.
- **One `docker compose up`** starts everything, and **only the gateway publishes a host port**.
  Internal networks separate the public edge from the backend.
- Database migrations run in a **one-off migration container**, which seeds demo data when enabled.
  Buckets are created by a **one-off init container**. Application services wait for both to finish.
- The design must map cleanly onto GCP later. Document the mapping in the README:
  - gateway → load balancer;
  - PostgreSQL → Cloud SQL;
  - Redis → Memorystore;
  - object storage → Cloud Storage;
  - migration container → a job.

## 4. Non-functional requirements

### 4.1 Configuration and operations
- **All configuration comes from environment variables** (12-factor). Every variable is listed and
  explained in a committed `.env.example`. There are no hard-coded hosts, secrets or bucket names.
- Every long-running service exposes:
  - **liveness** (`/healthz`, no dependency checks);
  - **readiness** (`/readyz`, checks its own dependencies; 503 when not ready);
  - **Prometheus metrics** (`/metrics`, including request latency).
- Metrics are **not** reachable through the public gateway.
- The price service is a soft dependency of the api, so it must not make the api unready.
- **Structured JSON logs** on stdout. A request id is accepted from, or minted at, the gateway,
  returned in a response header, and propagated to downstream services and logs.
- Container images:
  - multi-stage builds, pinned base image versions;
  - **run as non-root**;
  - each has a **test stage** that runs lint and tests (for CI).
- **Graceful shutdown** on SIGTERM. Compose healthchecks are on every long-running service.
- The frontend image reads its runtime settings (e.g. environment name, API base URL) **at container
  start**, so one image can be promoted across environments. The UI shows the environment name.

### 4.2 Security
- Passwords are stored with a slow password hash.
- Authentication:
  - a short-lived access token (about 15 min);
  - a long-lived refresh credential in an **httpOnly, SameSite** cookie, restricted to the auth
    endpoints.
- Refresh credentials are **single-use (rotated on every refresh)** and **revoked on logout**.
- **Rate limits**:
  - login: about 10/min per client IP;
  - registration: about 10/min per client IP.
  - The client IP must be derived only from trusted proxy hops (configurable hop count), so clients
    cannot bypass limits by sending their own `X-Forwarded-For`.
- **Strict data isolation**: any access to another user's portfolio, transaction, alert, notification
  or job behaves exactly like "not found" (404). Upload keys and avatar keys are scoped to their owner.
- **Uploaded files must never be able to run as a web page on the app's origin**:
  - the content type is fixed when the upload URL is issued, and storage rejects a mismatch;
  - avatars may only be raster images;
  - storage responses through the gateway carry a restrictive Content-Security-Policy.
- Token-signing secrets must be at least 32 characters. Outside local development, the service refuses
  to start with the example placeholder secrets or with identical access and refresh secrets.
- Numeric inputs are bounded to what the database stores. Invalid ids and inputs return 400, never 500.

### 4.3 Quality
- Unit tests for the business logic: P/L math, CSV parsing, price providers, token handling.
- Integration tests against real PostgreSQL, Redis and object storage for the API and the worker.
- `make test` runs **every service's lint + tests inside containers** against throw-away
  infrastructure. It must never touch or replace the running dev stack, and it cleans up after itself.
- `make up`, `make down`, `make clean`, `make logs`, `make smoke`.
  - `make smoke` is an end-to-end smoke test through the gateway covering every tier and
    infrastructure component.
- Documentation:
  - **README**: quick start, architecture diagram, service table, what each infrastructure
    component is used for and its GCP equivalent, a configuration table, "things to try in class"
    (e.g. scale workers, stop the price service, trace a request id);
  - **architecture doc**: request flows;
  - a short doc per service.

## 5. UX expectations
- A clean, responsive UI that works at 390 px phone width and on desktop. Numbers are
  tabular/monospaced; gains are green and losses red.
- Pages:
  - login/register, with a "use demo account" helper on login;
  - dashboard;
  - portfolios and a portfolio detail page (stats, value chart, allocation, holdings, transactions,
    "add transaction" dialog);
  - markets;
  - coin detail;
  - watchlist;
  - alerts;
  - notifications;
  - import/export, with a job list that auto-refreshes while jobs are running;
  - profile.
- Errors from the API are shown to the user. For example, "Cannot sell 100 ethereum: only 3 held at
  that time" appears in the dialog.

## 6. Out of scope
CI/CD pipeline definitions, Terraform/Kubernetes manifests, TLS termination, email, OAuth/social login,
multiple fiat currencies (USD only), trading/exchange integration.

## 7. Interface contract (normative)

The automated acceptance test talks **only** to the gateway at `http://localhost:${GATEWAY_PORT:-80}`,
using the endpoints below.

### 7.1 General
- The API lives under **`/api`** on the gateway. Uploaded objects are served through the gateway on
  the same origin as the app.
- JSON everywhere. Timestamps are ISO 8601 strings. Money and quantities are JSON numbers in
  responses; requests may send decimal numbers **or decimal strings** (e.g. `"0.5"`).
- Authenticated endpoints use the header `Authorization: Bearer <accessToken>`.
- The refresh credential is an httpOnly cookie set by register, login and refresh.
- **Error body** for every non-2xx response: `{"error": {"code": "<code>", "message": "<text>"}}`.

  | Situation | Status | `code` |
  |---|---|---|
  | invalid input (incl. malformed ids, out-of-range numbers) | 400 | `validation_error` (or `bad_request`) |
  | missing, invalid or revoked auth | 401 | any |
  | wrong email/password | 401 | `invalid_credentials` |
  | not found / not yours | 404 | `not_found` |
  | duplicate (email, portfolio name) | 409 | any |
  | sell exceeds holdings / deletion would cause that | 422 | `insufficient_holdings` |
  | rate limited | 429 | `rate_limited` |
  | price service unreachable and nothing cached | 502 | `price_service_unavailable` |

### 7.2 Coin ids
The coin catalogue must include at least these ids (CoinGecko naming):

`bitcoin, ethereum, tether, binancecoin, solana, ripple, usd-coin, cardano, dogecoin, tron, avalanche-2,
polkadot, chainlink, litecoin, near, uniswap, stellar, cosmos, monero, aptos`

### 7.3 Endpoints

**Health (public):** `GET /api/healthz` → `{"status":"ok"}` · `GET /api/readyz` →
`{"status":"ready","checks":{...}}` (503 with `"not_ready"` otherwise). A public request to
`GET /metrics` must **not** return Prometheus metrics.

**Auth (public)**
- `POST /api/auth/register` `{email, password, displayName}` → **201** `{accessToken, user}`.
- `POST /api/auth/login` `{email, password}` → 200 `{accessToken, user}`.
- `POST /api/auth/refresh` (cookie) → 200 `{accessToken, user}`, plus a new cookie. The old refresh
  credential stops working.
- `POST /api/auth/logout` → 204; the refresh credential is revoked.
- `user` = `{id, email, displayName, avatarUrl, createdAt}`.

**Profile**
- `GET /api/me` → user.
- `PATCH /api/me` `{displayName}` → user.
- `POST /api/me/avatar/upload-url` `{contentType}` → `{uploadUrl, key}`.
  - `contentType` ∈ `image/png, image/jpeg, image/webp, image/gif`; anything else → 400.
  - The client then `PUT`s the bytes to `uploadUrl` with exactly that `Content-Type`; any other type
    must be rejected by storage (4xx).
- `PUT /api/me/avatar` `{key}` → user, with `avatarUrl` a download URL. A key not issued to this user
  → 400.

**Market (public)**
- `GET /api/market/coins` → `{coins:[{id, symbol, name, image|null, currentPrice, change24h,
  marketCap}], stale}`.
- `GET /api/market/prices?ids=a,b` → `{prices:{<id>:{usd, change24h}}, stale}`. Unknown ids are
  omitted.
- `GET /api/market/history/:id?days=1|7|30|365` → `{id, days, points:[[timestampMs, price], ...],
  stale}`. Other `days` → 400; unknown coin → 404.

**Portfolios**
- `GET /api/portfolios` → `{items:[{id, name, createdAt, totals}], stale}`.
- `POST /api/portfolios` `{name}` → **201** `{id, name, createdAt}`.
- `GET|PATCH|DELETE /api/portfolios/:id` (PATCH `{name}`; DELETE → 204).
- `GET /api/portfolios/:id/holdings` → `{holdings:[Holding], totals: Totals, stale}`.
  - `Holding` = `{coinId, quantity, avgCostUsd, costBasisUsd, realizedPnlUsd, priceUsd, change24hPct,
    valueUsd, unrealizedPnlUsd, unrealizedPnlPct, allocationPct}`. Price-dependent fields are
    `null` when there is no price.
  - `Totals` = `{valueUsd, costBasisUsd, unrealizedPnlUsd, unrealizedPnlPct, realizedPnlUsd,
    change24hUsd, change24hPct, missingPrices:[coinId]}`.
- `GET /api/portfolios/:id/snapshots?days=30` → `{points:[{date:"YYYY-MM-DD", valueUsd}]}`, ascending.
- `GET /api/portfolios/:id/transactions` → `{items:[Tx]}`, newest first.
  - `Tx` = `{id, portfolioId, coinId, type, quantity, priceUsd, feeUsd, totalUsd, executedAt, note}`.
- `POST /api/portfolios/:id/transactions` `{coinId, type:"buy"|"sell", quantity, priceUsd, feeUsd?,
  executedAt?, note?}` → **201** Tx.
- `DELETE /api/transactions/:id` → 204.
- `GET /api/dashboard` → `{totals, holdings, portfolios:[{id, name, totals}],
  history:[{date, valueUsd}], stale}`.

**Watchlist**
- `GET /api/watchlist` → `{items:[Coin], stale}`.
- `POST /api/watchlist` `{coinId}` → **201**.
- `DELETE /api/watchlist/:coinId` → 204.

**Alerts**
- `GET /api/alerts` → `{items:[{id, coinId, direction, targetPrice, active, triggeredAt, createdAt,
  currentPrice}], stale}`.
- `POST /api/alerts` `{coinId, direction:"above"|"below", targetPrice}` → **201** alert.
- `DELETE /api/alerts/:id` → 204.

**Notifications**
- `GET /api/notifications[?unread=true]` → `{items:[{id, title, body, readAt, createdAt}],
  unreadCount}`.
- `POST /api/notifications/:id/read` → 204.
- `POST /api/notifications/read-all` → 204.

**Files and jobs**
- `POST /api/uploads/import-url` → `{uploadUrl, key}`. The client PUTs the CSV with
  `Content-Type: text/csv`.
- `POST /api/jobs` → **202** Job. The body is one of:
  - `{type:"export_csv", params:{portfolioId}}`;
  - `{type:"report_pdf", params:{portfolioId}}`;
  - `{type:"import_csv", params:{portfolioId, key}}`.
- `GET /api/jobs` → `{items:[Job]}`, latest first.
- `GET /api/jobs/:id` → Job.
  - `Job` = `{id, type, status:"queued"|"running"|"done"|"failed", params, result, error, attempts,
    createdAt, updatedAt, downloadUrl|null}`.
  - A done import has `result.imported` = number of rows.
  - A done export or report has a `downloadUrl` (GET, no auth header) and `result.filename`.

## 8. Definition of done
- On a clean machine with Docker: `cp .env.example .env && docker compose up -d --build`. All
  long-running services become healthy, and the one-off containers exit 0.
- The demo account works in a browser at `http://localhost`, and every page in section 5 works.
- `make test` is green, `make smoke` is green, and the automated acceptance test for section 7 passes.
- `docker compose down -v && docker compose up -d` gives a clean, re-seeded stack.
- The README lets a student who has never seen the project start it and explore it in 10 minutes.
