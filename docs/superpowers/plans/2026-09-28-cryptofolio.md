# CryptoFolio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build CryptoFolio, a polyglot microservice crypto-portfolio tracker (React frontend, Node API, Python price-service and worker, Postgres/Redis/MinIO) that starts with one `docker compose up` and is used to teach infra provisioning and CI/CD.

**Architecture:** An Nginx gateway is the only public entry point and routes `/` → frontend, `/api/` → api, `/<bucket>/` → MinIO (presigned URLs). The api talks to price-service over HTTP and hands background work to the worker through a Redis Stream (`jobs`, consumer group `workers`). Postgres is the system of record, Redis is cache + queue + rate-limit store, MinIO holds avatars, CSV imports and generated exports.

**Tech Stack:** Node 22 + TypeScript + Fastify 5 + Kysely + node-pg-migrate + ioredis + fast-jwt + AWS SDK v3 + Vitest · Python 3.12 + FastAPI + httpx + redis-py + psycopg 3 + boto3 + APScheduler + reportlab + pytest + ruff · React 18 + Vite + TanStack Query + React Router + Recharts + Tailwind 4 · Postgres 16, Redis 7, MinIO, Nginx (unprivileged).

**Spec:** `docs/superpowers/specs/2026-09-28-cryptofolio-design.md`

## Global Constraints

- Base images: `node:22-alpine`, `python:3.12-slim`, `postgres:16-alpine`, `redis:7-alpine`, `nginxinc/nginx-unprivileged:1.27-alpine`, MinIO `minio/minio:RELEASE.2025-04-22T22-12-26Z` + `minio/mc:RELEASE.2025-04-16T18-13-26Z` (if a tag fails to pull, pick the nearest existing RELEASE tag and note it in the README).
- All configuration via environment variables; every variable documented in `.env.example`. No hardcoded hosts, secrets or bucket names in code.
- Every long-running service: `/healthz` (liveness), `/readyz` (checks its dependencies), Prometheus `/metrics`, JSON logs on stdout carrying the request id, multi-stage Dockerfile, runs as non-root, graceful SIGTERM shutdown.
- In `docker-compose.yml` only `gateway` publishes a host port (`${GATEWAY_PORT:-80}`).
- One-off containers: `migrate` (api image, migrations + demo seed) and `minio-init` (creates buckets); app services wait with `condition: service_completed_successfully`.
- Demo user: `demo@cryptofolio.local` / `demo1234`.
- Price cache TTLs: prices 60 s, coin list 1 h, history 10 min; last-known-good kept without TTL; stale responses carry `"stale": true`.
- Auth: JWT access token 15 min (Bearer header), refresh token 7 days in httpOnly cookie scoped to `/api/auth`; bcrypt password hashes; login rate limit 10/min per IP in Redis.
- Presigned URL TTL: 15 minutes. Buckets are private.
- Job queue: Redis Stream `jobs`, group `workers`, max 3 attempts, then status `failed`.
- Holdings use the average-cost method; selling more than held is rejected (HTTP 422 `insufficient_holdings`).
- App display name: **CryptoFolio**.

**Deliberate refinements of the spec (keep them):**
1. MinIO is exposed through the gateway at `/<bucket-name>/…` (e.g. `/cf-avatars/…`) instead of `/storage/…`. A SigV4 presigned URL signs the exact path and host. Prefix-rewriting would break signatures.
2. `jobs` gains `attempts int` and `result jsonb` (import row count, download filename).
3. Snapshots are upserted hourly (this includes the daily 00:00 UTC run), so today's point stays current.

## Review Focus

1. **Overselling:** a sell larger than the held quantity (including a sell dated before the buys, or deleting a buy that a later sell depends on, or an imported CSV that does this) must be rejected with 422 / a failed job. It must never produce negative holdings. Tests: Task 8 (unit), Task 9 (integration), Task 11 (worker unit), Task 13 (import).
2. **Cross-user access:** another user's portfolio, transaction, alert, notification, job, upload key or avatar key must return 404/400 and never leak data. Tests: Tasks 7, 9, 10, 13.
3. **Price provider down or rate-limited (CoinGecko 429):** serve last-known-good with `stale: true`. With nothing cached, return 503 (price-service) → 502 (api), and holdings/alerts still render with `null` prices instead of crashing. Tests: Tasks 3, 4, 7, 9.
4. **Bad CSV import (wrong header, bad numbers/dates, NaN, unknown coin, oversell, empty file, other user's key):** the job fails with a row-specific message and nothing is partially inserted. Tests: Task 12 (parser), Task 13 (handler + consumer).
5. **Presigned URLs from the browser:** the URL host must equal `S3_PUBLIC_ENDPOINT` and must not contain SDK checksum params (AWS SDK ≥3.729 adds `x-amz-checksum-crc32` by default, which breaks browser PUTs). The gateway must pass path and Host unchanged. Tests: Task 10 (URL shape + real PUT/GET against MinIO), Task 16 (PUT through the gateway), Task 21 (smoke test).

---

## File Structure

```
3-tier-app/
├── .gitignore  .env.example  Makefile  README.md
├── docker-compose.yml            # full stack (Task 1 infra, extended in Tasks 4, 5, 14, 15, 16)
├── docker-compose.test.yml       # test infra + test runners (Task 20)
├── scripts/test.sh               # runs every service's tests in containers (Task 20)
├── scripts/smoke.mjs             # end-to-end smoke test through the gateway (Task 21)
├── gateway/
│   ├── Dockerfile
│   └── templates/default.conf.template   # envsubst'd at start (bucket names)
├── services/
│   ├── price-service/            # Python/FastAPI
│   │   ├── Dockerfile  .dockerignore  pyproject.toml  requirements.txt  requirements-dev.txt
│   │   ├── app/{__init__,config,logging_setup,metrics,cache,main}.py
│   │   ├── app/providers/{__init__,base,mock,coingecko}.py
│   │   └── tests/{test_mock_provider,test_cache,test_coingecko,test_api}.py
│   ├── api/                      # Node/TypeScript/Fastify
│   │   ├── Dockerfile  .dockerignore  package.json  tsconfig.json  eslint.config.js
│   │   ├── vitest.config.ts  vitest.integration.config.ts
│   │   ├── migrations/1727481600000_init.sql
│   │   ├── src/{server,app,config,deps}.ts
│   │   ├── src/db/{database,migrate,seed}.ts
│   │   ├── src/lib/{errors,holdings,priceClient,storage,queue,tokens,rateLimit,validation}.ts
│   │   ├── src/plugins/{auth,metrics}.ts
│   │   ├── src/routes/{health,auth,me,portfolios,transactions,dashboard,market,watchlist,alerts,notifications,uploads,jobs}.ts
│   │   └── test/unit/*.test.ts  test/integration/{helpers.ts,*.test.ts}
│   ├── worker/                   # Python
│   │   ├── Dockerfile  .dockerignore  pyproject.toml  requirements.txt  requirements-dev.txt
│   │   ├── worker/{__init__,config,logging_setup,metrics,db,storage,prices,portfolio,csv_io,report,jobs,consumer,scheduled,health,main}.py
│   │   └── tests/{conftest,test_portfolio,test_prices,test_csv_io,test_report,test_alerts,test_health,test_consumer_integration,test_jobs_integration,test_scheduled_integration}.py
│   └── frontend/                 # React/Vite
│       ├── Dockerfile  .dockerignore  nginx.conf  docker-entrypoint.d/40-runtime-config.sh
│       ├── package.json  tsconfig.json  vite.config.ts  vitest.config.ts  eslint.config.js  index.html
│       ├── public/config.js      # dev default; overwritten in container
│       └── src/{main.tsx,App.tsx,index.css,config.ts}
│           src/lib/{api,client,format,types,upload}.ts  src/lib/{api,format}.test.ts
│           src/auth/{AuthContext,RequireAuth}.tsx  src/hooks/{portfolios,market,alerts,notifications,jobs}.ts
│           src/components/*.tsx  src/pages/*.tsx
└── docs/architecture.md  docs/services/{gateway,frontend,api,price-service,worker}.md
```

Each service is self-contained (no shared code across services). This is on purpose: each one gets its own image, pipeline and deploy target in later lessons. The avg-cost logic therefore exists in both api (TS) and worker (Python), and both copies have their own tests.

---

### Task 1: Repository skeleton and infrastructure containers

**Files:**
- Create: `.gitignore`, `.env.example`, `Makefile`, `docker-compose.yml`

**Interfaces:**
- Produces: compose services `postgres`, `redis`, `minio`, `minio-init`; networks `edge` and `backend`; volumes `pgdata`, `redisdata`, `miniodata`; every env var name used by later tasks (see `.env.example`).

- [ ] **Step 1: Create `.gitignore`**

```gitignore
node_modules/
dist/
coverage/
.env
__pycache__/
*.pyc
.pytest_cache/
.ruff_cache/
.venv/
.DS_Store
```

- [ ] **Step 2: Create `.env.example`**

```dotenv
# ============================================================
# CryptoFolio configuration. Copy to .env:  cp .env.example .env
# Every service reads ONLY environment variables (12-factor).
# ============================================================

# ---- General ----
COMPOSE_PROJECT_NAME=cryptofolio
# Image names: CI pushes <IMAGE_REGISTRY>/<service>:<IMAGE_TAG>
# (e.g. europe-docker.pkg.dev/<project>/cryptofolio and a git SHA)
IMAGE_REGISTRY=cryptofolio
IMAGE_TAG=local
APP_ENV=local
LOG_LEVEL=info
# Host port of the gateway (the only published port).
GATEWAY_PORT=80

# ---- Postgres ----
POSTGRES_USER=cryptofolio
POSTGRES_PASSWORD=cryptofolio
POSTGRES_DB=cryptofolio
DATABASE_URL=postgres://cryptofolio:cryptofolio@postgres:5432/cryptofolio

# ---- Redis ----
REDIS_URL=redis://redis:6379/0

# ---- Object storage (MinIO locally; GCS via S3 interoperability later) ----
S3_ENDPOINT=http://minio:9000
# URL the BROWSER uses for presigned links. Must match how users reach the gateway
# (include the port if GATEWAY_PORT is not 80, e.g. http://localhost:8080).
S3_PUBLIC_ENDPOINT=http://localhost
S3_REGION=us-east-1
S3_ACCESS_KEY=cryptofolio
S3_SECRET_KEY=cryptofolio-secret
S3_BUCKET_AVATARS=cf-avatars
S3_BUCKET_IMPORTS=cf-imports
S3_BUCKET_EXPORTS=cf-exports

# ---- api ----
JWT_ACCESS_SECRET=change-me-access-secret
JWT_REFRESH_SECRET=change-me-refresh-secret
COOKIE_SECURE=false
PRICE_SERVICE_URL=http://price-service:8000
LOGIN_RATE_LIMIT_PER_MINUTE=10
JOBS_STREAM=jobs
# migrate container: insert demo user + sample data
SEED_DEMO_DATA=true

# ---- price-service ----
# mock = offline deterministic prices (classroom default); coingecko = real prices
PRICE_PROVIDER=mock
COINGECKO_BASE_URL=https://api.coingecko.com/api/v3
COINGECKO_API_KEY=

# ---- worker ----
ALERT_CHECK_INTERVAL_SECONDS=60
```

- [ ] **Step 3: Create `docker-compose.yml` (infra only for now)**

```yaml
name: ${COMPOSE_PROJECT_NAME:-cryptofolio}

x-logging: &default-logging
  driver: json-file
  options: { max-size: "10m", max-file: "3" }

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes: [pgdata:/var/lib/postgresql/data]
    networks: [backend]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 20
    logging: *default-logging
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes: [redisdata:/data]
    networks: [backend]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 20
    logging: *default-logging
    restart: unless-stopped

  minio:
    image: minio/minio:RELEASE.2025-04-22T22-12-26Z
    command: ["server", "/data", "--console-address", ":9001"]
    environment:
      MINIO_ROOT_USER: ${S3_ACCESS_KEY}
      MINIO_ROOT_PASSWORD: ${S3_SECRET_KEY}
    volumes: [miniodata:/data]
    networks: [edge, backend]
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 3s
      retries: 20
    logging: *default-logging
    restart: unless-stopped

  minio-init:
    image: minio/mc:RELEASE.2025-04-16T18-13-26Z
    depends_on:
      minio: { condition: service_healthy }
    networks: [backend]
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
        set -e
        mc alias set local http://minio:9000 ${S3_ACCESS_KEY} ${S3_SECRET_KEY}
        for b in ${S3_BUCKET_AVATARS} ${S3_BUCKET_IMPORTS} ${S3_BUCKET_EXPORTS}; do
          mc mb --ignore-existing local/$$b
          mc anonymous set none local/$$b
        done
        echo "buckets ready"
    restart: "no"

networks:
  edge: {}
  backend: {}

volumes:
  pgdata: {}
  redisdata: {}
  miniodata: {}
```

- [ ] **Step 4: Create `Makefile`**

```makefile
COMPOSE ?= docker compose

.PHONY: env up down clean ps logs test lint

env:            ## create .env from the example if missing
	@test -f .env || cp .env.example .env

up: env         ## build and start the whole stack
	$(COMPOSE) up -d --build

down:           ## stop the stack (keep data)
	$(COMPOSE) down

clean:          ## stop the stack and delete all data volumes
	$(COMPOSE) down -v --remove-orphans

ps:
	$(COMPOSE) ps -a

logs:           ## follow logs, e.g. make logs s=api
	$(COMPOSE) logs -f $(s)

test:           ## run every service's lint + unit + integration tests in containers
	./scripts/test.sh
```

- [ ] **Step 5: Verify infra comes up**

Run: `cp .env.example .env && docker compose up -d && sleep 15 && docker compose ps -a`
Expected: `postgres`, `redis`, `minio` are `healthy`; `minio-init` is `Exited (0)`; `docker compose logs minio-init` ends with `buckets ready`. If `mc ready local` is unavailable in the pinned image, switch the minio healthcheck to `["CMD-SHELL", "curl -fs http://localhost:9000/minio/health/live || exit 1"]` and re-run.

- [ ] **Step 6: Commit**

```bash
git add .gitignore .env.example Makefile docker-compose.yml
git commit -m "chore: repo skeleton with postgres, redis, minio compose services"
```

---
### Task 2: price-service scaffold and mock price provider

**Files:**
- Create: `services/price-service/{Dockerfile,.dockerignore,pyproject.toml,requirements.txt,requirements-dev.txt}`
- Create: `services/price-service/app/{__init__.py,config.py,logging_setup.py}`
- Create: `services/price-service/app/providers/{__init__.py,base.py,mock.py}`
- Test: `services/price-service/tests/test_mock_provider.py` (plus empty `tests/__init__.py`)

**Interfaces:**
- Produces: `Coin`, `Quote` dataclasses; `ProviderError`, `UnknownCoinError`; `HISTORY_DAYS = (1, 7, 30, 365)`; `PriceProvider` protocol with `list_coins() -> list[Coin]`, `get_prices(ids: list[str]) -> dict[str, Quote]` (unknown ids omitted), `get_history(coin_id: str, days: int) -> list[tuple[int, float]]` (ms timestamps, ascending; raises `UnknownCoinError`); `MockProvider(clock=time.time)`; `MOCK_COINS`; `Settings`; `setup_logging(level)`.

Tests run inside Docker (no local Python toolchain needed):
`docker build -q --target test -t cf-price-test services/price-service && docker run --rm cf-price-test pytest -q <path>`

- [ ] **Step 1: Create packaging files**

`services/price-service/requirements.txt`
```
fastapi==0.115.12
uvicorn[standard]==0.34.2
httpx==0.28.1
redis==5.2.1
pydantic-settings==2.9.1
prometheus-client==0.21.1
```

`services/price-service/requirements-dev.txt`
```
-r requirements.txt
pytest==8.3.5
fakeredis==2.28.1
ruff==0.11.8
```

`services/price-service/pyproject.toml`
```toml
[project]
name = "price-service"
version = "1.0.0"
requires-python = ">=3.12"

[tool.pytest.ini_options]
pythonpath = ["."]
testpaths = ["tests"]

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]
```

`services/price-service/.dockerignore`
```
.venv
__pycache__
.pytest_cache
.ruff_cache
```

`services/price-service/Dockerfile`
```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
RUN useradd --create-home --uid 10001 app

FROM base AS deps
COPY requirements.txt .
RUN pip install -r requirements.txt

# `docker build --target test` -> image that runs lint + tests (used by CI)
FROM deps AS test
COPY requirements-dev.txt .
RUN pip install -r requirements-dev.txt
COPY . .
CMD ["sh", "-c", "ruff check . && pytest -q"]

FROM deps AS runtime
COPY app ./app
USER app
EXPOSE 8000
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
```

- [ ] **Step 2: Create config and logging**

`services/price-service/app/__init__.py`: empty file.

`services/price-service/app/config.py`
```python
from typing import Literal

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """All configuration comes from environment variables (e.g. PRICE_PROVIDER)."""

    price_provider: Literal["mock", "coingecko"] = "mock"
    coingecko_base_url: str = "https://api.coingecko.com/api/v3"
    coingecko_api_key: str = ""
    redis_url: str = "redis://localhost:6379/0"
    log_level: str = "info"
    prices_ttl_seconds: int = 60
```

`services/price-service/app/logging_setup.py`
```python
import json
import logging
import sys
from datetime import UTC, datetime

EXTRA_FIELDS = ("request_id", "method", "path", "status", "duration_ms", "provider")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname.lower(),
            "service": "price-service",
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key in EXTRA_FIELDS:
            if hasattr(record, key):
                payload[key] = getattr(record, key)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload)


def setup_logging(level: str) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
```

- [ ] **Step 3: Create provider base types**

`services/price-service/app/providers/__init__.py`: empty file.

`services/price-service/app/providers/base.py`
```python
from dataclasses import dataclass
from typing import Protocol

HISTORY_DAYS = (1, 7, 30, 365)


@dataclass(frozen=True)
class Coin:
    id: str
    symbol: str
    name: str
    image: str | None
    current_price: float
    change_24h: float
    market_cap: float


@dataclass(frozen=True)
class Quote:
    usd: float
    change_24h: float


class ProviderError(Exception):
    """Upstream is unreachable, rate-limited or returned garbage."""


class UnknownCoinError(Exception):
    """The provider does not know this coin id."""


class PriceProvider(Protocol):
    def list_coins(self) -> list[Coin]: ...

    def get_prices(self, ids: list[str]) -> dict[str, Quote]: ...

    def get_history(self, coin_id: str, days: int) -> list[tuple[int, float]]: ...
```

- [ ] **Step 4: Write the failing mock-provider tests**

`services/price-service/tests/__init__.py`: empty file.

`services/price-service/tests/test_mock_provider.py`
```python
import pytest

from app.providers.base import UnknownCoinError
from app.providers.mock import MOCK_COINS, MockProvider

NOW = 1_760_000_000.0


def provider(ts: float = NOW) -> MockProvider:
    return MockProvider(clock=lambda: ts)


def test_prices_are_deterministic_for_same_timestamp():
    assert provider().get_prices(["bitcoin"]) == provider().get_prices(["bitcoin"])


def test_prices_move_over_time():
    a = provider(NOW).get_prices(["bitcoin"])["bitcoin"].usd
    b = provider(NOW + 5 * 3600).get_prices(["bitcoin"])["bitcoin"].usd
    assert a != b


def test_prices_stay_within_band_of_base_price():
    for coin_id, _symbol, _name, base, _supply in MOCK_COINS:
        for k in range(60):
            usd = provider(NOW + k * 7919).get_prices([coin_id])[coin_id].usd
            assert 0.85 * base <= usd <= 1.15 * base


def test_unknown_ids_are_omitted():
    assert set(provider().get_prices(["bitcoin", "not-a-coin"])) == {"bitcoin"}


def test_change_24h_matches_price_24h_ago():
    quote = provider(NOW).get_prices(["ethereum"])["ethereum"]
    previous = provider(NOW - 86400).get_prices(["ethereum"])["ethereum"].usd
    assert quote.change_24h == pytest.approx((quote.usd - previous) / previous * 100, abs=0.01)


def test_list_coins_sorted_by_market_cap():
    coins = provider().list_coins()
    caps = [c.market_cap for c in coins]
    assert len(coins) == len(MOCK_COINS) == 20
    assert caps == sorted(caps, reverse=True)
    assert coins[0].id == "bitcoin"


@pytest.mark.parametrize("days,expected", [(1, 288), (7, 168), (30, 180), (365, 365)])
def test_history_point_counts_and_order(days, expected):
    points = provider().get_history("bitcoin", days)
    assert expected <= len(points) <= expected + 2
    timestamps = [ts for ts, _ in points]
    assert timestamps == sorted(timestamps)
    assert timestamps[-1] == int(NOW * 1000)


def test_history_unknown_coin():
    with pytest.raises(UnknownCoinError):
        provider().get_history("not-a-coin", 7)


def test_history_rejects_unsupported_days():
    with pytest.raises(ValueError):
        provider().get_history("bitcoin", 2)
```

- [ ] **Step 5: Run to verify failure**

Run: `docker build -q --target test -t cf-price-test services/price-service && docker run --rm cf-price-test pytest -q tests/test_mock_provider.py`
Expected: FAIL / collection error `ModuleNotFoundError: No module named 'app.providers.mock'`

- [ ] **Step 6: Implement the mock provider**

`services/price-service/app/providers/mock.py`
```python
"""Deterministic, offline price feed for classrooms.

Price is a pure function of (coin id, timestamp): a sum of sine waves with a
per-coin phase. Same inputs -> same output, prices move minute to minute (so
alerts can trigger) and never drift more than ~12% from the base price.
"""

import hashlib
import math
import time
from collections.abc import Callable

from .base import Coin, Quote, UnknownCoinError

DAY = 86400

# id, symbol, name, base price (USD), circulating supply
MOCK_COINS: list[tuple[str, str, str, float, float]] = [
    ("bitcoin", "btc", "Bitcoin", 65000.0, 19.7e6),
    ("ethereum", "eth", "Ethereum", 3200.0, 120e6),
    ("tether", "usdt", "Tether", 1.0, 110e9),
    ("binancecoin", "bnb", "BNB", 580.0, 146e6),
    ("solana", "sol", "Solana", 150.0, 460e6),
    ("ripple", "xrp", "XRP", 0.52, 55e9),
    ("usd-coin", "usdc", "USDC", 1.0, 33e9),
    ("cardano", "ada", "Cardano", 0.45, 35e9),
    ("dogecoin", "doge", "Dogecoin", 0.15, 145e9),
    ("tron", "trx", "TRON", 0.12, 87e9),
    ("avalanche-2", "avax", "Avalanche", 35.0, 400e6),
    ("polkadot", "dot", "Polkadot", 7.0, 1.4e9),
    ("chainlink", "link", "Chainlink", 15.0, 600e6),
    ("litecoin", "ltc", "Litecoin", 80.0, 75e6),
    ("near", "near", "NEAR Protocol", 5.5, 1.1e9),
    ("uniswap", "uni", "Uniswap", 9.0, 600e6),
    ("stellar", "xlm", "Stellar", 0.11, 29e9),
    ("cosmos", "atom", "Cosmos Hub", 8.0, 390e6),
    ("monero", "xmr", "Monero", 160.0, 18e6),
    ("aptos", "apt", "Aptos", 9.0, 450e6),
]
STABLECOINS = {"tether", "usd-coin"}
HISTORY_STEP_SECONDS = {1: 300, 7: 3600, 30: 14400, 365: DAY}


def _phase(coin_id: str) -> float:
    digest = hashlib.sha256(coin_id.encode()).digest()
    return int.from_bytes(digest[:4], "big") / 2**32 * 2 * math.pi


def price_at(coin_id: str, base: float, ts: float) -> float:
    p = _phase(coin_id)
    if coin_id in STABLECOINS:
        return round(base * (1 + 0.001 * math.sin(ts / 3600 + p)), 6)
    wave = (
        0.08 * math.sin(2 * math.pi * ts / (7 * DAY) + p)
        + 0.03 * math.sin(2 * math.pi * ts / DAY + 2 * p)
        + 0.01 * math.sin(2 * math.pi * ts / 3600 + 3 * p)
        + 0.004 * math.sin(2 * math.pi * ts / 300 + 5 * p)
    )
    return round(base * (1 + wave), 6 if base < 1 else 2)


class MockProvider:
    def __init__(self, clock: Callable[[], float] = time.time):
        self._clock = clock
        self._coins = {c[0]: c for c in MOCK_COINS}

    def _quote(self, coin_id: str, now: float) -> Quote:
        base = self._coins[coin_id][3]
        current = price_at(coin_id, base, now)
        previous = price_at(coin_id, base, now - DAY)
        return Quote(usd=current, change_24h=round((current - previous) / previous * 100, 2))

    def list_coins(self) -> list[Coin]:
        now = self._clock()
        coins = []
        for coin_id, symbol, name, _base, supply in MOCK_COINS:
            quote = self._quote(coin_id, now)
            coins.append(
                Coin(
                    id=coin_id,
                    symbol=symbol,
                    name=name,
                    image=None,
                    current_price=quote.usd,
                    change_24h=quote.change_24h,
                    market_cap=round(quote.usd * supply),
                )
            )
        return sorted(coins, key=lambda c: c.market_cap, reverse=True)

    def get_prices(self, ids: list[str]) -> dict[str, Quote]:
        now = self._clock()
        return {i: self._quote(i, now) for i in ids if i in self._coins}

    def get_history(self, coin_id: str, days: int) -> list[tuple[int, float]]:
        if coin_id not in self._coins:
            raise UnknownCoinError(coin_id)
        if days not in HISTORY_STEP_SECONDS:
            raise ValueError(f"unsupported days: {days}")
        base = self._coins[coin_id][3]
        now = self._clock()
        step = HISTORY_STEP_SECONDS[days]
        end = int(now // step * step)
        count = days * DAY // step
        points = [
            (int((end - k * step) * 1000), price_at(coin_id, base, end - k * step))
            for k in range(count, -1, -1)
        ]
        if now > end:
            points.append((int(now * 1000), price_at(coin_id, base, now)))
        return points
```

- [ ] **Step 7: Run tests and lint**

Run: `docker build -q --target test -t cf-price-test services/price-service && docker run --rm cf-price-test`
Expected: `ruff check` prints `All checks passed!`, pytest shows all `test_mock_provider.py` tests PASS.

- [ ] **Step 8: Commit**

```bash
git add services/price-service
git commit -m "feat(price-service): scaffold and deterministic mock price provider"
```

---

### Task 3: price-service cache with last-known-good fallback

**Files:**
- Create: `services/price-service/app/metrics.py`, `services/price-service/app/cache.py`
- Test: `services/price-service/tests/test_cache.py`

**Interfaces:**
- Consumes: `Coin`, `Quote`, `ProviderError`, `UnknownCoinError`, `PriceProvider` (Task 2).
- Produces: `PriceService(provider, redis, prices_ttl=60, coins_ttl=3600, history_ttl=600)` with `coins() -> tuple[list[Coin], bool]`, `prices(ids) -> tuple[dict[str, Quote], bool]`, `history(coin_id, days) -> tuple[list[list[float]], bool]` (bool = stale). Raises `ProviderError` only when nothing is cached. Redis keys: `cache:price:<id>`, `cache:coins`, `cache:history:<id>:<days>` (TTL) and the same with `lkg:` prefix (no TTL). Metrics `REQUESTS`, `CACHE_EVENTS`, `UPSTREAM_ERRORS`.

- [ ] **Step 1: Write the failing tests**

`services/price-service/tests/test_cache.py`
```python
import fakeredis
import pytest

from app.cache import PriceService
from app.providers.base import Coin, ProviderError, Quote, UnknownCoinError


class FakeProvider:
    def __init__(self):
        self.fail = False
        self.requested: list[list[str]] = []
        self.quotes = {"bitcoin": Quote(50000.0, 1.5), "ethereum": Quote(3000.0, -2.0)}

    def _maybe_fail(self):
        if self.fail:
            raise ProviderError("upstream down")

    def list_coins(self):
        self._maybe_fail()
        return [Coin("bitcoin", "btc", "Bitcoin", None, 50000.0, 1.5, 1e12)]

    def get_prices(self, ids):
        self._maybe_fail()
        self.requested.append(list(ids))
        return {i: self.quotes[i] for i in ids if i in self.quotes}

    def get_history(self, coin_id, days):
        self._maybe_fail()
        if coin_id != "bitcoin":
            raise UnknownCoinError(coin_id)
        return [(1000, 1.0), (2000, 2.0)]


@pytest.fixture
def redis():
    return fakeredis.FakeRedis(decode_responses=True)


@pytest.fixture
def provider():
    return FakeProvider()


@pytest.fixture
def service(provider, redis):
    return PriceService(provider, redis)


def test_prices_second_call_is_served_from_cache(service, provider):
    service.prices(["bitcoin"])
    quotes, stale = service.prices(["bitcoin"])
    assert quotes == {"bitcoin": Quote(50000.0, 1.5)}
    assert stale is False
    assert provider.requested == [["bitcoin"]]


def test_prices_only_fetches_missing_ids(service, provider):
    service.prices(["bitcoin"])
    service.prices(["bitcoin", "ethereum"])
    assert provider.requested == [["bitcoin"], ["ethereum"]]


def test_prices_cache_entries_expire(service, redis):
    service.prices(["bitcoin"])
    assert 0 < redis.ttl("cache:price:bitcoin") <= 60
    assert redis.ttl("lkg:price:bitcoin") == -1


def test_prices_serve_last_known_good_when_provider_down(service, provider, redis):
    service.prices(["bitcoin"])
    redis.delete("cache:price:bitcoin")
    provider.fail = True
    quotes, stale = service.prices(["bitcoin"])
    assert quotes["bitcoin"].usd == 50000.0
    assert stale is True


def test_prices_raise_when_provider_down_and_nothing_cached(service, provider):
    provider.fail = True
    with pytest.raises(ProviderError):
        service.prices(["bitcoin"])


def test_unknown_ids_are_not_returned(service):
    quotes, _ = service.prices(["bitcoin", "nope"])
    assert set(quotes) == {"bitcoin"}


def test_coins_fall_back_to_last_known_good(service, provider, redis):
    service.coins()
    redis.delete("cache:coins")
    provider.fail = True
    coins, stale = service.coins()
    assert coins[0].id == "bitcoin"
    assert stale is True


def test_history_is_cached(service, redis):
    points, stale = service.history("bitcoin", 7)
    assert points == [[1000, 1.0], [2000, 2.0]]
    assert stale is False
    assert redis.exists("cache:history:bitcoin:7")


def test_history_unknown_coin_propagates(service):
    with pytest.raises(UnknownCoinError):
        service.history("nope", 7)
```

- [ ] **Step 2: Run to verify failure**

Run: `docker build -q --target test -t cf-price-test services/price-service && docker run --rm cf-price-test pytest -q tests/test_cache.py`
Expected: FAIL `ModuleNotFoundError: No module named 'app.cache'`

- [ ] **Step 3: Implement metrics and cache**

`services/price-service/app/metrics.py`
```python
from prometheus_client import Counter, Histogram

REQUESTS = Histogram(
    "http_request_duration_seconds", "HTTP request latency", ["method", "route", "status"]
)
CACHE_EVENTS = Counter("price_cache_events_total", "Price cache lookups by outcome", ["outcome"])
UPSTREAM_ERRORS = Counter(
    "price_upstream_errors_total", "Failed calls to the price provider", ["provider"]
)
```

`services/price-service/app/cache.py`
```python
"""Read-through Redis cache in front of a PriceProvider.

Every successful fetch is stored twice:
  cache:<key>  with a TTL  -> normal cache
  lkg:<key>    no TTL      -> "last known good", served (stale=True) if the provider fails
"""

import json
from collections.abc import Callable
from dataclasses import asdict
from typing import Any

from redis import Redis

from .metrics import CACHE_EVENTS
from .providers.base import Coin, PriceProvider, ProviderError, Quote


class PriceService:
    def __init__(
        self,
        provider: PriceProvider,
        redis: Redis,
        prices_ttl: int = 60,
        coins_ttl: int = 3600,
        history_ttl: int = 600,
    ):
        self._provider = provider
        self._redis = redis
        self._prices_ttl = prices_ttl
        self._coins_ttl = coins_ttl
        self._history_ttl = history_ttl

    def coins(self) -> tuple[list[Coin], bool]:
        raw, stale = self._cached(
            "coins", self._coins_ttl, lambda: [asdict(c) for c in self._provider.list_coins()]
        )
        return [Coin(**c) for c in raw], stale

    def history(self, coin_id: str, days: int) -> tuple[list[list[float]], bool]:
        return self._cached(
            f"history:{coin_id}:{days}",
            self._history_ttl,
            lambda: [[ts, price] for ts, price in self._provider.get_history(coin_id, days)],
        )

    def prices(self, ids: list[str]) -> tuple[dict[str, Quote], bool]:
        ids = sorted(set(ids))
        result: dict[str, Quote] = {}
        missing: list[str] = []
        for coin_id, raw in zip(ids, self._redis.mget([f"cache:price:{i}" for i in ids])):
            if raw is None:
                missing.append(coin_id)
            else:
                result[coin_id] = Quote(**json.loads(raw))
        CACHE_EVENTS.labels("hit").inc(len(result))
        if not missing:
            return result, False

        CACHE_EVENTS.labels("miss").inc(len(missing))
        try:
            fetched = self._provider.get_prices(missing)
        except ProviderError:
            stale_raw = self._redis.mget([f"lkg:price:{i}" for i in missing])
            for coin_id, raw in zip(missing, stale_raw):
                if raw is not None:
                    result[coin_id] = Quote(**json.loads(raw))
            if not result:
                raise
            CACHE_EVENTS.labels("stale").inc()
            return result, True

        pipe = self._redis.pipeline()
        for coin_id, quote in fetched.items():
            encoded = json.dumps(asdict(quote))
            pipe.set(f"cache:price:{coin_id}", encoded, ex=self._prices_ttl)
            pipe.set(f"lkg:price:{coin_id}", encoded)
        pipe.execute()
        result.update(fetched)
        return result, False

    def _cached(self, key: str, ttl: int, fetch: Callable[[], Any]) -> tuple[Any, bool]:
        cached = self._redis.get(f"cache:{key}")
        if cached is not None:
            CACHE_EVENTS.labels("hit").inc()
            return json.loads(cached), False
        CACHE_EVENTS.labels("miss").inc()
        try:
            data = fetch()
        except ProviderError:
            last_known_good = self._redis.get(f"lkg:{key}")
            if last_known_good is None:
                raise
            CACHE_EVENTS.labels("stale").inc()
            return json.loads(last_known_good), True
        encoded = json.dumps(data)
        pipe = self._redis.pipeline()
        pipe.set(f"cache:{key}", encoded, ex=ttl)
        pipe.set(f"lkg:{key}", encoded)
        pipe.execute()
        return data, False
```

- [ ] **Step 4: Run tests**

Run: `docker build -q --target test -t cf-price-test services/price-service && docker run --rm cf-price-test`
Expected: ruff clean, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add services/price-service
git commit -m "feat(price-service): redis read-through cache with last-known-good fallback"
```

---

### Task 4: CoinGecko provider, HTTP API, compose service

**Files:**
- Create: `services/price-service/app/providers/coingecko.py`, `services/price-service/app/main.py`
- Modify: `docker-compose.yml` (add `price-service`)
- Test: `services/price-service/tests/test_coingecko.py`, `services/price-service/tests/test_api.py`

**Interfaces:**
- Consumes: `PriceService` (Task 3), `MockProvider` (Task 2), `Settings`, `setup_logging`.
- Produces (HTTP, internal port 8000; the api in Task 8 relies on these exact shapes):
  - `GET /coins` → `{"coins":[{"id","symbol","name","image","current_price","change_24h","market_cap"}],"stale":bool}`
  - `GET /prices?ids=a,b` → `{"prices":{"<id>":{"usd":float,"change_24h":float}},"stale":bool}`. 400 if 0 or >100 ids. Unknown ids omitted.
  - `GET /history/{id}?days=1|7|30|365` → `{"id","days","points":[[ts_ms,price],...],"stale":bool}`; 400 bad days; 404 unknown coin
  - Provider failure with nothing cached → 503 `{"detail":"price provider unavailable"}`
  - `GET /healthz`, `GET /readyz` (Redis ping; 503 when down), `GET /metrics`
  - `create_app(settings=None, redis=None, service=None) -> FastAPI` (uvicorn `--factory`).

- [ ] **Step 1: Write failing CoinGecko tests**

`services/price-service/tests/test_coingecko.py`
```python
import httpx
import pytest

from app.providers.base import ProviderError, Quote, UnknownCoinError
from app.providers.coingecko import CoinGeckoProvider


def make(handler) -> CoinGeckoProvider:
    return CoinGeckoProvider(
        "https://cg.test/api/v3", api_key="demo-key", transport=httpx.MockTransport(handler)
    )


def test_get_prices_parses_response_and_sends_api_key():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("x-cg-demo-api-key")
        return httpx.Response(200, json={"bitcoin": {"usd": 65000.5, "usd_24h_change": 1.234}})

    assert make(handler).get_prices(["bitcoin"]) == {"bitcoin": Quote(65000.5, 1.23)}
    assert seen["key"] == "demo-key"
    assert seen["url"].startswith("https://cg.test/api/v3/simple/price")
    assert "ids=bitcoin" in seen["url"]


def test_get_prices_with_no_ids_does_not_call_upstream():
    def handler(request):
        raise AssertionError("should not be called")

    assert make(handler).get_prices([]) == {}


def test_rate_limit_becomes_provider_error():
    with pytest.raises(ProviderError):
        make(lambda r: httpx.Response(429, json={"error": "rate limited"})).get_prices(["bitcoin"])


def test_network_error_becomes_provider_error():
    def handler(request):
        raise httpx.ConnectError("boom", request=request)

    with pytest.raises(ProviderError):
        make(handler).list_coins()


def test_invalid_json_becomes_provider_error():
    with pytest.raises(ProviderError):
        make(lambda r: httpx.Response(200, text="<html>")).list_coins()


def test_history_404_is_unknown_coin():
    with pytest.raises(UnknownCoinError):
        make(lambda r: httpx.Response(404, json={"error": "coin not found"})).get_history("x", 7)


def test_history_parses_points():
    body = {"prices": [[1000, 1.5], [2000, 2.5]]}
    assert make(lambda r: httpx.Response(200, json=body)).get_history("bitcoin", 7) == [
        (1000, 1.5),
        (2000, 2.5),
    ]


def test_list_coins_tolerates_null_fields():
    body = [
        {
            "id": "newcoin",
            "symbol": "new",
            "name": "New Coin",
            "image": None,
            "current_price": None,
            "price_change_percentage_24h": None,
            "market_cap": None,
        }
    ]
    coin = make(lambda r: httpx.Response(200, json=body)).list_coins()[0]
    assert (coin.current_price, coin.change_24h, coin.market_cap) == (0.0, 0.0, 0.0)
```

- [ ] **Step 2: Write failing API tests**

`services/price-service/tests/test_api.py`
```python
import fakeredis
import pytest
from fastapi.testclient import TestClient

from app.cache import PriceService
from app.config import Settings
from app.main import create_app
from app.providers.base import ProviderError
from app.providers.mock import MockProvider

NOW = 1_760_000_000.0


class DownProvider:
    def list_coins(self):
        raise ProviderError("down")

    def get_prices(self, ids):
        raise ProviderError("down")

    def get_history(self, coin_id, days):
        raise ProviderError("down")


def client_for(provider) -> TestClient:
    redis = fakeredis.FakeRedis(decode_responses=True)
    service = PriceService(provider, redis)
    return TestClient(create_app(settings=Settings(), redis=redis, service=service))


@pytest.fixture
def client() -> TestClient:
    return client_for(MockProvider(clock=lambda: NOW))


def test_health_and_ready(client):
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/readyz").status_code == 200


def test_metrics_exposed(client):
    client.get("/coins")
    body = client.get("/metrics").text
    assert "http_request_duration_seconds" in body
    assert "price_cache_events_total" in body


def test_coins(client):
    body = client.get("/coins").json()
    assert len(body["coins"]) == 20
    assert set(body["coins"][0]) == {
        "id", "symbol", "name", "image", "current_price", "change_24h", "market_cap"
    }
    assert body["stale"] is False


def test_prices(client):
    body = client.get("/prices", params={"ids": "bitcoin,ethereum,nope"}).json()
    assert set(body["prices"]) == {"bitcoin", "ethereum"}
    assert set(body["prices"]["bitcoin"]) == {"usd", "change_24h"}


def test_prices_requires_ids(client):
    assert client.get("/prices", params={"ids": ","}).status_code == 400
    assert client.get("/prices").status_code == 422


def test_prices_rejects_more_than_100_ids(client):
    ids = ",".join(f"c{i}" for i in range(101))
    assert client.get("/prices", params={"ids": ids}).status_code == 400


def test_history(client):
    body = client.get("/history/bitcoin", params={"days": 7}).json()
    assert body["id"] == "bitcoin" and body["days"] == 7 and len(body["points"]) >= 168


def test_history_rejects_bad_days(client):
    assert client.get("/history/bitcoin", params={"days": 2}).status_code == 400


def test_history_unknown_coin(client):
    assert client.get("/history/not-a-coin").status_code == 404


def test_provider_down_with_empty_cache_is_503():
    response = client_for(DownProvider()).get("/prices", params={"ids": "bitcoin"})
    assert response.status_code == 503
    assert response.json() == {"detail": "price provider unavailable"}
```

- [ ] **Step 3: Run to verify failure**

Run: `docker build -q --target test -t cf-price-test services/price-service && docker run --rm cf-price-test pytest -q tests/test_coingecko.py tests/test_api.py`
Expected: FAIL `ModuleNotFoundError` for `app.providers.coingecko` / `app.main`.

- [ ] **Step 4: Implement the CoinGecko provider**

`services/price-service/app/providers/coingecko.py`
```python
from typing import Any

import httpx

from ..metrics import UPSTREAM_ERRORS
from .base import Coin, ProviderError, Quote, UnknownCoinError


class CoinGeckoProvider:
    """Real prices from the CoinGecko public API (free "demo" key optional)."""

    def __init__(
        self,
        base_url: str,
        api_key: str = "",
        transport: httpx.BaseTransport | None = None,
        timeout: float = 10.0,
    ):
        headers = {"accept": "application/json"}
        if api_key:
            headers["x-cg-demo-api-key"] = api_key
        self._client = httpx.Client(
            base_url=base_url, headers=headers, timeout=timeout, transport=transport
        )

    def _get(self, path: str, params: dict[str, Any]) -> Any:
        try:
            response = self._client.get(path, params=params)
        except httpx.HTTPError as exc:
            UPSTREAM_ERRORS.labels("coingecko").inc()
            raise ProviderError(f"coingecko unreachable: {exc}") from exc
        if response.status_code == 404:
            raise UnknownCoinError(path)
        if response.status_code >= 400:
            UPSTREAM_ERRORS.labels("coingecko").inc()
            raise ProviderError(f"coingecko returned HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            UPSTREAM_ERRORS.labels("coingecko").inc()
            raise ProviderError("coingecko returned invalid JSON") from exc

    def list_coins(self) -> list[Coin]:
        data = self._get(
            "/coins/markets",
            {"vs_currency": "usd", "order": "market_cap_desc", "per_page": 100, "page": 1},
        )
        return [
            Coin(
                id=c["id"],
                symbol=c["symbol"],
                name=c["name"],
                image=c.get("image"),
                current_price=float(c.get("current_price") or 0),
                change_24h=round(float(c.get("price_change_percentage_24h") or 0), 2),
                market_cap=float(c.get("market_cap") or 0),
            )
            for c in data
        ]

    def get_prices(self, ids: list[str]) -> dict[str, Quote]:
        if not ids:
            return {}
        data = self._get(
            "/simple/price",
            {"ids": ",".join(ids), "vs_currencies": "usd", "include_24hr_change": "true"},
        )
        return {
            coin_id: Quote(
                usd=float(values["usd"]),
                change_24h=round(float(values.get("usd_24h_change") or 0), 2),
            )
            for coin_id, values in data.items()
            if "usd" in values
        }

    def get_history(self, coin_id: str, days: int) -> list[tuple[int, float]]:
        data = self._get(f"/coins/{coin_id}/market_chart", {"vs_currency": "usd", "days": days})
        return [(int(ts), float(price)) for ts, price in data["prices"]]
```

- [ ] **Step 5: Implement the FastAPI app**

`services/price-service/app/main.py`
```python
import logging
import time
import uuid
from dataclasses import asdict

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from redis import Redis

from .cache import PriceService
from .config import Settings
from .logging_setup import setup_logging
from .metrics import REQUESTS
from .providers.base import HISTORY_DAYS, ProviderError, UnknownCoinError
from .providers.coingecko import CoinGeckoProvider
from .providers.mock import MockProvider

log = logging.getLogger("price-service")
QUIET_PATHS = {"/healthz", "/readyz", "/metrics"}


def build_service(settings: Settings, redis: Redis) -> PriceService:
    if settings.price_provider == "coingecko":
        provider = CoinGeckoProvider(settings.coingecko_base_url, settings.coingecko_api_key)
    else:
        provider = MockProvider()
    return PriceService(provider, redis, prices_ttl=settings.prices_ttl_seconds)


def create_app(
    settings: Settings | None = None,
    redis: Redis | None = None,
    service: PriceService | None = None,
) -> FastAPI:
    settings = settings or Settings()
    setup_logging(settings.log_level)
    redis = redis or Redis.from_url(settings.redis_url, decode_responses=True, socket_timeout=2)
    service = service or build_service(settings, redis)
    log.info("starting", extra={"provider": settings.price_provider})

    app = FastAPI(title="CryptoFolio price-service", version="1.0.0")

    @app.middleware("http")
    async def observe(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
        start = time.perf_counter()
        response = await call_next(request)
        duration = time.perf_counter() - start
        route = getattr(request.scope.get("route"), "path", "unmatched")
        REQUESTS.labels(request.method, route, str(response.status_code)).observe(duration)
        response.headers["x-request-id"] = request_id
        if route not in QUIET_PATHS:
            log.info(
                "request",
                extra={
                    "request_id": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "duration_ms": round(duration * 1000, 1),
                },
            )
        return response

    @app.exception_handler(ProviderError)
    async def provider_error(_request: Request, exc: ProviderError):
        log.warning("provider error: %s", exc)
        return JSONResponse(status_code=503, content={"detail": "price provider unavailable"})

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz():
        try:
            redis.ping()
        except Exception:
            return JSONResponse(
                status_code=503, content={"status": "not_ready", "checks": {"redis": "error"}}
            )
        return {"status": "ready", "checks": {"redis": "ok"}}

    @app.get("/metrics")
    def metrics():
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    @app.get("/coins")
    def coins():
        items, stale = service.coins()
        return {"coins": [asdict(c) for c in items], "stale": stale}

    @app.get("/prices")
    def prices(ids: str):
        id_list = [i.strip().lower() for i in ids.split(",") if i.strip()]
        if not 1 <= len(id_list) <= 100:
            raise HTTPException(400, "ids must contain 1-100 coin ids")
        quotes, stale = service.prices(id_list)
        return {"prices": {k: asdict(v) for k, v in quotes.items()}, "stale": stale}

    @app.get("/history/{coin_id}")
    def history(coin_id: str, days: int = 7):
        if days not in HISTORY_DAYS:
            raise HTTPException(400, f"days must be one of {list(HISTORY_DAYS)}")
        try:
            points, stale = service.history(coin_id, days)
        except UnknownCoinError:
            raise HTTPException(404, f"unknown coin: {coin_id}") from None
        return {"id": coin_id, "days": days, "points": points, "stale": stale}

    return app
```

- [ ] **Step 6: Run all price-service tests**

Run: `docker build -q --target test -t cf-price-test services/price-service && docker run --rm cf-price-test`
Expected: ruff clean; all tests in 4 files PASS.

- [ ] **Step 7: Add price-service to `docker-compose.yml`** (under `services:`, after `minio-init`)

```yaml
  price-service:
    image: ${IMAGE_REGISTRY:-cryptofolio}/price-service:${IMAGE_TAG:-local}
    build: { context: ./services/price-service, target: runtime }
    environment:
      PRICE_PROVIDER: ${PRICE_PROVIDER}
      COINGECKO_BASE_URL: ${COINGECKO_BASE_URL}
      COINGECKO_API_KEY: ${COINGECKO_API_KEY}
      REDIS_URL: ${REDIS_URL}
      LOG_LEVEL: ${LOG_LEVEL}
    depends_on:
      redis: { condition: service_healthy }
    networks: [backend]
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"]
      interval: 10s
      timeout: 5s
      retries: 5
    stop_grace_period: 10s
    logging: *default-logging
    restart: unless-stopped
```

- [ ] **Step 8: Verify in compose**

Run: `docker compose up -d --build price-service && sleep 8 && docker compose ps price-service && docker compose exec price-service python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8000/prices?ids=bitcoin').read())"`
Expected: service `healthy`; output like `b'{"prices":{"bitcoin":{"usd":6xxxx.xx,"change_24h":...}},"stale":false}'`. `docker compose logs price-service` shows JSON log lines.

- [ ] **Step 9: Commit**

```bash
git add services/price-service docker-compose.yml
git commit -m "feat(price-service): coingecko provider, HTTP API, compose service"
```

---
### Task 5: api scaffold, database schema, migrations, seed, health, metrics

**Files:**
- Create: `services/api/{package.json,tsconfig.json,tsconfig.build.json,eslint.config.js,vitest.config.ts,vitest.integration.config.ts,Dockerfile,.dockerignore}`
- Create: `services/api/migrations/1727481600000_init.sql`
- Create: `services/api/src/{config.ts,deps.ts,app.ts,server.ts}`, `src/db/{database.ts,migrate.ts,seed.ts}`, `src/lib/{errors.ts,validation.ts}`, `src/plugins/metrics.ts`, `src/routes/{context.ts,health.ts}`
- Create: `docker-compose.test.yml` (test infrastructure)
- Modify: `docker-compose.yml` (add `migrate`, `api`)
- Test: `services/api/test/unit/config.test.ts`, `services/api/test/integration/{helpers.ts,health.test.ts}`

**Interfaces:**
- Produces:
  - `loadConfig(env = process.env): Config`. `Config` keys: `PORT, LOG_LEVEL, APP_ENV, DATABASE_URL, REDIS_URL, PRICE_SERVICE_URL, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, ACCESS_TOKEN_TTL_SECONDS (900), REFRESH_TOKEN_TTL_DAYS (7), COOKIE_SECURE (boolean), LOGIN_RATE_LIMIT_PER_MINUTE (10), JOBS_STREAM ('jobs'), S3_ENDPOINT, S3_PUBLIC_ENDPOINT, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET_AVATARS, S3_BUCKET_IMPORTS, S3_BUCKET_EXPORTS`.
  - `createDb(url): Kysely<DB>` and the `DB` table interfaces (`users, portfolios, transactions, watchlist, alerts, notifications, portfolio_snapshots, jobs`).
  - `Deps { config, db, redis }` (extended in Tasks 7 and 10), `createDeps(config)`, `closeDeps(deps)`.
  - `buildApp(deps): FastifyInstance`. `RouteContext { deps, tokens, authenticate }` (tokens/authenticate are filled in Task 6).
  - `HttpError(statusCode, code, message, details?)`, `notFound(what)`, `badRequest(msg)`, `unauthorized(msg?)`, `conflict(msg)`, error body shape `{"error":{"code","message","details?"}}`.
  - `parse(schema, data)`, `uuidParam`, `decimalString(opts)`.
  - `seedDemoData(db, now?) -> Promise<boolean>`, `DEMO_EMAIL`, `DEMO_PASSWORD`.
  - HTTP: `GET /api/healthz`, `GET /api/readyz` (`{"status","checks":{"postgres","redis"}}`), `GET /metrics` (not routed by the gateway), `GET /api/docs`.
  - Test helpers: `TEST_ENV`, `buildTestApp(opts?) -> Promise<TestApp>` where `TestApp = { app, deps, close() }`, `resetState(deps)`.

Local loop for the api: Node is installed locally, so run `npm` in `services/api`. Integration tests need the test infra:
```bash
docker compose -f docker-compose.test.yml up -d --wait postgres redis minio
docker compose -f docker-compose.test.yml run --rm minio-init
docker compose -f docker-compose.test.yml run --rm --build migrate
```

- [ ] **Step 1: Initialise the package and install dependencies**

`services/api/package.json`
```json
{
  "name": "cryptofolio-api",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/server.js",
    "migrate": "tsx src/db/migrate.ts",
    "lint": "eslint . && tsc --noEmit",
    "test": "vitest run --config vitest.config.ts",
    "test:integration": "vitest run --config vitest.integration.config.ts"
  }
}
```

Run:
```bash
cd services/api
npm install fastify @fastify/cookie @fastify/swagger @fastify/swagger-ui kysely pg ioredis zod@3 bcryptjs decimal.js fast-jwt prom-client node-pg-migrate@7
npm install -D typescript@5 tsx vitest @types/node@22 @types/pg eslint @eslint/js typescript-eslint
```
Expected: `package-lock.json` created, no errors.

`services/api/tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "test", "*.config.ts"]
}
```

`services/api/tsconfig.build.json`
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`services/api/eslint.config.js`
```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
```

`services/api/vitest.config.ts`
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['test/unit/**/*.test.ts'] } });
```

`services/api/vitest.integration.config.ts`
```ts
import { defineConfig } from 'vitest/config';

// Integration tests share one Postgres/Redis, so files run one at a time.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
```

`services/api/.dockerignore`
```
node_modules
dist
coverage
.env
```

- [ ] **Step 2: Write the failing config test**

`services/api/test/unit/config.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const required = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  PRICE_SERVICE_URL: 'http://localhost:8000',
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
  S3_BUCKET_AVATARS: 'cf-avatars',
  S3_BUCKET_IMPORTS: 'cf-imports',
  S3_BUCKET_EXPORTS: 'cf-exports',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(required);
    expect(config.PORT).toBe(3000);
    expect(config.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(config.REFRESH_TOKEN_TTL_DAYS).toBe(7);
    expect(config.COOKIE_SECURE).toBe(false);
    expect(config.JOBS_STREAM).toBe('jobs');
    expect(config.LOGIN_RATE_LIMIT_PER_MINUTE).toBe(10);
  });

  it('coerces numbers and booleans from strings', () => {
    const config = loadConfig({ ...required, PORT: '8080', COOKIE_SECURE: 'true' });
    expect(config.PORT).toBe(8080);
    expect(config.COOKIE_SECURE).toBe(true);
  });

  it('names every missing variable', () => {
    expect(() => loadConfig({ REDIS_URL: 'redis://x' })).toThrow(/DATABASE_URL.*JWT_ACCESS_SECRET/s);
  });

  it('rejects short JWT secrets', () => {
    expect(() => loadConfig({ ...required, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd services/api && npm test`
Expected: FAIL `Cannot find module '../../src/config.js'`

- [ ] **Step 4: Implement config, errors, validation**

`services/api/src/config.ts`
```ts
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default('info'),
  APP_ENV: z.string().default('local'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PRICE_SERVICE_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  JOBS_STREAM: z.string().default('jobs'),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET_AVATARS: z.string().min(1),
  S3_BUCKET_IMPORTS: z.string().min(1),
  S3_BUCKET_EXPORTS: z.string().min(1),
});

export type Config = z.infer<typeof schema>;

/** Reads configuration from environment variables and fails fast with a readable message. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}
```

`services/api/src/lib/errors.ts`
```ts
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'unauthorized', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);

/** Postgres unique_violation -> true */
export const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'validation_error', message: 'Invalid request', details: error.issues },
      });
    }
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    const statusCode = (error as FastifyError).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.status(statusCode).send({ error: { code: 'bad_request', message: error.message } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'not_found', message: `Route ${request.method} ${request.url} not found` },
    }),
  );
}
```

`services/api/src/lib/validation.ts`
```ts
import Decimal from 'decimal.js';
import { z } from 'zod';

/** Parse or throw ZodError (the error handler turns it into HTTP 400). */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

export const uuidParam = z.object({ id: z.string().uuid() });

/** Accepts "0.5" or 0.5, returns a plain decimal string (max 18 fraction digits). */
export const decimalString = (opts: { allowZero?: boolean } = {}) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine(
      (v) => /^\d+(\.\d{1,18})?$/.test(v) && (opts.allowZero || new Decimal(v).greaterThan(0)),
      { message: opts.allowZero ? 'must be a non-negative decimal' : 'must be a positive decimal' },
    );
```

- [ ] **Step 5: Run the config test**

Run: `cd services/api && npm test`
Expected: 4 tests PASS.

- [ ] **Step 6: Write the migration**

`services/api/migrations/1727481600000_init.sql`
```sql
-- Up Migration
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  avatar_key    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE portfolios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  base_currency text NOT NULL DEFAULT 'usd',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  coin_id      text NOT NULL,
  type         text NOT NULL CHECK (type IN ('buy', 'sell')),
  quantity     numeric(38, 18) NOT NULL CHECK (quantity > 0),
  price_usd    numeric(38, 18) NOT NULL CHECK (price_usd >= 0),
  fee_usd      numeric(38, 18) NOT NULL DEFAULT 0 CHECK (fee_usd >= 0),
  executed_at  timestamptz NOT NULL,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transactions_portfolio_idx ON transactions (portfolio_id, executed_at);

CREATE TABLE watchlist (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coin_id    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, coin_id)
);

CREATE TABLE alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coin_id      text NOT NULL,
  direction    text NOT NULL CHECK (direction IN ('above', 'below')),
  target_price numeric(38, 18) NOT NULL CHECK (target_price > 0),
  active       boolean NOT NULL DEFAULT true,
  triggered_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alerts_active_idx ON alerts (coin_id) WHERE active;

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL,
  body       text NOT NULL,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE portfolio_snapshots (
  portfolio_id uuid NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  date         date NOT NULL,
  value_usd    numeric(38, 2) NOT NULL,
  PRIMARY KEY (portfolio_id, date)
);

CREATE TABLE jobs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('export_csv', 'import_csv', 'report_pdf')),
  status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  params     jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_key text,
  result     jsonb,
  error      text,
  attempts   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_user_idx ON jobs (user_id, created_at DESC);

-- Down Migration
DROP TABLE jobs;
DROP TABLE portfolio_snapshots;
DROP TABLE notifications;
DROP TABLE alerts;
DROP TABLE watchlist;
DROP TABLE transactions;
DROP TABLE portfolios;
DROP TABLE users;
```

- [ ] **Step 7: Database module, migrate entrypoint, seed**

`services/api/src/db/database.ts`
```ts
import { type ColumnType, type Generated, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

// DATE columns come back as 'YYYY-MM-DD' strings: no timezone surprises.
pg.types.setTypeParser(1082, (value: string) => value);

type Numeric = ColumnType<string, string | number, string | number>;
type NumericWithDefault = ColumnType<string, string | number | undefined, string | number>;
type Json<T> = ColumnType<T, string, string>;

export type JobType = 'export_csv' | 'import_csv' | 'report_pdf';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  display_name: string;
  avatar_key: string | null;
  created_at: Generated<Date>;
}
export interface PortfoliosTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  base_currency: Generated<string>;
  created_at: Generated<Date>;
}
export interface TransactionsTable {
  id: Generated<string>;
  portfolio_id: string;
  coin_id: string;
  type: 'buy' | 'sell';
  quantity: Numeric;
  price_usd: Numeric;
  fee_usd: NumericWithDefault;
  executed_at: ColumnType<Date, Date | string, Date | string>;
  note: string | null;
  created_at: Generated<Date>;
}
export interface WatchlistTable {
  user_id: string;
  coin_id: string;
  created_at: Generated<Date>;
}
export interface AlertsTable {
  id: Generated<string>;
  user_id: string;
  coin_id: string;
  direction: 'above' | 'below';
  target_price: Numeric;
  active: Generated<boolean>;
  triggered_at: Date | null;
  created_at: Generated<Date>;
}
export interface NotificationsTable {
  id: Generated<string>;
  user_id: string;
  title: string;
  body: string;
  read_at: Date | null;
  created_at: Generated<Date>;
}
export interface PortfolioSnapshotsTable {
  portfolio_id: string;
  date: string;
  value_usd: Numeric;
}
export interface JobsTable {
  id: Generated<string>;
  user_id: string;
  type: JobType;
  status: ColumnType<JobStatus, JobStatus | undefined, JobStatus>;
  params: Json<Record<string, unknown>>;
  result_key: string | null;
  result: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  error: string | null;
  attempts: Generated<number>;
  created_at: Generated<Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface DB {
  users: UsersTable;
  portfolios: PortfoliosTable;
  transactions: TransactionsTable;
  watchlist: WatchlistTable;
  alerts: AlertsTable;
  notifications: NotificationsTable;
  portfolio_snapshots: PortfolioSnapshotsTable;
  jobs: JobsTable;
}

export function createDb(connectionString: string): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) }),
  });
}
```

`services/api/src/db/seed.ts`
```ts
import bcrypt from 'bcryptjs';
import type { Kysely } from 'kysely';
import type { DB } from './database.js';

export const DEMO_EMAIL = 'demo@cryptofolio.local';
export const DEMO_PASSWORD = 'demo1234';

const DAY_MS = 86_400_000;

/** Inserts a demo user with sample data. Idempotent: returns false if the user already exists. */
export async function seedDemoData(db: Kysely<DB>, now = new Date()): Promise<boolean> {
  const existing = await db.selectFrom('users').select('id').where('email', '=', DEMO_EMAIL).executeTakeFirst();
  if (existing) return false;

  const daysAgo = (d: number) => new Date(now.getTime() - d * DAY_MS);

  await db.transaction().execute(async (trx) => {
    const user = await trx
      .insertInto('users')
      .values({ email: DEMO_EMAIL, password_hash: await bcrypt.hash(DEMO_PASSWORD, 10), display_name: 'Demo Trader' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const [longTerm, trading] = await trx
      .insertInto('portfolios')
      .values([
        { user_id: user.id, name: 'Long-term HODL' },
        { user_id: user.id, name: 'Active Trading' },
      ])
      .returning(['id', 'name'])
      .execute();

    const txs: Array<[string, string, 'buy' | 'sell', string, string, string, number]> = [
      [longTerm.id, 'bitcoin', 'buy', '0.5', '42000', '10', 400],
      [longTerm.id, 'ethereum', 'buy', '4', '2200', '5', 300],
      [longTerm.id, 'solana', 'buy', '50', '95', '2', 200],
      [longTerm.id, 'ethereum', 'sell', '1', '3500', '5', 60],
      [trading.id, 'dogecoin', 'buy', '10000', '0.08', '1', 90],
      [trading.id, 'cardano', 'buy', '2000', '0.35', '1', 45],
      [trading.id, 'chainlink', 'buy', '40', '12', '1', 20],
    ];
    await trx
      .insertInto('transactions')
      .values(
        txs.map(([portfolio_id, coin_id, type, quantity, price_usd, fee_usd, ago]) => ({
          portfolio_id, coin_id, type, quantity, price_usd, fee_usd, executed_at: daysAgo(ago),
        })),
      )
      .execute();

    await trx
      .insertInto('watchlist')
      .values(['bitcoin', 'ethereum', 'solana', 'avalanche-2'].map((coin_id) => ({ user_id: user.id, coin_id })))
      .execute();

    await trx
      .insertInto('alerts')
      .values({ user_id: user.id, coin_id: 'bitcoin', direction: 'above', target_price: '80000' })
      .execute();

    // 30 days of synthetic history so the chart is not empty on first run.
    // The worker writes real snapshots from then on.
    const snapshots = [];
    for (let i = 30; i >= 1; i--) {
      const date = daysAgo(i).toISOString().slice(0, 10);
      const drift = 0.9 + (0.1 * (30 - i)) / 30 + 0.02 * Math.sin(i / 2);
      snapshots.push({ portfolio_id: longTerm.id, date, value_usd: (48000 * drift).toFixed(2) });
      snapshots.push({ portfolio_id: trading.id, date, value_usd: (3000 * drift).toFixed(2) });
    }
    await trx.insertInto('portfolio_snapshots').values(snapshots).execute();

    await trx
      .insertInto('notifications')
      .values({ user_id: user.id, title: 'Welcome to CryptoFolio', body: 'This demo account comes with two sample portfolios.' })
      .execute();
  });
  return true;
}
```

`services/api/src/db/migrate.ts`
```ts
/**
 * One-off entrypoint for the `migrate` container:
 *   1. applies pending SQL migrations (node-pg-migrate, advisory-locked)
 *   2. optionally seeds demo data (SEED_DEMO_DATA=true)
 * Exits 0 on success so dependants can use `service_completed_successfully`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { createDb } from './database.js';
import { seedDemoData } from './seed.js';

const log = (level: string, msg: string) => console.log(JSON.stringify({ level, service: 'migrate', msg }));
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const applied = await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: (msg: string) => log('info', msg),
  });
  log('info', `applied ${applied.length} migration(s)`);

  if (process.env.SEED_DEMO_DATA === 'true') {
    const db = createDb(databaseUrl);
    try {
      log('info', (await seedDemoData(db)) ? 'demo data seeded' : 'demo data already present');
    } finally {
      await db.destroy();
    }
  }
}

main().catch((err) => {
  log('error', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
```

- [ ] **Step 8: Metrics plugin, deps, route context, health routes, app, server**

`services/api/src/plugins/metrics.ts`
```ts
import type { FastifyInstance } from 'fastify';
import client from 'prom-client';

/** Prometheus metrics at GET /metrics (internal only; the gateway does not route it). */
export function registerMetrics(app: FastifyInstance): client.Registry {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });

  app.addHook('onResponse', async (request, reply) => {
    httpDuration
      .labels(request.method, request.routeOptions.url ?? 'unmatched', String(reply.statusCode))
      .observe(reply.elapsedTime / 1000);
  });
  app.get('/metrics', { logLevel: 'warn' }, async (_request, reply) =>
    reply.type(registry.contentType).send(await registry.metrics()),
  );
  return registry;
}
```

`services/api/src/deps.ts`
```ts
import { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import type { Config } from './config.js';
import { createDb, type DB } from './db/database.js';

/** Everything with I/O that route handlers need. Tests swap parts of it for fakes. */
export interface Deps {
  config: Config;
  db: Kysely<DB>;
  redis: Redis;
}

export function createDeps(config: Config): Deps {
  return {
    config,
    db: createDb(config.DATABASE_URL),
    redis: new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 }),
  };
}

export async function closeDeps(deps: Deps): Promise<void> {
  await deps.db.destroy();
  deps.redis.disconnect();
}
```

`services/api/src/routes/context.ts`
```ts
import type { FastifyRequest } from 'fastify';
import type { Deps } from '../deps.js';

export interface RouteContext {
  deps: Deps;
  /** preHandler that sets request.userId or throws 401 (implemented in Task 6). */
  authenticate: (request: FastifyRequest) => Promise<void>;
}
```

`services/api/src/routes/health.ts`
```ts
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { RouteContext } from './context.js';

async function check(fn: () => Promise<unknown>, timeoutMs = 2000): Promise<'ok' | 'error'> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return 'ok';
  } catch {
    return 'error';
  }
}

export function healthRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  // Liveness: the process is up. Never checks dependencies.
  app.get('/api/healthz', { logLevel: 'warn' }, async () => ({ status: 'ok' }));

  // Readiness: can we serve traffic? The price-service is deliberately NOT checked:
  // it is a soft dependency and must not take the api out of rotation.
  app.get('/api/readyz', { logLevel: 'warn' }, async (_request, reply) => {
    const checks: Record<string, 'ok' | 'error'> = {
      postgres: await check(() => sql`select 1`.execute(deps.db)),
      redis: await check(() => deps.redis.ping()),
    };
    const ready = Object.values(checks).every((v) => v === 'ok');
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });
}
```

`services/api/src/app.ts`
```ts
import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Deps } from './deps.js';
import { registerErrorHandler, unauthorized } from './lib/errors.js';
import { registerMetrics } from './plugins/metrics.js';
import type { RouteContext } from './routes/context.js';
import { healthRoutes } from './routes/health.js';

export function buildApp(deps: Deps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL,
      base: { service: 'api' },
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    trustProxy: true,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  registerErrorHandler(app);
  registerMetrics(app);
  app.register(cookie);
  app.register(swagger, { openapi: { info: { title: 'CryptoFolio API', version: '1.0.0' } } });
  app.register(swaggerUi, { routePrefix: '/api/docs' });

  const ctx: RouteContext = {
    deps,
    authenticate: async () => {
      throw unauthorized();
    },
  };

  app.register(async (api) => {
    healthRoutes(api, ctx);
  });

  return app;
}
```

`services/api/src/server.ts`
```ts
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { closeDeps, createDeps } from './deps.js';

const config = loadConfig();
const deps = createDeps(config);
const app = buildApp(deps);

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close(); // stop accepting, finish in-flight requests
  await closeDeps(deps);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.PORT });
```

- [ ] **Step 9: Dockerfile**

`services/api/Dockerfile`
```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# `docker build --target test` -> image that runs lint + tests (used by CI)
FROM deps AS test
COPY . .
CMD ["sh", "-c", "npm run lint && npm test && npm run test:integration"]

FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

- [ ] **Step 10: Test infrastructure compose file**

`docker-compose.test.yml`
```yaml
# Throwaway infrastructure for integration tests (ports offset by 50000 to avoid clashes).
name: cryptofolio-test

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: cryptofolio
      POSTGRES_PASSWORD: cryptofolio
      POSTGRES_DB: cryptofolio_test
    ports: ["55432:5432"]
    tmpfs: [/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U cryptofolio -d cryptofolio_test"]
      interval: 2s
      retries: 30

  redis:
    image: redis:7-alpine
    ports: ["56379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      retries: 30

  minio:
    image: minio/minio:RELEASE.2025-04-22T22-12-26Z
    command: ["server", "/data"]
    environment:
      MINIO_ROOT_USER: cryptofolio
      MINIO_ROOT_PASSWORD: cryptofolio-secret
    ports: ["59000:9000"]
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 2s
      retries: 30

  minio-init:
    image: minio/mc:RELEASE.2025-04-16T18-13-26Z
    depends_on:
      minio: { condition: service_healthy }
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
        set -e
        mc alias set local http://minio:9000 cryptofolio cryptofolio-secret
        for b in cf-avatars cf-imports cf-exports; do mc mb --ignore-existing local/$$b; done

  migrate:
    build: { context: ./services/api, target: runtime }
    command: ["node", "dist/db/migrate.js"]
    environment:
      DATABASE_URL: postgres://cryptofolio:cryptofolio@postgres:5432/cryptofolio_test
      SEED_DEMO_DATA: "false"
    depends_on:
      postgres: { condition: service_healthy }
```

- [ ] **Step 11: Integration test helpers and failing health test**

`services/api/test/integration/helpers.ts`
```ts
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/database.js';
import { closeDeps, type Deps } from '../../src/deps.js';

const S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:59000';

/** Defaults target docker-compose.test.yml from the host; containers override via env. */
export const TEST_ENV: Record<string, string> = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://cryptofolio:cryptofolio@localhost:55432/cryptofolio_test',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:56379/0',
  PRICE_SERVICE_URL: 'http://price-service.invalid',
  JWT_ACCESS_SECRET: 'test-access-secret',
  JWT_REFRESH_SECRET: 'test-refresh-secret',
  LOG_LEVEL: 'silent',
  LOGIN_RATE_LIMIT_PER_MINUTE: '5',
  JOBS_STREAM: 'jobs-test',
  S3_ENDPOINT,
  // Tests talk to MinIO directly, so public == internal endpoint here.
  S3_PUBLIC_ENDPOINT: S3_ENDPOINT,
  S3_ACCESS_KEY: 'cryptofolio',
  S3_SECRET_KEY: 'cryptofolio-secret',
  S3_BUCKET_AVATARS: 'cf-avatars',
  S3_BUCKET_IMPORTS: 'cf-imports',
  S3_BUCKET_EXPORTS: 'cf-exports',
};

export interface TestApp {
  app: FastifyInstance;
  deps: Deps;
  close: () => Promise<void>;
}

export async function resetState(deps: Deps): Promise<void> {
  await sql`TRUNCATE users, portfolios, transactions, watchlist, alerts, notifications, portfolio_snapshots, jobs CASCADE`.execute(deps.db);
  await deps.redis.flushdb();
}

export async function buildTestApp(): Promise<TestApp> {
  const config = loadConfig(TEST_ENV);
  const deps: Deps = { config, db: createDb(config.DATABASE_URL), redis: new Redis(config.REDIS_URL) };
  await resetState(deps);
  const app = buildApp(deps);
  await app.ready();
  return {
    app,
    deps,
    close: async () => {
      await app.close();
      await closeDeps(deps);
    },
  };
}
```

`services/api/test/integration/health.test.ts`
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers.js';

describe('health', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await buildTestApp();
  });
  afterAll(() => t.close());

  it('liveness is always ok', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('readiness checks postgres and redis', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toMatchObject({ postgres: 'ok', redis: 'ok' });
  });

  it('exposes prometheus metrics', async () => {
    await t.app.inject({ method: 'GET', url: '/api/healthz' });
    const res = await t.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('http_request_duration_seconds');
  });

  it('echoes the request id', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/healthz', headers: { 'x-request-id': 'abc-123' } });
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});
```

- [ ] **Step 12: Run lint, unit and integration tests**

```bash
docker compose -f docker-compose.test.yml up -d --wait postgres redis minio
docker compose -f docker-compose.test.yml run --rm minio-init
docker compose -f docker-compose.test.yml run --rm --build migrate
cd services/api && npm run lint && npm test && npm run test:integration
```
Expected: migrate logs `applied 1 migration(s)`; lint clean; config (4) and health (5) tests PASS. Running `migrate` a second time logs `applied 0 migration(s)`.

- [ ] **Step 13: Add `migrate` and `api` to `docker-compose.yml`** (after `price-service`)

```yaml
  migrate:
    image: ${IMAGE_REGISTRY:-cryptofolio}/api:${IMAGE_TAG:-local}
    build: { context: ./services/api, target: runtime }
    command: ["node", "dist/db/migrate.js"]
    environment:
      DATABASE_URL: ${DATABASE_URL}
      SEED_DEMO_DATA: ${SEED_DEMO_DATA}
    depends_on:
      postgres: { condition: service_healthy }
    networks: [backend]
    restart: "no"

  api:
    image: ${IMAGE_REGISTRY:-cryptofolio}/api:${IMAGE_TAG:-local}
    build: { context: ./services/api, target: runtime }
    environment:
      APP_ENV: ${APP_ENV}
      LOG_LEVEL: ${LOG_LEVEL}
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      PRICE_SERVICE_URL: ${PRICE_SERVICE_URL}
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET}
      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET}
      COOKIE_SECURE: ${COOKIE_SECURE}
      LOGIN_RATE_LIMIT_PER_MINUTE: ${LOGIN_RATE_LIMIT_PER_MINUTE}
      JOBS_STREAM: ${JOBS_STREAM}
      S3_ENDPOINT: ${S3_ENDPOINT}
      S3_PUBLIC_ENDPOINT: ${S3_PUBLIC_ENDPOINT}
      S3_REGION: ${S3_REGION}
      S3_ACCESS_KEY: ${S3_ACCESS_KEY}
      S3_SECRET_KEY: ${S3_SECRET_KEY}
      S3_BUCKET_AVATARS: ${S3_BUCKET_AVATARS}
      S3_BUCKET_IMPORTS: ${S3_BUCKET_IMPORTS}
      S3_BUCKET_EXPORTS: ${S3_BUCKET_EXPORTS}
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
      minio-init: { condition: service_completed_successfully }
      price-service: { condition: service_started }
    networks: [edge, backend]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5
    stop_grace_period: 15s
    logging: *default-logging
    restart: unless-stopped
```


- [ ] **Step 14: Verify in compose**

Run: `docker compose up -d --build && sleep 20 && docker compose ps -a && docker compose logs migrate && docker compose exec api node -e "fetch('http://127.0.0.1:3000/api/readyz').then(r=>r.text()).then(console.log)"`
Expected: `migrate` Exited (0) with `demo data seeded`; `api` healthy; readyz prints `{"status":"ready","checks":{"postgres":"ok","redis":"ok"}}`.

- [ ] **Step 15: Commit**

```bash
git add services/api docker-compose.yml docker-compose.test.yml
git commit -m "feat(api): scaffold, schema migrations, demo seed, health and metrics"
```

---

### Task 6: api authentication and profile

**Files:**
- Create: `services/api/src/lib/{tokens.ts,rateLimit.ts}`, `src/plugins/auth.ts`, `src/routes/{auth.ts,me.ts}`
- Modify: `services/api/src/routes/context.ts`, `src/app.ts`, `test/integration/helpers.ts`
- Test: `services/api/test/unit/tokens.test.ts`, `test/integration/auth.test.ts`

**Interfaces:**
- Consumes: `Deps`, `HttpError`, `parse`, `RouteContext` (Task 5).
- Produces:
  - `createTokenService(config): TokenService` with `signAccess(userId)`, `signRefresh(userId)`, `verifyAccess(token) -> {sub}`, `verifyRefresh(token) -> {sub}`.
  - `isRateLimited(redis, key, limit, windowSeconds) -> Promise<boolean>`.
  - `setupAuth(app, tokens) -> authenticate` and `request.userId: string`.
  - `RouteContext` gains `tokens: TokenService`.
  - `toUserDto(user, avatarUrl) -> { id, email, displayName, avatarUrl, createdAt }`.
  - HTTP: `POST /api/auth/register {email,password,displayName}` → 201 `{accessToken, user}` + cookie `cf_refresh` (httpOnly, SameSite=Strict, path `/api/auth`); `POST /api/auth/login {email,password}` → 200 same | 401 `invalid_credentials` | 429 `rate_limited`; `POST /api/auth/refresh` (cookie) → 200 same (rotates cookie) | 401; `POST /api/auth/logout` → 204; `GET /api/me` → user; `PATCH /api/me {displayName}` → user.
  - Test helper `registerUser(app, email?) -> { token, userId, headers }`.
- Protected routes are registered inside the `secured` plugin in `app.ts`. Later tasks add their route modules there.

- [ ] **Step 1: Write the failing token test**

`services/api/test/unit/tokens.test.ts`
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenService } from '../../src/lib/tokens.js';

const tokens = createTokenService({
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  ACCESS_TOKEN_TTL_SECONDS: 60,
  REFRESH_TOKEN_TTL_DAYS: 7,
});

afterEach(() => vi.useRealTimers());

describe('token service', () => {
  it('round-trips access and refresh tokens', () => {
    expect(tokens.verifyAccess(tokens.signAccess('user-1'))).toEqual({ sub: 'user-1' });
    expect(tokens.verifyRefresh(tokens.signRefresh('user-1'))).toEqual({ sub: 'user-1' });
  });

  it('does not accept an access token as a refresh token (and vice versa)', () => {
    expect(() => tokens.verifyRefresh(tokens.signAccess('user-1'))).toThrow();
    expect(() => tokens.verifyAccess(tokens.signRefresh('user-1'))).toThrow();
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd services/api && npm test -- tokens`
Expected: FAIL `Cannot find module '../../src/lib/tokens.js'`

- [ ] **Step 3: Implement tokens and rate limiting**

`services/api/src/lib/tokens.ts`
```ts
import { createSigner, createVerifier } from 'fast-jwt';
import type { Config } from '../config.js';

export interface TokenService {
  signAccess(userId: string): string;
  signRefresh(userId: string): string;
  verifyAccess(token: string): { sub: string };
  verifyRefresh(token: string): { sub: string };
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
    signRefresh: (userId) => signRefresh({ sub: userId, typ: 'refresh' }),
    verifyAccess: (token) => assertType(verifyAccess(token), 'access'),
    verifyRefresh: (token) => assertType(verifyRefresh(token), 'refresh'),
  };
}
```

`services/api/src/lib/rateLimit.ts`
```ts
import type { Redis } from 'ioredis';

/** Fixed-window counter in Redis. Returns true when the caller is over the limit. */
export async function isRateLimited(redis: Redis, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count > limit;
}
```

- [ ] **Step 4: Run token tests**

Run: `cd services/api && npm test`
Expected: all unit tests PASS.

- [ ] **Step 5: Write failing auth integration tests**

Append to `services/api/test/integration/helpers.ts`:
```ts
export async function registerUser(app: FastifyInstance, email = 'alice@example.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'password123', displayName: email.split('@')[0] },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const body = res.json();
  return {
    token: body.accessToken as string,
    userId: body.user.id as string,
    headers: { authorization: `Bearer ${body.accessToken}` },
  };
}
```

`services/api/test/integration/auth.test.ts`
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, registerUser, resetState, type TestApp } from './helpers.js';

describe('auth', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await buildTestApp();
  });
  beforeEach(() => resetState(t.deps));
  afterAll(() => t.close());

  const login = (email: string, password: string) =>
    t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

  it('registers, normalises email and sets an httpOnly refresh cookie', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: '  Alice@Example.COM ', password: 'password123', displayName: 'Alice' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ email: 'alice@example.com', displayName: 'Alice', avatarUrl: null });
    expect(res.json().accessToken).toEqual(expect.any(String));
    const cookie = res.cookies.find((c) => c.name === 'cf_refresh');
    expect(cookie).toMatchObject({ httpOnly: true, path: '/api/auth', sameSite: 'Strict' });
  });

  it('rejects a duplicate email with 409', async () => {
    await registerUser(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'alice@example.com', password: 'password123', displayName: 'A' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a short password with a validation error', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'bob@example.com', password: 'short', displayName: 'Bob' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('logs in with the right password only', async () => {
    await registerUser(t.app);
    expect((await login('alice@example.com', 'password123')).statusCode).toBe(200);
    const bad = await login('alice@example.com', 'wrong-password');
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('invalid_credentials');
    expect((await login('nobody@example.com', 'password123')).statusCode).toBe(401);
  });

  it('rate limits login attempts per IP', async () => {
    for (let i = 0; i < 5; i++) await login('alice@example.com', 'nope-nope');
    const res = await login('alice@example.com', 'nope-nope');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
  });

  it('issues a new access token from the refresh cookie', async () => {
    const reg = await t.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'carol@example.com', password: 'password123', displayName: 'Carol' },
    });
    const refreshCookie = reg.cookies.find((c) => c.name === 'cf_refresh')!.value;
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cf_refresh: refreshCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toEqual(expect.any(String));
  });

  it('refuses refresh without a cookie or with an access token', async () => {
    const { token } = await registerUser(t.app);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/refresh' })).statusCode).toBe(401);
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cf_refresh: token } });
    expect(res.statusCode).toBe(401);
  });

  it('logout clears the cookie', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(res.statusCode).toBe(204);
    expect(res.cookies.find((c) => c.name === 'cf_refresh')?.value).toBe('');
  });

  it('GET /api/me requires a valid bearer token', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    const bad = await t.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer nope' } });
    expect(bad.statusCode).toBe(401);
    const { headers, userId } = await registerUser(t.app);
    const res = await t.app.inject({ method: 'GET', url: '/api/me', headers });
    expect(res.json()).toMatchObject({ id: userId, email: 'alice@example.com' });
  });

  it('PATCH /api/me updates the display name', async () => {
    const { headers } = await registerUser(t.app);
    const res = await t.app.inject({ method: 'PATCH', url: '/api/me', headers, payload: { displayName: 'Alice Cooper' } });
    expect(res.json().displayName).toBe('Alice Cooper');
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `cd services/api && npm run test:integration -- auth`
Expected: FAIL. Register returns 404 (`Route POST /api/auth/register not found`).

- [ ] **Step 7: Implement auth plugin and routes**

`services/api/src/plugins/auth.ts`
```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { unauthorized } from '../lib/errors.js';
import type { TokenService } from '../lib/tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

/** Adds request.userId and returns a preHandler that requires a valid Bearer access token. */
export function setupAuth(app: FastifyInstance, tokens: TokenService) {
  app.decorateRequest('userId', '');
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    try {
      request.userId = tokens.verifyAccess(header.slice('Bearer '.length)).sub;
    } catch {
      throw unauthorized('Invalid or expired token');
    }
  };
}
```

Replace `services/api/src/routes/context.ts`:
```ts
import type { FastifyRequest } from 'fastify';
import type { Deps } from '../deps.js';
import type { TokenService } from '../lib/tokens.js';

export interface RouteContext {
  deps: Deps;
  tokens: TokenService;
  /** preHandler that sets request.userId or throws 401. */
  authenticate: (request: FastifyRequest) => Promise<void>;
}
```

`services/api/src/routes/me.ts`
```ts
import type { FastifyInstance } from 'fastify';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { UsersTable } from '../db/database.js';
import { notFound } from '../lib/errors.js';
import { parse } from '../lib/validation.js';
import type { RouteContext } from './context.js';

export function toUserDto(user: Selectable<UsersTable>, avatarUrl: string | null = null) {
  return { id: user.id, email: user.email, displayName: user.display_name, avatarUrl, createdAt: user.created_at };
}

export function meRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const loadUser = async (userId: string) => {
    const user = await deps.db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
    if (!user) throw notFound('User');
    return user;
  };

  app.get('/api/me', async (request) => toUserDto(await loadUser(request.userId)));

  app.patch('/api/me', async (request) => {
    const body = parse(z.object({ displayName: z.string().trim().min(1).max(60) }), request.body);
    await deps.db.updateTable('users').set({ display_name: body.displayName }).where('id', '=', request.userId).execute();
    return toUserDto(await loadUser(request.userId));
  });
}
```

`services/api/src/routes/auth.ts`
```ts
import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { UsersTable } from '../db/database.js';
import { conflict, HttpError, isUniqueViolation, unauthorized } from '../lib/errors.js';
import { isRateLimited } from '../lib/rateLimit.js';
import { parse } from '../lib/validation.js';
import type { RouteContext } from './context.js';
import { toUserDto } from './me.js';

export const REFRESH_COOKIE = 'cf_refresh';
const COOKIE_PATH = '/api/auth';

const email = z.string().trim().toLowerCase().email().max(254);
const registerBody = z.object({
  email,
  password: z.string().min(8).max(128),
  displayName: z.string().trim().min(1).max(60),
});
const loginBody = z.object({ email, password: z.string().min(1).max(128) });

export function authRoutes(app: FastifyInstance, { deps, tokens }: RouteContext): void {
  const { db, redis, config } = deps;

  const issueTokens = (reply: FastifyReply, user: Selectable<UsersTable>) => {
    reply.setCookie(REFRESH_COOKIE, tokens.signRefresh(user.id), {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.COOKIE_SECURE,
      path: COOKIE_PATH,
      maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400,
    });
    return { accessToken: tokens.signAccess(user.id), user: toUserDto(user) };
  };

  app.post('/api/auth/register', async (request, reply) => {
    const body = parse(registerBody, request.body);
    try {
      const user = await db
        .insertInto('users')
        .values({ email: body.email, password_hash: await bcrypt.hash(body.password, 10), display_name: body.displayName })
        .returningAll()
        .executeTakeFirstOrThrow();
      reply.status(201);
      return issueTokens(reply, user);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('Email is already registered');
      throw err;
    }
  });

  app.post('/api/auth/login', async (request, reply) => {
    if (await isRateLimited(redis, `ratelimit:login:${request.ip}`, config.LOGIN_RATE_LIMIT_PER_MINUTE, 60)) {
      throw new HttpError(429, 'rate_limited', 'Too many login attempts, try again in a minute');
    }
    const body = parse(loginBody, request.body);
    const user = await db.selectFrom('users').selectAll().where('email', '=', body.email).executeTakeFirst();
    if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
      throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
    }
    return issueTokens(reply, user);
  });

  app.post('/api/auth/refresh', async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE];
    if (!token) throw unauthorized('No refresh token');
    let userId: string;
    try {
      userId = tokens.verifyRefresh(token).sub;
    } catch {
      reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      throw unauthorized('Invalid refresh token');
    }
    const user = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
    if (!user) throw unauthorized('Invalid refresh token');
    return issueTokens(reply, user);
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
    return reply.status(204).send();
  });
}
```

- [ ] **Step 8: Wire auth into `app.ts`**

In `services/api/src/app.ts` replace the `ctx` block and the `app.register(async (api) => …)` block with:
```ts
  const tokens = createTokenService(deps.config);
  const ctx: RouteContext = { deps, tokens, authenticate: setupAuth(app, tokens) };

  app.register(async (api) => {
    // Public routes
    healthRoutes(api, ctx);
    authRoutes(api, ctx);

    // Everything registered in here requires a valid access token.
    api.register(async (secured) => {
      secured.addHook('preHandler', ctx.authenticate);
      meRoutes(secured, ctx);
    });
  });
```
Update imports: remove `unauthorized`; add
```ts
import { createTokenService } from './lib/tokens.js';
import { setupAuth } from './plugins/auth.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
```

- [ ] **Step 9: Run all api tests**

Run: `cd services/api && npm run lint && npm test && npm run test:integration`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add services/api
git commit -m "feat(api): JWT auth with refresh cookie, login rate limit, profile endpoints"
```

---

### Task 7: api price client, market proxy, watchlist, alerts, notifications

**Files:**
- Create: `services/api/src/lib/priceClient.ts`, `src/routes/{market.ts,watchlist.ts,alerts.ts,notifications.ts}`
- Modify: `services/api/src/deps.ts`, `src/app.ts`, `test/integration/helpers.ts`
- Test: `services/api/test/unit/priceClient.test.ts`, `test/integration/market.test.ts`

**Interfaces:**
- Consumes: price-service HTTP contract (Task 4), `RouteContext`, `registerUser` (Task 6).
- Produces:
  - `Quote { usd: number; change24h: number }`, `CoinDto { id, symbol, name, image, currentPrice, change24h, marketCap }`.
  - `PriceClient` interface: `getCoins() -> {coins: CoinDto[], stale}`, `getPrices(ids) -> {prices: Record<string, Quote>, stale}`, `getHistory(id, days) -> {id, days, points: [number, number][], stale}`. Errors: `HttpError(502,'price_service_unavailable')`, `notFound('Coin')`.
  - `HttpPriceClient(baseUrl, timeoutMs=5000)`, `assertKnownCoin(prices, coinId) -> CoinDto` (400 on unknown), `pricesOrEmpty(prices, ids)` (on 502 returns `{prices:{}, stale:true}`).
  - `Deps.prices: PriceClient`.
  - Test helper `FakePriceClient` (quotes: bitcoin 50000/+2, ethereum 3000/−1, solana 100/+5; `down` flag). `buildTestApp({ prices? })` returns `TestApp.prices`.
  - HTTP (public): `GET /api/market/coins`, `GET /api/market/prices?ids=`, `GET /api/market/history/:id?days=1|7|30|365`.
  - HTTP (secured): `GET /api/watchlist` → `{items: CoinDto[], stale}`, `POST /api/watchlist {coinId}` → 201, `DELETE /api/watchlist/:coinId` → 204; `GET /api/alerts` → `{items: AlertDto[], stale}`, `POST /api/alerts {coinId, direction:'above'|'below', targetPrice}` → 201 AlertDto, `DELETE /api/alerts/:id` → 204; `GET /api/notifications?unread=true` → `{items:[{id,title,body,readAt,createdAt}], unreadCount}`, `POST /api/notifications/:id/read` → 204, `POST /api/notifications/read-all` → 204.
  - `AlertDto { id, coinId, direction, targetPrice, active, triggeredAt, createdAt, currentPrice: number|null }`.

- [ ] **Step 1: Write the failing price-client unit test**

`services/api/test/unit/priceClient.test.ts`
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/lib/errors.js';
import { HttpPriceClient, pricesOrEmpty } from '../../src/lib/priceClient.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('HttpPriceClient', () => {
  const client = new HttpPriceClient('http://prices.test');

  it('maps snake_case prices to camelCase', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { prices: { bitcoin: { usd: 1, change_24h: 2 } }, stale: false }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await client.getPrices(['bitcoin', 'bitcoin'])).toEqual({ prices: { bitcoin: { usd: 1, change24h: 2 } }, stale: false });
    expect(fetchMock.mock.calls[0][0]).toBe('http://prices.test/prices?ids=bitcoin');
  });

  it('does not call the service for an empty id list', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await client.getPrices([])).toEqual({ prices: {}, stale: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps coins', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, {
      coins: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', image: null, current_price: 5, change_24h: 1, market_cap: 9 }],
      stale: true,
    })));
    expect(await client.getCoins()).toEqual({
      coins: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', image: null, currentPrice: 5, change24h: 1, marketCap: 9 }],
      stale: true,
    });
  });

  it('turns 404 into not_found and 5xx / network errors into 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(404, { detail: 'unknown' })));
    await expect(client.getHistory('x', 7)).rejects.toMatchObject({ statusCode: 404 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(503, { detail: 'down' })));
    await expect(client.getCoins()).rejects.toMatchObject({ statusCode: 502, code: 'price_service_unavailable' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(client.getCoins()).rejects.toBeInstanceOf(HttpError);
  });

  it('pricesOrEmpty degrades to stale empty prices when the service is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(await pricesOrEmpty(client, ['bitcoin'])).toEqual({ prices: {}, stale: true });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd services/api && npm test -- priceClient`
Expected: FAIL `Cannot find module '../../src/lib/priceClient.js'`

- [ ] **Step 3: Implement the price client**

`services/api/src/lib/priceClient.ts`
```ts
import { badRequest, HttpError, notFound } from './errors.js';

export interface Quote {
  usd: number;
  change24h: number;
}
export interface CoinDto {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  currentPrice: number;
  change24h: number;
  marketCap: number;
}
export interface PriceHistory {
  id: string;
  days: number;
  points: [number, number][];
  stale: boolean;
}

export interface PriceClient {
  getCoins(): Promise<{ coins: CoinDto[]; stale: boolean }>;
  getPrices(ids: string[]): Promise<{ prices: Record<string, Quote>; stale: boolean }>;
  getHistory(id: string, days: number): Promise<PriceHistory>;
}

interface RawCoin {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  current_price: number;
  change_24h: number;
  market_cap: number;
}

const unavailable = () => new HttpError(502, 'price_service_unavailable', 'Price service is unavailable');

export class HttpPriceClient implements PriceClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 5000) {}

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw unavailable();
    }
    if (res.status === 404) throw notFound('Coin');
    if (!res.ok) throw unavailable();
    return (await res.json()) as T;
  }

  async getCoins() {
    const data = await this.get<{ coins: RawCoin[]; stale: boolean }>('/coins');
    return {
      coins: data.coins.map((c) => ({
        id: c.id, symbol: c.symbol, name: c.name, image: c.image,
        currentPrice: c.current_price, change24h: c.change_24h, marketCap: c.market_cap,
      })),
      stale: data.stale,
    };
  }

  async getPrices(ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return { prices: {}, stale: false };
    const data = await this.get<{ prices: Record<string, { usd: number; change_24h: number }>; stale: boolean }>(
      `/prices?ids=${encodeURIComponent(unique.join(','))}`,
    );
    const prices = Object.fromEntries(
      Object.entries(data.prices).map(([id, q]) => [id, { usd: q.usd, change24h: q.change_24h }]),
    );
    return { prices, stale: data.stale };
  }

  getHistory(id: string, days: number) {
    return this.get<PriceHistory>(`/history/${encodeURIComponent(id)}?days=${days}`);
  }
}

/** 400 unless the coin exists in the price-service catalogue. */
export async function assertKnownCoin(prices: PriceClient, coinId: string): Promise<CoinDto> {
  const { coins } = await prices.getCoins();
  const coin = coins.find((c) => c.id === coinId);
  if (!coin) throw badRequest(`Unknown coin: ${coinId}`);
  return coin;
}

/** Prices, or an empty stale result when the price-service is down (pages keep working). */
export async function pricesOrEmpty(prices: PriceClient, ids: string[]) {
  try {
    return await prices.getPrices(ids);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 502) return { prices: {} as Record<string, Quote>, stale: true };
    throw err;
  }
}
```

- [ ] **Step 4: Run unit tests**

Run: `cd services/api && npm test`
Expected: PASS.

- [ ] **Step 5: Add `prices` to Deps and the fake to test helpers**

In `services/api/src/deps.ts`: add `import { HttpPriceClient, type PriceClient } from './lib/priceClient.js';`, add `prices: PriceClient;` to `Deps`, and `prices: new HttpPriceClient(config.PRICE_SERVICE_URL),` in `createDeps`.

In `services/api/test/integration/helpers.ts` add:
```ts
import { HttpError, notFound } from '../../src/lib/errors.js';
import type { CoinDto, PriceClient, Quote } from '../../src/lib/priceClient.js';

export class FakePriceClient implements PriceClient {
  down = false;
  quotes: Record<string, Quote> = {
    bitcoin: { usd: 50000, change24h: 2 },
    ethereum: { usd: 3000, change24h: -1 },
    solana: { usd: 100, change24h: 5 },
  };

  private check() {
    if (this.down) throw new HttpError(502, 'price_service_unavailable', 'Price service is unavailable');
  }

  async getCoins() {
    this.check();
    const coins: CoinDto[] = Object.entries(this.quotes).map(([id, q]) => ({
      id, symbol: id.slice(0, 3), name: id[0].toUpperCase() + id.slice(1), image: null,
      currentPrice: q.usd, change24h: q.change24h, marketCap: q.usd * 1e6,
    }));
    return { coins, stale: false };
  }

  async getPrices(ids: string[]) {
    this.check();
    return { prices: Object.fromEntries(ids.filter((i) => i in this.quotes).map((i) => [i, this.quotes[i]])), stale: false };
  }

  async getHistory(id: string, days: number) {
    this.check();
    if (!(id in this.quotes)) throw notFound('Coin');
    return { id, days, points: [[1, 1], [2, 2]] as [number, number][], stale: false };
  }
}
```
and change `TestApp` / `buildTestApp`:
```ts
export interface TestApp {
  app: FastifyInstance;
  deps: Deps;
  prices: FakePriceClient;
  close: () => Promise<void>;
}

export async function buildTestApp(): Promise<TestApp> {
  const config = loadConfig(TEST_ENV);
  const prices = new FakePriceClient();
  const deps: Deps = { config, db: createDb(config.DATABASE_URL), redis: new Redis(config.REDIS_URL), prices };
  await resetState(deps);
  const app = buildApp(deps);
  await app.ready();
  return {
    app,
    deps,
    prices,
    close: async () => {
      await app.close();
      await closeDeps(deps);
    },
  };
}
```

- [ ] **Step 6: Write failing integration tests**

`services/api/test/integration/market.test.ts`
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, registerUser, resetState, type TestApp } from './helpers.js';

describe('market, watchlist, alerts, notifications', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await buildTestApp();
  });
  beforeEach(async () => {
    await resetState(t.deps);
    t.prices.down = false;
  });
  afterAll(() => t.close());

  describe('market (public)', () => {
    it('lists coins without auth', async () => {
      const res = await t.app.inject({ method: 'GET', url: '/api/market/coins' });
      expect(res.statusCode).toBe(200);
      expect(res.json().coins.map((c: { id: string }) => c.id)).toContain('bitcoin');
    });

    it('returns prices for ids', async () => {
      const res = await t.app.inject({ method: 'GET', url: '/api/market/prices?ids=bitcoin,ethereum' });
      expect(res.json().prices.bitcoin).toEqual({ usd: 50000, change24h: 2 });
    });

    it('validates history days and unknown coins', async () => {
      expect((await t.app.inject({ method: 'GET', url: '/api/market/history/bitcoin?days=2' })).statusCode).toBe(400);
      expect((await t.app.inject({ method: 'GET', url: '/api/market/history/nope?days=7' })).statusCode).toBe(404);
      expect((await t.app.inject({ method: 'GET', url: '/api/market/history/bitcoin?days=30' })).statusCode).toBe(200);
    });

    it('returns 502 when the price service is down', async () => {
      t.prices.down = true;
      const res = await t.app.inject({ method: 'GET', url: '/api/market/coins' });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('price_service_unavailable');
    });
  });

  describe('watchlist', () => {
    it('adds, lists (with prices) and removes coins; adding twice is idempotent', async () => {
      const { headers } = await registerUser(t.app);
      expect((await t.app.inject({ method: 'POST', url: '/api/watchlist', headers, payload: { coinId: 'bitcoin' } })).statusCode).toBe(201);
      expect((await t.app.inject({ method: 'POST', url: '/api/watchlist', headers, payload: { coinId: 'bitcoin' } })).statusCode).toBe(201);
      const list = await t.app.inject({ method: 'GET', url: '/api/watchlist', headers });
      expect(list.json().items).toHaveLength(1);
      expect(list.json().items[0]).toMatchObject({ id: 'bitcoin', currentPrice: 50000 });
      expect((await t.app.inject({ method: 'DELETE', url: '/api/watchlist/bitcoin', headers })).statusCode).toBe(204);
      expect((await t.app.inject({ method: 'GET', url: '/api/watchlist', headers })).json().items).toHaveLength(0);
    });

    it('rejects unknown coins', async () => {
      const { headers } = await registerUser(t.app);
      const res = await t.app.inject({ method: 'POST', url: '/api/watchlist', headers, payload: { coinId: 'nope' } });
      expect(res.statusCode).toBe(400);
    });

    it('is private per user', async () => {
      const alice = await registerUser(t.app, 'alice@example.com');
      const bob = await registerUser(t.app, 'bob@example.com');
      await t.app.inject({ method: 'POST', url: '/api/watchlist', headers: alice.headers, payload: { coinId: 'bitcoin' } });
      const res = await t.app.inject({ method: 'GET', url: '/api/watchlist', headers: bob.headers });
      expect(res.json().items).toHaveLength(0);
    });
  });

  describe('alerts', () => {
    it('creates, lists with current price, and deletes', async () => {
      const { headers } = await registerUser(t.app);
      const created = await t.app.inject({
        method: 'POST', url: '/api/alerts', headers,
        payload: { coinId: 'bitcoin', direction: 'above', targetPrice: 60000 },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ coinId: 'bitcoin', direction: 'above', targetPrice: 60000, active: true });
      const list = await t.app.inject({ method: 'GET', url: '/api/alerts', headers });
      expect(list.json().items[0].currentPrice).toBe(50000);
      const del = await t.app.inject({ method: 'DELETE', url: `/api/alerts/${created.json().id}`, headers });
      expect(del.statusCode).toBe(204);
    });

    it('validates direction and target price', async () => {
      const { headers } = await registerUser(t.app);
      const bad1 = await t.app.inject({ method: 'POST', url: '/api/alerts', headers, payload: { coinId: 'bitcoin', direction: 'sideways', targetPrice: 1 } });
      const bad2 = await t.app.inject({ method: 'POST', url: '/api/alerts', headers, payload: { coinId: 'bitcoin', direction: 'above', targetPrice: 0 } });
      expect([bad1.statusCode, bad2.statusCode]).toEqual([400, 400]);
    });

    it("cannot delete another user's alert", async () => {
      const alice = await registerUser(t.app, 'alice@example.com');
      const bob = await registerUser(t.app, 'bob@example.com');
      const created = await t.app.inject({ method: 'POST', url: '/api/alerts', headers: alice.headers, payload: { coinId: 'bitcoin', direction: 'below', targetPrice: 1 } });
      const res = await t.app.inject({ method: 'DELETE', url: `/api/alerts/${created.json().id}`, headers: bob.headers });
      expect(res.statusCode).toBe(404);
    });

    it('still lists alerts when the price service is down', async () => {
      const { headers } = await registerUser(t.app);
      await t.app.inject({ method: 'POST', url: '/api/alerts', headers, payload: { coinId: 'bitcoin', direction: 'above', targetPrice: 1 } });
      t.prices.down = true;
      const res = await t.app.inject({ method: 'GET', url: '/api/alerts', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ stale: true, items: [{ currentPrice: null }] });
    });
  });

  describe('notifications', () => {
    it('lists, counts unread, marks one and all as read; other users get 404', async () => {
      const alice = await registerUser(t.app, 'alice@example.com');
      const bob = await registerUser(t.app, 'bob@example.com');
      const [n1] = await t.deps.db
        .insertInto('notifications')
        .values([
          { user_id: alice.userId, title: 'one', body: 'b' },
          { user_id: alice.userId, title: 'two', body: 'b' },
        ])
        .returning('id')
        .execute();

      let res = await t.app.inject({ method: 'GET', url: '/api/notifications', headers: alice.headers });
      expect(res.json()).toMatchObject({ unreadCount: 2 });
      expect(res.json().items).toHaveLength(2);

      expect((await t.app.inject({ method: 'POST', url: `/api/notifications/${n1.id}/read`, headers: bob.headers })).statusCode).toBe(404);
      expect((await t.app.inject({ method: 'POST', url: `/api/notifications/${n1.id}/read`, headers: alice.headers })).statusCode).toBe(204);
      res = await t.app.inject({ method: 'GET', url: '/api/notifications?unread=true', headers: alice.headers });
      expect(res.json()).toMatchObject({ unreadCount: 1 });
      expect(res.json().items).toHaveLength(1);

      await t.app.inject({ method: 'POST', url: '/api/notifications/read-all', headers: alice.headers });
      res = await t.app.inject({ method: 'GET', url: '/api/notifications', headers: alice.headers });
      expect(res.json().unreadCount).toBe(0);
    });
  });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `cd services/api && npm run test:integration -- market`
Expected: FAIL. The routes return 404.

- [ ] **Step 8: Implement the routes**

`services/api/src/routes/market.ts`
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../lib/validation.js';
import type { RouteContext } from './context.js';

const idsQuery = z.object({ ids: z.string().min(1) });
const historyQuery = z.object({ days: z.coerce.number().pipe(z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(365)])).default(7) });

export function marketRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  app.get('/api/market/coins', async () => deps.prices.getCoins());

  app.get('/api/market/prices', async (request) => {
    const { ids } = parse(idsQuery, request.query);
    return deps.prices.getPrices(ids.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  });

  app.get('/api/market/history/:id', async (request) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(100) }), request.params);
    const { days } = parse(historyQuery, request.query);
    return deps.prices.getHistory(id, days);
  });
}
```

`services/api/src/routes/watchlist.ts`
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertKnownCoin } from '../lib/priceClient.js';
import { parse } from '../lib/validation.js';
import type { RouteContext } from './context.js';

export function watchlistRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const { db, prices } = deps;

  app.get('/api/watchlist', async (request) => {
    const rows = await db.selectFrom('watchlist').select('coin_id').where('user_id', '=', request.userId).orderBy('created_at').execute();
    const { coins, stale } = await prices.getCoins();
    const byId = new Map(coins.map((c) => [c.id, c]));
    const items = rows.map((r) => byId.get(r.coin_id)).filter((c) => c !== undefined);
    return { items, stale };
  });

  app.post('/api/watchlist', async (request, reply) => {
    const { coinId } = parse(z.object({ coinId: z.string().min(1).max(100) }), request.body);
    await assertKnownCoin(prices, coinId);
    await db.insertInto('watchlist').values({ user_id: request.userId, coin_id: coinId }).onConflict((oc) => oc.doNothing()).execute();
    return reply.status(201).send({ coinId });
  });

  app.delete('/api/watchlist/:coinId', async (request, reply) => {
    const { coinId } = parse(z.object({ coinId: z.string().min(1).max(100) }), request.params);
    await db.deleteFrom('watchlist').where('user_id', '=', request.userId).where('coin_id', '=', coinId).execute();
    return reply.status(204).send();
  });
}
```

`services/api/src/routes/alerts.ts`
```ts
import type { FastifyInstance } from 'fastify';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { AlertsTable } from '../db/database.js';
import { notFound } from '../lib/errors.js';
import { assertKnownCoin, pricesOrEmpty } from '../lib/priceClient.js';
import { parse, uuidParam } from '../lib/validation.js';
import type { RouteContext } from './context.js';

const createAlert = z.object({
  coinId: z.string().min(1).max(100),
  direction: z.enum(['above', 'below']),
  targetPrice: z.coerce.number().positive(),
});

const toAlertDto = (a: Selectable<AlertsTable>, currentPrice: number | null) => ({
  id: a.id,
  coinId: a.coin_id,
  direction: a.direction,
  targetPrice: Number(a.target_price),
  active: a.active,
  triggeredAt: a.triggered_at,
  createdAt: a.created_at,
  currentPrice,
});

export function alertRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const { db, prices } = deps;

  app.get('/api/alerts', async (request) => {
    const alerts = await db.selectFrom('alerts').selectAll().where('user_id', '=', request.userId).orderBy('created_at', 'desc').execute();
    const quotes = await pricesOrEmpty(prices, alerts.map((a) => a.coin_id));
    return { items: alerts.map((a) => toAlertDto(a, quotes.prices[a.coin_id]?.usd ?? null)), stale: quotes.stale };
  });

  app.post('/api/alerts', async (request, reply) => {
    const body = parse(createAlert, request.body);
    const coin = await assertKnownCoin(prices, body.coinId);
    const alert = await db
      .insertInto('alerts')
      .values({ user_id: request.userId, coin_id: body.coinId, direction: body.direction, target_price: body.targetPrice })
      .returningAll()
      .executeTakeFirstOrThrow();
    return reply.status(201).send(toAlertDto(alert, coin.currentPrice));
  });

  app.delete('/api/alerts/:id', async (request, reply) => {
    const { id } = parse(uuidParam, request.params);
    const result = await db.deleteFrom('alerts').where('id', '=', id).where('user_id', '=', request.userId).executeTakeFirst();
    if (result.numDeletedRows === 0n) throw notFound('Alert');
    return reply.status(204).send();
  });
}
```

`services/api/src/routes/notifications.ts`
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../lib/errors.js';
import { parse, uuidParam } from '../lib/validation.js';
import type { RouteContext } from './context.js';

export function notificationRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const { db } = deps;

  app.get('/api/notifications', async (request) => {
    const { unread } = parse(z.object({ unread: z.enum(['true', 'false']).optional() }), request.query);
    let query = db
      .selectFrom('notifications')
      .select(['id', 'title', 'body', 'read_at as readAt', 'created_at as createdAt'])
      .where('user_id', '=', request.userId)
      .orderBy('created_at', 'desc')
      .limit(50);
    if (unread === 'true') query = query.where('read_at', 'is', null);
    const items = await query.execute();
    const { count } = await db
      .selectFrom('notifications')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('user_id', '=', request.userId)
      .where('read_at', 'is', null)
      .executeTakeFirstOrThrow();
    return { items, unreadCount: Number(count) };
  });

  app.post('/api/notifications/:id/read', async (request, reply) => {
    const { id } = parse(uuidParam, request.params);
    const result = await db
      .updateTable('notifications')
      .set({ read_at: new Date() })
      .where('id', '=', id)
      .where('user_id', '=', request.userId)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) throw notFound('Notification');
    return reply.status(204).send();
  });

  app.post('/api/notifications/read-all', async (request, reply) => {
    await db.updateTable('notifications').set({ read_at: new Date() }).where('user_id', '=', request.userId).where('read_at', 'is', null).execute();
    return reply.status(204).send();
  });
}
```

In `services/api/src/app.ts`: add `marketRoutes(api, ctx);` to the public block, and `watchlistRoutes(secured, ctx); alertRoutes(secured, ctx); notificationRoutes(secured, ctx);` to the secured block, with matching imports.

- [ ] **Step 9: Run all api tests**

Run: `cd services/api && npm run lint && npm test && npm run test:integration`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add services/api
git commit -m "feat(api): price client, market proxy, watchlist, alerts, notifications"
```

---

### Task 8: api holdings calculation (average-cost method)

**Files:**
- Create: `services/api/src/lib/holdings.ts`
- Test: `services/api/test/unit/holdings.test.ts`

**Interfaces:**
- Consumes: `Quote` (Task 7).
- Produces:
  - `TxInput { coinId; type: 'buy'|'sell'; quantity: string|number; priceUsd: string|number; feeUsd: string|number; executedAt: Date }`.
  - `OversellError(coinId, available, requested)`.
  - `aggregatePositions(txs) -> Map<string, Position>` (chronological; buys before sells on equal timestamps; throws `OversellError`).
  - `computeHoldings(txs, prices) -> { holdings: Holding[]; totals: Totals }`.
  - `Holding { coinId, quantity, avgCostUsd, costBasisUsd, realizedPnlUsd, priceUsd, change24hPct, valueUsd, unrealizedPnlUsd, unrealizedPnlPct, allocationPct }` (price-dependent fields `null` when the price is missing). Money rounded to 2 dp.
  - `Totals { valueUsd, costBasisUsd, unrealizedPnlUsd, unrealizedPnlPct, realizedPnlUsd, change24hUsd, change24hPct, missingPrices: string[] }`.

- [ ] **Step 1: Write the failing tests**

`services/api/test/unit/holdings.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { aggregatePositions, computeHoldings, OversellError, type TxInput } from '../../src/lib/holdings.js';

let clock = 0;
const tx = (coinId: string, type: 'buy' | 'sell', quantity: string, priceUsd: string, feeUsd = '0', at?: number): TxInput => ({
  coinId, type, quantity, priceUsd, feeUsd, executedAt: new Date(at ?? ++clock * 1000),
});

describe('aggregatePositions', () => {
  it('includes fees in cost basis', () => {
    const p = aggregatePositions([tx('bitcoin', 'buy', '2', '100', '10')]).get('bitcoin')!;
    expect(p.quantity.toString()).toBe('2');
    expect(p.costBasis.toString()).toBe('210');
  });

  it('averages the cost of several buys', () => {
    const p = aggregatePositions([tx('bitcoin', 'buy', '1', '100'), tx('bitcoin', 'buy', '1', '200')]).get('bitcoin')!;
    expect(p.costBasis.dividedBy(p.quantity).toString()).toBe('150');
  });

  it('realises P/L on sells at average cost, net of fees', () => {
    const p = aggregatePositions([tx('bitcoin', 'buy', '2', '100'), tx('bitcoin', 'sell', '1', '150', '1')]).get('bitcoin')!;
    expect(p.realizedPnl.toString()).toBe('49');
    expect(p.quantity.toString()).toBe('1');
    expect(p.costBasis.toString()).toBe('100');
  });

  it('throws OversellError when selling more than held', () => {
    expect(() => aggregatePositions([tx('bitcoin', 'buy', '1', '100'), tx('bitcoin', 'sell', '1.5', '100')])).toThrow(OversellError);
  });

  it('throws when a sell is dated before the buy', () => {
    expect(() => aggregatePositions([tx('bitcoin', 'buy', '1', '100', '0', 5000), tx('bitcoin', 'sell', '1', '100', '0', 1000)])).toThrow(OversellError);
  });

  it('applies buys before sells on the same timestamp', () => {
    expect(() => aggregatePositions([tx('bitcoin', 'sell', '1', '100', '0', 7000), tx('bitcoin', 'buy', '1', '100', '0', 7000)])).not.toThrow();
  });

  it('uses exact decimal arithmetic (0.1 + 0.2 - 0.3 = 0)', () => {
    const p = aggregatePositions([
      tx('ethereum', 'buy', '0.1', '10'),
      tx('ethereum', 'buy', '0.2', '10'),
      tx('ethereum', 'sell', '0.3', '10'),
    ]).get('ethereum')!;
    expect(p.quantity.isZero()).toBe(true);
    expect(p.costBasis.isZero()).toBe(true);
  });
});

describe('computeHoldings', () => {
  const prices = { bitcoin: { usd: 50000, change24h: 25 }, ethereum: { usd: 3000, change24h: 0 } };

  it('computes value, unrealized P/L and allocation', () => {
    const { holdings, totals } = computeHoldings(
      [tx('bitcoin', 'buy', '1', '40000'), tx('ethereum', 'buy', '10', '2000')],
      prices,
    );
    expect(holdings.map((h) => [h.coinId, h.valueUsd, h.allocationPct])).toEqual([
      ['bitcoin', 50000, 62.5],
      ['ethereum', 30000, 37.5],
    ]);
    expect(totals).toMatchObject({ valueUsd: 80000, costBasisUsd: 60000, unrealizedPnlUsd: 20000, unrealizedPnlPct: 33.33 });
  });

  it('computes the 24h change from each coin change', () => {
    const { totals } = computeHoldings([tx('bitcoin', 'buy', '1', '40000')], prices);
    expect(totals.change24hUsd).toBe(10000);
    expect(totals.change24hPct).toBe(25);
  });

  it('drops closed positions from holdings but keeps realized P/L in totals', () => {
    const { holdings, totals } = computeHoldings([tx('bitcoin', 'buy', '1', '40000'), tx('bitcoin', 'sell', '1', '45000')], prices);
    expect(holdings).toHaveLength(0);
    expect(totals.realizedPnlUsd).toBe(5000);
  });

  it('reports missing prices without crashing', () => {
    const { holdings, totals } = computeHoldings([tx('solana', 'buy', '3', '100'), tx('bitcoin', 'buy', '1', '40000')], prices);
    const sol = holdings.find((h) => h.coinId === 'solana')!;
    expect(sol).toMatchObject({ valueUsd: null, priceUsd: null, unrealizedPnlUsd: null, costBasisUsd: 300 });
    expect(totals.valueUsd).toBe(50000);
    expect(totals.missingPrices).toEqual(['solana']);
  });

  it('handles an empty portfolio', () => {
    expect(computeHoldings([], prices).totals).toEqual({
      valueUsd: 0, costBasisUsd: 0, unrealizedPnlUsd: 0, unrealizedPnlPct: null,
      realizedPnlUsd: 0, change24hUsd: 0, change24hPct: null, missingPrices: [],
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd services/api && npm test -- holdings`
Expected: FAIL `Cannot find module '../../src/lib/holdings.js'`

- [ ] **Step 3: Implement**

`services/api/src/lib/holdings.ts`
```ts
import Decimal from 'decimal.js';
import type { Quote } from './priceClient.js';

export interface TxInput {
  coinId: string;
  type: 'buy' | 'sell';
  quantity: string | number;
  priceUsd: string | number;
  feeUsd: string | number;
  executedAt: Date;
}

export interface Position {
  coinId: string;
  quantity: Decimal;
  costBasis: Decimal;
  realizedPnl: Decimal;
}

export interface Holding {
  coinId: string;
  quantity: number;
  avgCostUsd: number;
  costBasisUsd: number;
  realizedPnlUsd: number;
  priceUsd: number | null;
  change24hPct: number | null;
  valueUsd: number | null;
  unrealizedPnlUsd: number | null;
  unrealizedPnlPct: number | null;
  allocationPct: number | null;
}

export interface Totals {
  valueUsd: number;
  costBasisUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number | null;
  realizedPnlUsd: number;
  change24hUsd: number;
  change24hPct: number | null;
  missingPrices: string[];
}

export class OversellError extends Error {
  constructor(public readonly coinId: string, public readonly available: string, public readonly requested: string) {
    super(`Cannot sell ${requested} ${coinId}: only ${available} held at that time`);
  }
}

const money = (d: Decimal) => d.toDecimalPlaces(2).toNumber();
const typeRank = (t: TxInput['type']) => (t === 'buy' ? 0 : 1);

/** Replays transactions in time order using the average-cost method. */
export function aggregatePositions(txs: TxInput[]): Map<string, Position> {
  const sorted = [...txs].sort(
    (a, b) => a.executedAt.getTime() - b.executedAt.getTime() || typeRank(a.type) - typeRank(b.type),
  );
  const positions = new Map<string, Position>();
  for (const tx of sorted) {
    const p = positions.get(tx.coinId) ?? {
      coinId: tx.coinId, quantity: new Decimal(0), costBasis: new Decimal(0), realizedPnl: new Decimal(0),
    };
    const qty = new Decimal(tx.quantity);
    const price = new Decimal(tx.priceUsd);
    const fee = new Decimal(tx.feeUsd);
    if (tx.type === 'buy') {
      p.quantity = p.quantity.plus(qty);
      p.costBasis = p.costBasis.plus(qty.times(price)).plus(fee);
    } else {
      if (qty.greaterThan(p.quantity)) throw new OversellError(tx.coinId, p.quantity.toString(), qty.toString());
      const costRemoved = p.costBasis.dividedBy(p.quantity).times(qty);
      p.realizedPnl = p.realizedPnl.plus(qty.times(price)).minus(fee).minus(costRemoved);
      p.quantity = p.quantity.minus(qty);
      p.costBasis = p.quantity.isZero() ? new Decimal(0) : p.costBasis.minus(costRemoved);
    }
    positions.set(tx.coinId, p);
  }
  return positions;
}

export function computeHoldings(txs: TxInput[], prices: Record<string, Quote>): { holdings: Holding[]; totals: Totals } {
  const positions = [...aggregatePositions(txs).values()];
  let value = new Decimal(0);
  let pricedCost = new Decimal(0);
  let change24h = new Decimal(0);
  const missingPrices: string[] = [];

  const open = positions.filter((p) => p.quantity.greaterThan(0));
  const rows = open.map((p) => {
    const quote = prices[p.coinId];
    const base = {
      coinId: p.coinId,
      quantity: p.quantity.toNumber(),
      avgCostUsd: money(p.costBasis.dividedBy(p.quantity)),
      costBasisUsd: money(p.costBasis),
      realizedPnlUsd: money(p.realizedPnl),
    };
    if (!quote) {
      missingPrices.push(p.coinId);
      return { ...base, priceUsd: null, change24hPct: null, valueD: null as Decimal | null, unrealizedPnlUsd: null, unrealizedPnlPct: null };
    }
    const valueD = p.quantity.times(quote.usd);
    const unrealized = valueD.minus(p.costBasis);
    const previous = valueD.dividedBy(1 + quote.change24h / 100);
    value = value.plus(valueD);
    pricedCost = pricedCost.plus(p.costBasis);
    change24h = change24h.plus(valueD.minus(previous));
    return {
      ...base,
      priceUsd: quote.usd,
      change24hPct: quote.change24h,
      valueD,
      unrealizedPnlUsd: money(unrealized),
      unrealizedPnlPct: p.costBasis.isZero() ? null : money(unrealized.dividedBy(p.costBasis).times(100)),
    };
  });

  const holdings: Holding[] = rows
    .map(({ valueD, ...row }) => ({
      ...row,
      valueUsd: valueD ? money(valueD) : null,
      allocationPct: valueD && !value.isZero() ? money(valueD.dividedBy(value).times(100)) : null,
    }))
    .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));

  const unrealizedTotal = value.minus(pricedCost);
  const previousTotal = value.minus(change24h);
  const totals: Totals = {
    valueUsd: money(value),
    costBasisUsd: money(pricedCost),
    unrealizedPnlUsd: money(unrealizedTotal),
    unrealizedPnlPct: pricedCost.isZero() ? null : money(unrealizedTotal.dividedBy(pricedCost).times(100)),
    realizedPnlUsd: money(positions.reduce((sum, p) => sum.plus(p.realizedPnl), new Decimal(0))),
    change24hUsd: money(change24h),
    change24hPct: previousTotal.greaterThan(0) ? money(change24h.dividedBy(previousTotal).times(100)) : null,
    missingPrices,
  };
  return { holdings, totals };
}
```

- [ ] **Step 4: Run tests**

Run: `cd services/api && npm run lint && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add services/api
git commit -m "feat(api): average-cost holdings and P/L calculation"
```

---
### Task 9: api portfolios, transactions, holdings, snapshots, dashboard

**Files:**
- Create: `services/api/src/lib/portfolios.ts`, `src/routes/{portfolios.ts,transactions.ts,dashboard.ts}`
- Modify: `services/api/src/app.ts`
- Test: `services/api/test/integration/portfolios.test.ts`

**Interfaces:**
- Consumes: `computeHoldings`, `aggregatePositions`, `OversellError`, `TxInput` (Task 8); `assertKnownCoin`, `pricesOrEmpty` (Task 7); `parse`, `uuidParam`, `decimalString`, `isUniqueViolation` (Task 5).
- Produces:
  - `getOwnedPortfolio(db, userId, portfolioId)` → row or throws 404 (used again by jobs in Task 10).
  - `loadTransactions(db, { userId, portfolioId?, coinId? }) -> TxRow[]`, `toTxInput(row)`, `toTxDto(row)`.
  - `TxDto { id, portfolioId, coinId, type, quantity, priceUsd, feeUsd, totalUsd, executedAt, note }` (numbers).
  - HTTP (secured):
    - `GET /api/portfolios` → `{ items: [{id, name, createdAt, totals}], stale }`
    - `POST /api/portfolios {name}` → 201 `{id, name, createdAt}` | 409 duplicate name
    - `GET|PATCH|DELETE /api/portfolios/:id` (PATCH `{name}`)
    - `GET /api/portfolios/:id/holdings` → `{ holdings, totals, stale }`
    - `GET /api/portfolios/:id/snapshots?days=30` → `{ points: [{date, valueUsd}] }`
    - `GET /api/portfolios/:id/transactions` → `{ items: TxDto[] }` (newest first)
    - `POST /api/portfolios/:id/transactions {coinId, type, quantity, priceUsd, feeUsd?, executedAt?, note?}` → 201 TxDto | 422 `insufficient_holdings` | 400
    - `DELETE /api/transactions/:id` → 204 | 404 | 422 `insufficient_holdings`
    - `GET /api/dashboard?days=30` → `{ totals, holdings, portfolios: [{id,name,totals}], history: [{date, valueUsd}], stale }`

- [ ] **Step 1: Write the failing integration tests**

`services/api/test/integration/portfolios.test.ts`
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, registerUser, resetState, type TestApp } from './helpers.js';

describe('portfolios and transactions', () => {
  let t: TestApp;
  let alice: Awaited<ReturnType<typeof registerUser>>;
  let bob: Awaited<ReturnType<typeof registerUser>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });
  beforeEach(async () => {
    await resetState(t.deps);
    t.prices.down = false;
    alice = await registerUser(t.app, 'alice@example.com');
    bob = await registerUser(t.app, 'bob@example.com');
  });
  afterAll(() => t.close());

  const createPortfolio = async (headers = alice.headers, name = 'Main') => {
    const res = await t.app.inject({ method: 'POST', url: '/api/portfolios', headers, payload: { name } });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };
  const addTx = (portfolioId: string, payload: Record<string, unknown>, headers = alice.headers) =>
    t.app.inject({ method: 'POST', url: `/api/portfolios/${portfolioId}/transactions`, headers, payload });

  it('creates, lists, renames and deletes portfolios', async () => {
    const id = await createPortfolio();
    expect((await t.app.inject({ method: 'GET', url: '/api/portfolios', headers: alice.headers })).json().items).toHaveLength(1);
    const renamed = await t.app.inject({ method: 'PATCH', url: `/api/portfolios/${id}`, headers: alice.headers, payload: { name: 'Renamed' } });
    expect(renamed.json().name).toBe('Renamed');
    expect((await t.app.inject({ method: 'DELETE', url: `/api/portfolios/${id}`, headers: alice.headers })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: `/api/portfolios/${id}`, headers: alice.headers })).statusCode).toBe(404);
  });

  it('rejects duplicate portfolio names for the same user with 409', async () => {
    await createPortfolio();
    const res = await t.app.inject({ method: 'POST', url: '/api/portfolios', headers: alice.headers, payload: { name: 'Main' } });
    expect(res.statusCode).toBe(409);
    await createPortfolio(bob.headers, 'Main'); // other users may reuse the name
  });

  it("hides other users' portfolios behind 404", async () => {
    const id = await createPortfolio();
    for (const [method, url] of [
      ['GET', `/api/portfolios/${id}`],
      ['PATCH', `/api/portfolios/${id}`],
      ['DELETE', `/api/portfolios/${id}`],
      ['GET', `/api/portfolios/${id}/holdings`],
      ['GET', `/api/portfolios/${id}/transactions`],
      ['GET', `/api/portfolios/${id}/snapshots`],
    ] as const) {
      const res = await t.app.inject({ method, url, headers: bob.headers, payload: method === 'PATCH' ? { name: 'x' } : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await addTx(id, { coinId: 'bitcoin', type: 'buy', quantity: '1', priceUsd: '1' }, bob.headers)).statusCode).toBe(404);
  });

  it('returns 400 for a malformed id', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/portfolios/not-a-uuid', headers: alice.headers })).statusCode).toBe(400);
  });

  it('computes holdings from transactions', async () => {
    const id = await createPortfolio();
    expect((await addTx(id, { coinId: 'bitcoin', type: 'buy', quantity: '1', priceUsd: '40000', feeUsd: '0' })).statusCode).toBe(201);
    const res = await t.app.inject({ method: 'GET', url: `/api/portfolios/${id}/holdings`, headers: alice.headers });
    expect(res.json().holdings[0]).toMatchObject({ coinId: 'bitcoin', quantity: 1, valueUsd: 50000, unrealizedPnlUsd: 10000 });
    expect(res.json().totals).toMatchObject({ valueUsd: 50000, costBasisUsd: 40000 });
    expect(res.json().stale).toBe(false);
  });

  it('rejects overselling with 422 insufficient_holdings', async () => {
    const id = await createPortfolio();
    await addTx(id, { coinId: 'bitcoin', type: 'buy', quantity: '1', priceUsd: '40000', executedAt: '2024-01-02T00:00:00Z' });
    const over = await addTx(id, { coinId: 'bitcoin', type: 'sell', quantity: '2', priceUsd: '50000' });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('insufficient_holdings');
    const early = await addTx(id, { coinId: 'bitcoin', type: 'sell', quantity: '1', priceUsd: '50000', executedAt: '2024-01-01T00:00:00Z' });
    expect(early.statusCode).toBe(422);
  });

  it('validates transaction input', async () => {
    const id = await createPortfolio();
    expect((await addTx(id, { coinId: 'nope', type: 'buy', quantity: '1', priceUsd: '1' })).statusCode).toBe(400);
    expect((await addTx(id, { coinId: 'bitcoin', type: 'buy', quantity: '0', priceUsd: '1' })).statusCode).toBe(400);
    expect((await addTx(id, { coinId: 'bitcoin', type: 'buy', quantity: '-1', priceUsd: '1' })).statusCode).toBe(400);
    expect((await addTx(id, { coinId: 'bitcoin', type: 'hold', quantity: '1', priceUsd: '1' })).statusCode).toBe(400);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await addTx(id, { coinId: 'bitcoin', type: 'buy', quantity: '1', priceUsd: '1', executedAt: future })).statusCode).toBe(400);
  });

  it('refuses to delete a buy that a later sell depends on, allows deleting the sell', async () => {
    const id = await createPortfolio();
    const buy = await addTx(id, { coinId: 'bitcoin', type: 'buy', quantity: '1', priceUsd: '40000', executedAt: '2024-01-01T00:00:00Z' });
    const sell = await addTx(id, { coinId: 'bitcoin', type: 'sell', quantity: '1', priceUsd: '45000', executedAt: '2024-02-01T00:00:00Z' });
    const delBuy = await t.app.inject({ method: 'DELETE', url: `/api/transactions/${buy.json().id}`, headers: alice.headers });
    expect(delBuy.statusCode).toBe(422);
    const delSell = await t.app.inject({ method: 'DELETE', url: `/api/transactions/${sell.json().id}`, headers: alice.headers });
    expect(delSell.statusCode).toBe(204);
  });

  it("cannot delete another user's transaction", async () => {
    const id = await createPortfolio();
    const buy = await addTx(id, { coinId: 'bitcoin', type: 'buy', quantity: '1', priceUsd: '1' });
    const res = await t.app.inject({ method: 'DELETE', url: `/api/transactions/${buy.json().id}`, headers: bob.headers });
    expect(res.statusCode).toBe(404);
  });

  it('lists transactions newest first with totals', async () => {
    const id = await createPortfolio();
    await addTx(id, { coinId: 'bitcoin', type: 'buy', quantity: '0.5', priceUsd: '40000', feeUsd: '10', executedAt: '2024-01-01T00:00:00Z' });
    await addTx(id, { coinId: 'ethereum', type: 'buy', quantity: '2', priceUsd: '2000', executedAt: '2024-03-01T00:00:00Z' });
    const items = (await t.app.inject({ method: 'GET', url: `/api/portfolios/${id}/transactions`, headers: alice.headers })).json().items;
    expect(items.map((i: { coinId: string }) => i.coinId)).toEqual(['ethereum', 'bitcoin']);
    expect(items[1]).toMatchObject({ quantity: 0.5, priceUsd: 40000, feeUsd: 10, totalUsd: 20010 });
  });

  it('still returns holdings when the price service is down', async () => {
    const id = await createPortfolio();
    await addTx(id, { coinId: 'bitcoin', type: 'buy', quantity: '1', priceUsd: '40000' });
    t.prices.down = true;
    const res = await t.app.inject({ method: 'GET', url: `/api/portfolios/${id}/holdings`, headers: alice.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stale: true, totals: { missingPrices: ['bitcoin'] }, holdings: [{ valueUsd: null }] });
  });

  it('returns snapshots in date order', async () => {
    const id = await createPortfolio();
    const today = new Date();
    const day = (n: number) => new Date(today.getTime() - n * 86_400_000).toISOString().slice(0, 10);
    await t.deps.db.insertInto('portfolio_snapshots').values([
      { portfolio_id: id, date: day(1), value_usd: '200' },
      { portfolio_id: id, date: day(2), value_usd: '100' },
      { portfolio_id: id, date: day(90), value_usd: '1' },
    ]).execute();
    const res = await t.app.inject({ method: 'GET', url: `/api/portfolios/${id}/snapshots?days=30`, headers: alice.headers });
    expect(res.json().points).toEqual([{ date: day(2), valueUsd: 100 }, { date: day(1), valueUsd: 200 }]);
  });

  it('dashboard aggregates all portfolios and sums history by date', async () => {
    const p1 = await createPortfolio(alice.headers, 'One');
    const p2 = await createPortfolio(alice.headers, 'Two');
    await addTx(p1, { coinId: 'bitcoin', type: 'buy', quantity: '1', priceUsd: '40000' });
    await addTx(p2, { coinId: 'bitcoin', type: 'buy', quantity: '1', priceUsd: '45000' });
    await addTx(p2, { coinId: 'ethereum', type: 'buy', quantity: '10', priceUsd: '2000' });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await t.deps.db.insertInto('portfolio_snapshots').values([
      { portfolio_id: p1, date: yesterday, value_usd: '10' },
      { portfolio_id: p2, date: yesterday, value_usd: '5' },
    ]).execute();

    const res = (await t.app.inject({ method: 'GET', url: '/api/dashboard', headers: alice.headers })).json();
    expect(res.totals.valueUsd).toBe(130000);
    expect(res.holdings.find((h: { coinId: string }) => h.coinId === 'bitcoin').quantity).toBe(2);
    expect(res.portfolios.map((p: { name: string }) => p.name).sort()).toEqual(['One', 'Two']);
    expect(res.history).toEqual([{ date: yesterday, valueUsd: 15 }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd services/api && npm run test:integration -- portfolios`
Expected: FAIL. `POST /api/portfolios` returns 404.

- [ ] **Step 3: Implement shared portfolio helpers**

`services/api/src/lib/portfolios.ts`
```ts
import type { Kysely, Selectable } from 'kysely';
import type { DB, TransactionsTable } from '../db/database.js';
import { notFound } from './errors.js';
import type { TxInput } from './holdings.js';

export type TxRow = Selectable<TransactionsTable>;

/** Throws 404 for a missing portfolio AND for someone else's portfolio (no information leak). */
export async function getOwnedPortfolio(db: Kysely<DB>, userId: string, portfolioId: string) {
  const portfolio = await db
    .selectFrom('portfolios')
    .selectAll()
    .where('id', '=', portfolioId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!portfolio) throw notFound('Portfolio');
  return portfolio;
}

export async function loadTransactions(
  db: Kysely<DB>,
  filter: { userId: string; portfolioId?: string; coinId?: string },
): Promise<TxRow[]> {
  let query = db
    .selectFrom('transactions as t')
    .innerJoin('portfolios as p', 'p.id', 't.portfolio_id')
    .selectAll('t')
    .where('p.user_id', '=', filter.userId);
  if (filter.portfolioId) query = query.where('t.portfolio_id', '=', filter.portfolioId);
  if (filter.coinId) query = query.where('t.coin_id', '=', filter.coinId);
  return query.orderBy('t.executed_at', 'desc').orderBy('t.created_at', 'desc').execute();
}

export const toTxInput = (row: TxRow): TxInput => ({
  coinId: row.coin_id,
  type: row.type,
  quantity: row.quantity,
  priceUsd: row.price_usd,
  feeUsd: row.fee_usd,
  executedAt: row.executed_at,
});

export const toTxDto = (row: TxRow) => ({
  id: row.id,
  portfolioId: row.portfolio_id,
  coinId: row.coin_id,
  type: row.type,
  quantity: Number(row.quantity),
  priceUsd: Number(row.price_usd),
  feeUsd: Number(row.fee_usd),
  totalUsd: Math.round((Number(row.quantity) * Number(row.price_usd) + Number(row.fee_usd)) * 100) / 100,
  executedAt: row.executed_at,
  note: row.note,
});
```

- [ ] **Step 4: Implement portfolio, transaction and dashboard routes**

`services/api/src/routes/portfolios.ts`
```ts
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { conflict, isUniqueViolation } from '../lib/errors.js';
import { computeHoldings } from '../lib/holdings.js';
import { getOwnedPortfolio, loadTransactions, toTxInput } from '../lib/portfolios.js';
import { pricesOrEmpty } from '../lib/priceClient.js';
import { parse, uuidParam } from '../lib/validation.js';
import type { RouteContext } from './context.js';

const portfolioBody = z.object({ name: z.string().trim().min(1).max(60) });
const daysQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

const toPortfolioDto = (p: { id: string; name: string; created_at: Date }) => ({ id: p.id, name: p.name, createdAt: p.created_at });

export function portfolioRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const { db, prices } = deps;

  app.get('/api/portfolios', async (request) => {
    const portfolios = await db.selectFrom('portfolios').selectAll().where('user_id', '=', request.userId).orderBy('created_at').execute();
    const txs = await loadTransactions(db, { userId: request.userId });
    const quotes = await pricesOrEmpty(prices, txs.map((tx) => tx.coin_id));
    const items = portfolios.map((p) => ({
      ...toPortfolioDto(p),
      totals: computeHoldings(txs.filter((tx) => tx.portfolio_id === p.id).map(toTxInput), quotes.prices).totals,
    }));
    return { items, stale: quotes.stale };
  });

  app.post('/api/portfolios', async (request, reply) => {
    const { name } = parse(portfolioBody, request.body);
    try {
      const portfolio = await db.insertInto('portfolios').values({ user_id: request.userId, name }).returningAll().executeTakeFirstOrThrow();
      return reply.status(201).send(toPortfolioDto(portfolio));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`You already have a portfolio named "${name}"`);
      throw err;
    }
  });

  app.get('/api/portfolios/:id', async (request) => {
    const { id } = parse(uuidParam, request.params);
    return toPortfolioDto(await getOwnedPortfolio(db, request.userId, id));
  });

  app.patch('/api/portfolios/:id', async (request) => {
    const { id } = parse(uuidParam, request.params);
    const { name } = parse(portfolioBody, request.body);
    await getOwnedPortfolio(db, request.userId, id);
    try {
      const updated = await db.updateTable('portfolios').set({ name }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      return toPortfolioDto(updated);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`You already have a portfolio named "${name}"`);
      throw err;
    }
  });

  app.delete('/api/portfolios/:id', async (request, reply) => {
    const { id } = parse(uuidParam, request.params);
    await getOwnedPortfolio(db, request.userId, id);
    await db.deleteFrom('portfolios').where('id', '=', id).execute();
    return reply.status(204).send();
  });

  app.get('/api/portfolios/:id/holdings', async (request) => {
    const { id } = parse(uuidParam, request.params);
    await getOwnedPortfolio(db, request.userId, id);
    const txs = await loadTransactions(db, { userId: request.userId, portfolioId: id });
    const quotes = await pricesOrEmpty(prices, txs.map((tx) => tx.coin_id));
    return { ...computeHoldings(txs.map(toTxInput), quotes.prices), stale: quotes.stale };
  });

  app.get('/api/portfolios/:id/snapshots', async (request) => {
    const { id } = parse(uuidParam, request.params);
    const { days } = parse(daysQuery, request.query);
    await getOwnedPortfolio(db, request.userId, id);
    const rows = await db
      .selectFrom('portfolio_snapshots')
      .select(['date', 'value_usd'])
      .where('portfolio_id', '=', id)
      .where('date', '>=', sql<string>`current_date - ${days}::int`)
      .orderBy('date')
      .execute();
    return { points: rows.map((r) => ({ date: r.date, valueUsd: Number(r.value_usd) })) };
  });
}
```

`services/api/src/routes/transactions.ts`
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { aggregatePositions, OversellError, type TxInput } from '../lib/holdings.js';
import { getOwnedPortfolio, loadTransactions, toTxDto, toTxInput } from '../lib/portfolios.js';
import { assertKnownCoin } from '../lib/priceClient.js';
import { decimalString, parse, uuidParam } from '../lib/validation.js';
import type { RouteContext } from './context.js';

const createTx = z.object({
  coinId: z.string().min(1).max(100),
  type: z.enum(['buy', 'sell']),
  quantity: decimalString(),
  priceUsd: decimalString({ allowZero: true }),
  feeUsd: decimalString({ allowZero: true }).default('0'),
  executedAt: z.coerce.date().optional(),
  note: z.string().trim().max(200).optional(),
});

const FUTURE_TOLERANCE_MS = 5 * 60_000;

function assertNoOversell(txs: TxInput[], message?: string): void {
  try {
    aggregatePositions(txs);
  } catch (err) {
    if (err instanceof OversellError) throw new HttpError(422, 'insufficient_holdings', message ?? err.message);
    throw err;
  }
}

export function transactionRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const { db, prices } = deps;

  app.get('/api/portfolios/:id/transactions', async (request) => {
    const { id } = parse(uuidParam, request.params);
    await getOwnedPortfolio(db, request.userId, id);
    const rows = await loadTransactions(db, { userId: request.userId, portfolioId: id });
    return { items: rows.map(toTxDto) };
  });

  app.post('/api/portfolios/:id/transactions', async (request, reply) => {
    const { id } = parse(uuidParam, request.params);
    const body = parse(createTx, request.body);
    await getOwnedPortfolio(db, request.userId, id);
    const executedAt = body.executedAt ?? new Date();
    if (executedAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) throw badRequest('executedAt cannot be in the future');
    await assertKnownCoin(prices, body.coinId);

    const existing = await loadTransactions(db, { userId: request.userId, portfolioId: id, coinId: body.coinId });
    assertNoOversell([
      ...existing.map(toTxInput),
      { coinId: body.coinId, type: body.type, quantity: body.quantity, priceUsd: body.priceUsd, feeUsd: body.feeUsd, executedAt },
    ]);

    const row = await db
      .insertInto('transactions')
      .values({
        portfolio_id: id,
        coin_id: body.coinId,
        type: body.type,
        quantity: body.quantity,
        price_usd: body.priceUsd,
        fee_usd: body.feeUsd,
        executed_at: executedAt,
        note: body.note ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return reply.status(201).send(toTxDto(row));
  });

  app.delete('/api/transactions/:id', async (request, reply) => {
    const { id } = parse(uuidParam, request.params);
    const tx = await db
      .selectFrom('transactions as t')
      .innerJoin('portfolios as p', 'p.id', 't.portfolio_id')
      .selectAll('t')
      .where('t.id', '=', id)
      .where('p.user_id', '=', request.userId)
      .executeTakeFirst();
    if (!tx) throw notFound('Transaction');

    const remaining = (await loadTransactions(db, { userId: request.userId, portfolioId: tx.portfolio_id, coinId: tx.coin_id }))
      .filter((row) => row.id !== id)
      .map(toTxInput);
    assertNoOversell(remaining, 'Deleting this transaction would leave a later sell without enough holdings');

    await db.deleteFrom('transactions').where('id', '=', id).execute();
    return reply.status(204).send();
  });
}
```

`services/api/src/routes/dashboard.ts`
```ts
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { computeHoldings } from '../lib/holdings.js';
import { loadTransactions, toTxInput } from '../lib/portfolios.js';
import { pricesOrEmpty } from '../lib/priceClient.js';
import { parse } from '../lib/validation.js';
import type { RouteContext } from './context.js';

export function dashboardRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const { db, prices } = deps;

  app.get('/api/dashboard', async (request) => {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), request.query);
    const portfolios = await db.selectFrom('portfolios').select(['id', 'name']).where('user_id', '=', request.userId).orderBy('created_at').execute();
    const txs = await loadTransactions(db, { userId: request.userId });
    const quotes = await pricesOrEmpty(prices, txs.map((tx) => tx.coin_id));
    const combined = computeHoldings(txs.map(toTxInput), quotes.prices);

    const history = await db
      .selectFrom('portfolio_snapshots as s')
      .innerJoin('portfolios as p', 'p.id', 's.portfolio_id')
      .select(['s.date', sql<string>`sum(s.value_usd)`.as('value')])
      .where('p.user_id', '=', request.userId)
      .where('s.date', '>=', sql<string>`current_date - ${days}::int`)
      .groupBy('s.date')
      .orderBy('s.date')
      .execute();

    return {
      totals: combined.totals,
      holdings: combined.holdings,
      portfolios: portfolios.map((p) => ({
        id: p.id,
        name: p.name,
        totals: computeHoldings(txs.filter((tx) => tx.portfolio_id === p.id).map(toTxInput), quotes.prices).totals,
      })),
      history: history.map((h) => ({ date: h.date, valueUsd: Number(h.value) })),
      stale: quotes.stale,
    };
  });
}
```

In `services/api/src/app.ts` secured block add: `portfolioRoutes(secured, ctx); transactionRoutes(secured, ctx); dashboardRoutes(secured, ctx);` with matching imports.

- [ ] **Step 5: Run all api tests**

Run: `cd services/api && npm run lint && npm test && npm run test:integration`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add services/api
git commit -m "feat(api): portfolios, transactions with oversell protection, holdings, dashboard"
```

---

### Task 10: api object storage (presigned URLs), avatar, uploads, background jobs

**Files:**
- Create: `services/api/src/lib/{storage.ts,queue.ts}`, `src/routes/{uploads.ts,jobs.ts}`
- Modify: `services/api/src/deps.ts`, `src/app.ts`, `src/routes/me.ts`, `src/routes/health.ts`, `test/integration/helpers.ts`
- Test: `services/api/test/unit/storage.test.ts`, `test/integration/files-jobs.test.ts`

**Interfaces:**
- Consumes: `getOwnedPortfolio` (Task 9), `toUserDto` (Task 6).
- Produces:
  - `BucketName = 'avatars'|'imports'|'exports'`, `Storage { presignPut(bucket, key); presignGet(bucket, key, downloadName?); ping() }`, `S3Storage(config)`, `PRESIGN_TTL_SECONDS = 900`.
  - `JobQueue { enqueue(jobId) }`, `RedisJobQueue(redis, stream)` → `XADD <stream> MAXLEN ~ 10000 * job_id <uuid>`.
  - `Deps.storage`, `Deps.queue`.
  - Object key conventions (the worker relies on them): avatars `<userId>/<uuid>`, imports `<userId>/<uuid>.csv`, exports `<userId>/<jobId>.csv|.pdf`.
  - HTTP (secured):
    - `GET /api/me` now returns `avatarUrl` (presigned GET) when set
    - `POST /api/me/avatar/upload-url` → `{ uploadUrl, key }`
    - `PUT /api/me/avatar {key}` → user (400 unless key starts with `<userId>/`)
    - `POST /api/uploads/import-url` → `{ uploadUrl, key }`
    - `POST /api/jobs {type:'export_csv'|'report_pdf', params:{portfolioId}}` or `{type:'import_csv', params:{portfolioId, key}}` → 202 JobDto
    - `GET /api/jobs` → `{ items: JobDto[] }` (latest 20), `GET /api/jobs/:id` → JobDto
  - `JobDto { id, type, status, params, result, error, attempts, createdAt, updatedAt, downloadUrl: string|null }`. `downloadUrl` is set only for finished export/report jobs.
  - `GET /api/readyz` checks now include `storage`.

- [ ] **Step 1: Install the AWS SDK**

Run: `cd services/api && npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`

- [ ] **Step 2: Write the failing storage unit test**

`services/api/test/unit/storage.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { S3Storage } from '../../src/lib/storage.js';

const storage = new S3Storage({
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
  S3_BUCKET_AVATARS: 'cf-avatars',
  S3_BUCKET_IMPORTS: 'cf-imports',
  S3_BUCKET_EXPORTS: 'cf-exports',
});

describe('S3Storage presigning', () => {
  it('signs PUT URLs against the PUBLIC endpoint, path-style, 15 min TTL', async () => {
    const url = new URL(await storage.presignPut('avatars', 'user-1/abc'));
    expect(url.origin).toBe('http://localhost');
    expect(url.pathname).toBe('/cf-avatars/user-1/abc');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('does not add SDK checksum parameters (they break browser uploads)', async () => {
    const url = (await storage.presignPut('imports', 'user-1/file.csv')).toLowerCase();
    expect(url).not.toContain('x-amz-checksum');
    expect(url).not.toContain('x-amz-sdk-checksum-algorithm');
  });

  it('adds a content-disposition to GET URLs when a download name is given', async () => {
    const url = new URL(await storage.presignGet('exports', 'user-1/job.csv', 'my "portfolio".csv'));
    expect(url.pathname).toBe('/cf-exports/user-1/job.csv');
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="my portfolio.csv"');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd services/api && npm test -- storage`
Expected: FAIL `Cannot find module '../../src/lib/storage.js'`

- [ ] **Step 4: Implement storage and queue**

`services/api/src/lib/storage.ts`
```ts
import { GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config.js';

export type BucketName = 'avatars' | 'imports' | 'exports';
export const PRESIGN_TTL_SECONDS = 15 * 60;

export interface Storage {
  presignPut(bucket: BucketName, key: string): Promise<string>;
  presignGet(bucket: BucketName, key: string, downloadName?: string): Promise<string>;
  ping(): Promise<void>;
}

type StorageConfig = Pick<
  Config,
  'S3_ENDPOINT' | 'S3_PUBLIC_ENDPOINT' | 'S3_REGION' | 'S3_ACCESS_KEY' | 'S3_SECRET_KEY' | 'S3_BUCKET_AVATARS' | 'S3_BUCKET_IMPORTS' | 'S3_BUCKET_EXPORTS'
>;

/**
 * S3-compatible storage (MinIO locally, GCS via its S3 interoperability API later).
 * Two clients: `internal` talks to the storage over the private network,
 * `publicClient` only SIGNS URLs that the browser will use via the gateway.
 */
export class S3Storage implements Storage {
  private readonly internal: S3Client;
  private readonly publicClient: S3Client;
  private readonly buckets: Record<BucketName, string>;

  constructor(config: StorageConfig) {
    const common = {
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
      // Newer SDKs add CRC32 checksums to presigned PUTs by default; browsers cannot satisfy them.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.internal = new S3Client({ ...common, endpoint: config.S3_ENDPOINT });
    this.publicClient = new S3Client({ ...common, endpoint: config.S3_PUBLIC_ENDPOINT });
    this.buckets = { avatars: config.S3_BUCKET_AVATARS, imports: config.S3_BUCKET_IMPORTS, exports: config.S3_BUCKET_EXPORTS };
  }

  presignPut(bucket: BucketName, key: string): Promise<string> {
    return getSignedUrl(this.publicClient, new PutObjectCommand({ Bucket: this.buckets[bucket], Key: key }), {
      expiresIn: PRESIGN_TTL_SECONDS,
    });
  }

  presignGet(bucket: BucketName, key: string, downloadName?: string): Promise<string> {
    const disposition = downloadName ? `attachment; filename="${downloadName.replace(/"/g, '')}"` : undefined;
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({ Bucket: this.buckets[bucket], Key: key, ResponseContentDisposition: disposition }),
      { expiresIn: PRESIGN_TTL_SECONDS },
    );
  }

  async ping(): Promise<void> {
    await this.internal.send(new HeadBucketCommand({ Bucket: this.buckets.avatars }));
  }
}
```

`services/api/src/lib/queue.ts`
```ts
import type { Redis } from 'ioredis';

export interface JobQueue {
  enqueue(jobId: string): Promise<void>;
}

/** Publishes job ids to a Redis Stream consumed by the worker's consumer group. */
export class RedisJobQueue implements JobQueue {
  constructor(private readonly redis: Redis, private readonly stream: string) {}

  async enqueue(jobId: string): Promise<void> {
    await this.redis.xadd(this.stream, 'MAXLEN', '~', '10000', '*', 'job_id', jobId);
  }
}
```

- [ ] **Step 5: Run unit tests**

Run: `cd services/api && npm test`
Expected: PASS.

- [ ] **Step 6: Extend Deps and test helpers**

`services/api/src/deps.ts`: add imports `S3Storage, type Storage` and `RedisJobQueue, type JobQueue`; add `storage: Storage; queue: JobQueue;` to `Deps`; in `createDeps` build the redis client first and reuse it:
```ts
export function createDeps(config: Config): Deps {
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
  return {
    config,
    db: createDb(config.DATABASE_URL),
    redis,
    prices: new HttpPriceClient(config.PRICE_SERVICE_URL),
    storage: new S3Storage(config),
    queue: new RedisJobQueue(redis, config.JOBS_STREAM),
  };
}
```

`services/api/test/integration/helpers.ts`, in `buildTestApp`:
```ts
  const redis = new Redis(config.REDIS_URL);
  const deps: Deps = {
    config,
    db: createDb(config.DATABASE_URL),
    redis,
    prices,
    storage: new S3Storage(config),
    queue: new RedisJobQueue(redis, config.JOBS_STREAM),
  };
```
(with imports of `S3Storage` and `RedisJobQueue`).

`services/api/src/routes/health.ts`: add `storage: await check(() => deps.storage.ping()),` to `checks`.

- [ ] **Step 7: Write the failing integration tests**

`services/api/test/integration/files-jobs.test.ts`
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, registerUser, resetState, type TestApp } from './helpers.js';

describe('files and jobs', () => {
  let t: TestApp;
  let alice: Awaited<ReturnType<typeof registerUser>>;
  let bob: Awaited<ReturnType<typeof registerUser>>;
  let portfolioId: string;

  beforeAll(async () => {
    t = await buildTestApp();
  });
  beforeEach(async () => {
    await resetState(t.deps);
    alice = await registerUser(t.app, 'alice@example.com');
    bob = await registerUser(t.app, 'bob@example.com');
    portfolioId = (await t.app.inject({ method: 'POST', url: '/api/portfolios', headers: alice.headers, payload: { name: 'Main' } })).json().id;
  });
  afterAll(() => t.close());

  it('readiness includes object storage', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/readyz' });
    expect(res.json().checks.storage).toBe('ok');
  });

  it('uploads an avatar through a presigned URL and serves it back', async () => {
    const { uploadUrl, key } = (await t.app.inject({ method: 'POST', url: '/api/me/avatar/upload-url', headers: alice.headers })).json();
    expect(key.startsWith(`${alice.userId}/`)).toBe(true);

    const put = await fetch(uploadUrl, { method: 'PUT', body: new Uint8Array([137, 80, 78, 71]), headers: { 'content-type': 'image/png' } });
    expect(put.status).toBe(200);

    const saved = await t.app.inject({ method: 'PUT', url: '/api/me/avatar', headers: alice.headers, payload: { key } });
    expect(saved.statusCode).toBe(200);
    const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: alice.headers })).json();
    const get = await fetch(me.avatarUrl);
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it("refuses to set another user's object as avatar", async () => {
    const res = await t.app.inject({ method: 'PUT', url: '/api/me/avatar', headers: alice.headers, payload: { key: `${bob.userId}/00000000-0000-4000-8000-000000000000` } });
    expect(res.statusCode).toBe(400);
  });

  it('creates an import upload URL scoped to the user', async () => {
    const res = (await t.app.inject({ method: 'POST', url: '/api/uploads/import-url', headers: alice.headers })).json();
    expect(res.key).toMatch(new RegExp(`^${alice.userId}/[0-9a-f-]{36}\\.csv$`));
    expect(res.uploadUrl).toContain('/cf-imports/');
  });

  it('queues an export job and publishes it to the stream', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/jobs', headers: alice.headers, payload: { type: 'export_csv', params: { portfolioId } } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ type: 'export_csv', status: 'queued', downloadUrl: null });
    const entries = await t.deps.redis.xrange('jobs-test', '-', '+');
    expect(entries.at(-1)?.[1]).toEqual(['job_id', res.json().id]);
  });

  it("rejects jobs on another user's portfolio or with another user's upload key", async () => {
    const other = await t.app.inject({ method: 'POST', url: '/api/jobs', headers: bob.headers, payload: { type: 'report_pdf', params: { portfolioId } } });
    expect(other.statusCode).toBe(404);
    const bobPortfolio = (await t.app.inject({ method: 'POST', url: '/api/portfolios', headers: bob.headers, payload: { name: 'B' } })).json().id;
    const badKey = await t.app.inject({
      method: 'POST', url: '/api/jobs', headers: bob.headers,
      payload: { type: 'import_csv', params: { portfolioId: bobPortfolio, key: `${alice.userId}/x.csv` } },
    });
    expect(badKey.statusCode).toBe(400);
  });

  it('rejects unknown job types', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/jobs', headers: alice.headers, payload: { type: 'mine_bitcoin', params: {} } });
    expect(res.statusCode).toBe(400);
  });

  it('returns a download URL once an export is done; jobs are private', async () => {
    const job = (await t.app.inject({ method: 'POST', url: '/api/jobs', headers: alice.headers, payload: { type: 'export_csv', params: { portfolioId } } })).json();
    await t.deps.db
      .updateTable('jobs')
      .set({ status: 'done', result_key: `${alice.userId}/${job.id}.csv`, result: JSON.stringify({ filename: 'main-transactions.csv' }) })
      .where('id', '=', job.id)
      .execute();
    const res = (await t.app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: alice.headers })).json();
    expect(res.status).toBe('done');
    expect(res.downloadUrl).toContain(`/cf-exports/${alice.userId}/${job.id}.csv`);
    expect(res.downloadUrl).toContain('response-content-disposition');
    expect((await t.app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: bob.headers })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/jobs', headers: alice.headers })).json().items).toHaveLength(1);
  });
});
```

- [ ] **Step 8: Run to verify failure**

Run: `cd services/api && npm run test:integration -- files-jobs`
Expected: FAIL. The upload-url and jobs routes return 404.

- [ ] **Step 9: Implement avatar, uploads and jobs routes**

In `services/api/src/routes/me.ts` replace `meRoutes` with:
```ts
export function meRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const loadUser = async (userId: string) => {
    const user = await deps.db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
    if (!user) throw notFound('User');
    return user;
  };
  const userDto = async (userId: string) => {
    const user = await loadUser(userId);
    return toUserDto(user, user.avatar_key ? await deps.storage.presignGet('avatars', user.avatar_key) : null);
  };

  app.get('/api/me', async (request) => userDto(request.userId));

  app.patch('/api/me', async (request) => {
    const body = parse(z.object({ displayName: z.string().trim().min(1).max(60) }), request.body);
    await deps.db.updateTable('users').set({ display_name: body.displayName }).where('id', '=', request.userId).execute();
    return userDto(request.userId);
  });

  app.post('/api/me/avatar/upload-url', async (request) => {
    const key = `${request.userId}/${randomUUID()}`;
    return { uploadUrl: await deps.storage.presignPut('avatars', key), key };
  });

  app.put('/api/me/avatar', async (request) => {
    const { key } = parse(z.object({ key: z.string().max(200) }), request.body);
    if (!new RegExp(`^${request.userId}/[0-9a-f-]{36}$`).test(key)) throw badRequest('Invalid avatar key');
    await deps.db.updateTable('users').set({ avatar_key: key }).where('id', '=', request.userId).execute();
    return userDto(request.userId);
  });
}
```
(add `import { randomUUID } from 'node:crypto';` and `badRequest` to the errors import).

`services/api/src/routes/uploads.ts`
```ts
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context.js';

export function uploadRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  // The browser PUTs the CSV straight to object storage, then creates an import_csv job with the key.
  app.post('/api/uploads/import-url', async (request) => {
    const key = `${request.userId}/${randomUUID()}.csv`;
    return { uploadUrl: await deps.storage.presignPut('imports', key), key };
  });
}
```

`services/api/src/routes/jobs.ts`
```ts
import type { FastifyInstance } from 'fastify';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { JobsTable } from '../db/database.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { getOwnedPortfolio } from '../lib/portfolios.js';
import type { Storage } from '../lib/storage.js';
import { parse, uuidParam } from '../lib/validation.js';
import type { RouteContext } from './context.js';

const portfolioParams = z.object({ portfolioId: z.string().uuid() });
const createJob = z.discriminatedUnion('type', [
  z.object({ type: z.literal('export_csv'), params: portfolioParams }),
  z.object({ type: z.literal('report_pdf'), params: portfolioParams }),
  z.object({ type: z.literal('import_csv'), params: portfolioParams.extend({ key: z.string().min(1).max(200) }) }),
]);

async function toJobDto(job: Selectable<JobsTable>, storage: Storage) {
  const downloadable = job.status === 'done' && job.result_key && job.type !== 'import_csv';
  const filename = typeof job.result?.filename === 'string' ? job.result.filename : undefined;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    params: job.params,
    result: job.result,
    error: job.error,
    attempts: job.attempts,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    downloadUrl: downloadable ? await storage.presignGet('exports', job.result_key!, filename) : null,
  };
}

export function jobRoutes(app: FastifyInstance, { deps }: RouteContext): void {
  const { db, storage, queue } = deps;

  app.post('/api/jobs', async (request, reply) => {
    const body = parse(createJob, request.body);
    await getOwnedPortfolio(db, request.userId, body.params.portfolioId);
    if (body.type === 'import_csv' && !body.params.key.startsWith(`${request.userId}/`)) throw badRequest('Invalid upload key');

    const job = await db
      .insertInto('jobs')
      .values({ user_id: request.userId, type: body.type, params: JSON.stringify(body.params) })
      .returningAll()
      .executeTakeFirstOrThrow();
    try {
      await queue.enqueue(job.id);
    } catch (err) {
      request.log.error({ err, jobId: job.id }, 'failed to enqueue job');
      await db.updateTable('jobs').set({ status: 'failed', error: 'Could not enqueue job', updated_at: new Date() }).where('id', '=', job.id).execute();
      throw new HttpError(503, 'queue_unavailable', 'Background jobs are temporarily unavailable');
    }
    return reply.status(202).send(await toJobDto(job, storage));
  });

  app.get('/api/jobs', async (request) => {
    const jobs = await db.selectFrom('jobs').selectAll().where('user_id', '=', request.userId).orderBy('created_at', 'desc').limit(20).execute();
    return { items: await Promise.all(jobs.map((j) => toJobDto(j, storage))) };
  });

  app.get('/api/jobs/:id', async (request) => {
    const { id } = parse(uuidParam, request.params);
    const job = await db.selectFrom('jobs').selectAll().where('id', '=', id).where('user_id', '=', request.userId).executeTakeFirst();
    if (!job) throw notFound('Job');
    return toJobDto(job, storage);
  });
}
```

In `services/api/src/app.ts` secured block add `uploadRoutes(secured, ctx); jobRoutes(secured, ctx);` with imports.

- [ ] **Step 10: Run all api tests and the container build**

Run: `cd services/api && npm run lint && npm test && npm run test:integration && cd ../.. && docker compose up -d --build api && sleep 10 && docker compose ps api`
Expected: all tests PASS; `api` healthy.

- [ ] **Step 11: Commit**

```bash
git add services/api
git commit -m "feat(api): presigned uploads/downloads, avatar, background job API on redis streams"
```

---
### Task 11: worker scaffold, adapters and position calculation

**Files:**
- Create: `services/worker/{Dockerfile,.dockerignore,pyproject.toml,requirements.txt,requirements-dev.txt}`
- Create: `services/worker/worker/{__init__.py,config.py,logging_setup.py,metrics.py,db.py,storage.py,prices.py,portfolio.py}`
- Test: `services/worker/tests/{__init__.py,test_portfolio.py,test_prices.py}`

**Interfaces:**
- Consumes: DB schema (Task 5), price-service contract (Task 4), bucket names/env (Task 1).
- Produces:
  - `Settings` (env: `DATABASE_URL, REDIS_URL, PRICE_SERVICE_URL, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET_IMPORTS, S3_BUCKET_EXPORTS, JOBS_STREAM ('jobs'), JOBS_GROUP ('workers'), WORKER_NAME (hostname), MAX_ATTEMPTS (3), ALERT_CHECK_INTERVAL_SECONDS (60), HEALTH_PORT (9100), LOG_LEVEL`).
  - `setup_logging(level)`; metrics `JOBS`, `JOB_DURATION`, `ALERTS_TRIGGERED`, `SNAPSHOTS_WRITTEN`, `SCHEDULED_FAILURES`.
  - `make_pool(url) -> ConnectionPool` (rows as dicts).
  - `Storage(settings)`: `.put(bucket, key, data, content_type)`, `.get(bucket, key) -> bytes`, `.ping()`, attributes `imports_bucket`, `exports_bucket`.
  - `PriceClient(base_url, transport=None)`: `.get_prices(ids) -> dict[str, float]` (chunks of 100), `.get_coins() -> dict[str, dict]`; raises `httpx.HTTPError` on failure.
  - `Tx` dataclass `(executed_at, type, coin_id, quantity, price_usd, fee_usd, note=None)`, `Position` (`quantity`, `cost_basis`, `realized_pnl`, `avg_cost`), `OversellError`, `compute_positions(txs) -> dict[str, Position]`.

Test command:
`docker build -q --target test -t cf-worker-test services/worker && docker run --rm cf-worker-test pytest -q <path>`

- [ ] **Step 1: Packaging files**

`services/worker/requirements.txt`
```
redis==5.2.1
psycopg[binary,pool]==3.2.7
boto3==1.38.8
APScheduler==3.11.0
reportlab==4.4.0
httpx==0.28.1
prometheus-client==0.21.1
pydantic-settings==2.9.1
```

`services/worker/requirements-dev.txt`
```
-r requirements.txt
pytest==8.3.5
ruff==0.11.8
```

`services/worker/pyproject.toml`
```toml
[project]
name = "worker"
version = "1.0.0"
requires-python = ">=3.12"

[tool.pytest.ini_options]
pythonpath = ["."]
testpaths = ["tests"]

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]
```

`services/worker/.dockerignore`
```
.venv
__pycache__
.pytest_cache
.ruff_cache
```

`services/worker/Dockerfile`
```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
RUN useradd --create-home --uid 10001 app

FROM base AS deps
COPY requirements.txt .
RUN pip install -r requirements.txt

# `docker build --target test` -> lint + unit tests; set INTEGRATION=1 to include integration tests
FROM deps AS test
COPY requirements-dev.txt .
RUN pip install -r requirements-dev.txt
COPY . .
CMD ["sh", "-c", "ruff check . && pytest -q"]

FROM deps AS runtime
COPY worker ./worker
USER app
EXPOSE 9100
CMD ["python", "-m", "worker.main"]
```

- [ ] **Step 2: Config, logging, metrics, db, storage**

`services/worker/worker/__init__.py`: empty.

`services/worker/worker/config.py`
```python
import socket

from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """All configuration comes from environment variables (e.g. DATABASE_URL)."""

    database_url: str = "postgres://cryptofolio:cryptofolio@localhost:5432/cryptofolio"
    redis_url: str = "redis://localhost:6379/0"
    price_service_url: str = "http://localhost:8000"
    s3_endpoint: str = "http://localhost:9000"
    s3_region: str = "us-east-1"
    s3_access_key: str = "cryptofolio"
    s3_secret_key: str = "cryptofolio-secret"
    s3_bucket_imports: str = "cf-imports"
    s3_bucket_exports: str = "cf-exports"
    jobs_stream: str = "jobs"
    jobs_group: str = "workers"
    worker_name: str = Field(default_factory=socket.gethostname)
    max_attempts: int = 3
    alert_check_interval_seconds: int = 60
    health_port: int = 9100
    log_level: str = "info"
```

`services/worker/worker/logging_setup.py`
```python
import json
import logging
import sys
from datetime import UTC, datetime

EXTRA_FIELDS = ("job_id", "job_type", "attempts", "task", "result", "duration_ms", "message_id")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname.lower(),
            "service": "worker",
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key in EXTRA_FIELDS:
            if hasattr(record, key):
                payload[key] = getattr(record, key)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def setup_logging(level: str) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    logging.getLogger("apscheduler").setLevel(logging.WARNING)
```

`services/worker/worker/metrics.py`
```python
from prometheus_client import Counter, Histogram

JOBS = Counter("worker_jobs_total", "Jobs processed", ["type", "outcome"])
JOB_DURATION = Histogram("worker_job_duration_seconds", "Job processing time", ["type"])
ALERTS_TRIGGERED = Counter("worker_alerts_triggered_total", "Price alerts triggered")
SNAPSHOTS_WRITTEN = Counter("worker_snapshots_written_total", "Portfolio snapshots upserted")
SCHEDULED_FAILURES = Counter(
    "worker_scheduled_task_failures_total", "Scheduled task failures", ["task"]
)
```

`services/worker/worker/db.py`
```python
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


def make_pool(url: str) -> ConnectionPool:
    """Small pool; rows come back as dicts."""
    return ConnectionPool(url, min_size=1, max_size=5, kwargs={"row_factory": dict_row}, open=True)
```

`services/worker/worker/storage.py`
```python
import boto3
from botocore.config import Config as BotoConfig

from .config import Settings


class Storage:
    """S3-compatible object storage (MinIO locally, GCS interoperability later)."""

    def __init__(self, settings: Settings):
        self._s3 = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            region_name=settings.s3_region,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            config=BotoConfig(
                s3={"addressing_style": "path"},
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            ),
        )
        self.imports_bucket = settings.s3_bucket_imports
        self.exports_bucket = settings.s3_bucket_exports

    def put(self, bucket: str, key: str, data: bytes, content_type: str) -> None:
        self._s3.put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)

    def get(self, bucket: str, key: str) -> bytes:
        return self._s3.get_object(Bucket=bucket, Key=key)["Body"].read()

    def ping(self) -> None:
        self._s3.head_bucket(Bucket=self.exports_bucket)
```

- [ ] **Step 3: Write failing tests for positions and the price client**

`services/worker/tests/__init__.py`: empty.

`services/worker/tests/test_portfolio.py`
```python
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from worker.portfolio import OversellError, Tx, compute_positions

T0 = datetime(2024, 1, 1, tzinfo=UTC)


def tx(coin, type_, qty, price, fee="0", minutes=0):
    return Tx(
        executed_at=T0 + timedelta(minutes=minutes),
        type=type_,
        coin_id=coin,
        quantity=Decimal(qty),
        price_usd=Decimal(price),
        fee_usd=Decimal(fee),
    )


def test_average_cost_includes_fees():
    p = compute_positions([tx("bitcoin", "buy", "1", "100", "10", 0), tx("bitcoin", "buy", "1", "200", "0", 1)])["bitcoin"]
    assert p.quantity == Decimal("2")
    assert p.cost_basis == Decimal("310")
    assert p.avg_cost == Decimal("155")


def test_sell_realises_pnl_at_average_cost():
    p = compute_positions([tx("bitcoin", "buy", "2", "100", minutes=0), tx("bitcoin", "sell", "1", "150", "1", 1)])["bitcoin"]
    assert p.realized_pnl == Decimal("49")
    assert p.quantity == Decimal("1")
    assert p.cost_basis == Decimal("100")


def test_oversell_raises():
    with pytest.raises(OversellError):
        compute_positions([tx("bitcoin", "buy", "1", "1", minutes=0), tx("bitcoin", "sell", "2", "1", minutes=1)])


def test_sell_before_buy_raises():
    with pytest.raises(OversellError):
        compute_positions([tx("bitcoin", "buy", "1", "1", minutes=5), tx("bitcoin", "sell", "1", "1", minutes=0)])


def test_buy_applied_before_sell_on_same_timestamp():
    compute_positions([tx("bitcoin", "sell", "1", "1", minutes=3), tx("bitcoin", "buy", "1", "1", minutes=3)])


def test_exact_decimals_close_position():
    p = compute_positions(
        [tx("eth", "buy", "0.1", "10", minutes=0), tx("eth", "buy", "0.2", "10", minutes=1), tx("eth", "sell", "0.3", "10", minutes=2)]
    )["eth"]
    assert p.quantity == 0 and p.cost_basis == 0
    assert p.avg_cost == 0
```

`services/worker/tests/test_prices.py`
```python
import httpx
import pytest

from worker.prices import PriceClient


def test_get_prices_chunks_by_100_and_maps_usd():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        ids = request.url.params["ids"].split(",")
        calls.append(len(ids))
        return httpx.Response(200, json={"prices": {i: {"usd": 1.5, "change_24h": 0} for i in ids}, "stale": False})

    client = PriceClient("http://prices.test", transport=httpx.MockTransport(handler))
    prices = client.get_prices([f"c{i}" for i in range(150)] + ["c0"])
    assert calls == [100, 50]
    assert len(prices) == 150 and prices["c0"] == 1.5


def test_get_prices_empty_does_not_call():
    client = PriceClient("http://prices.test", transport=httpx.MockTransport(lambda r: pytest.fail("called")))
    assert client.get_prices([]) == {}


def test_errors_raise_http_error():
    client = PriceClient("http://prices.test", transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    with pytest.raises(httpx.HTTPError):
        client.get_prices(["bitcoin"])


def test_get_coins_indexes_by_id():
    body = {"coins": [{"id": "bitcoin", "symbol": "btc", "name": "Bitcoin"}], "stale": False}
    client = PriceClient("http://prices.test", transport=httpx.MockTransport(lambda r: httpx.Response(200, json=body)))
    assert client.get_coins()["bitcoin"]["symbol"] == "btc"
```

- [ ] **Step 4: Run to verify failure**

Run: `docker build -q --target test -t cf-worker-test services/worker && docker run --rm cf-worker-test pytest -q tests/test_portfolio.py tests/test_prices.py`
Expected: FAIL `ModuleNotFoundError: No module named 'worker.portfolio'`

- [ ] **Step 5: Implement positions and price client**

`services/worker/worker/portfolio.py`
```python
"""Average-cost position math (mirrors services/api/src/lib/holdings.ts)."""

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

ZERO = Decimal(0)


@dataclass(frozen=True)
class Tx:
    executed_at: datetime
    type: str
    coin_id: str
    quantity: Decimal
    price_usd: Decimal
    fee_usd: Decimal
    note: str | None = None


@dataclass
class Position:
    coin_id: str
    quantity: Decimal = field(default=ZERO)
    cost_basis: Decimal = field(default=ZERO)
    realized_pnl: Decimal = field(default=ZERO)

    @property
    def avg_cost(self) -> Decimal:
        return self.cost_basis / self.quantity if self.quantity > 0 else ZERO


class OversellError(ValueError):
    pass


def compute_positions(txs: Iterable[Tx]) -> dict[str, Position]:
    ordered = sorted(txs, key=lambda t: (t.executed_at, 0 if t.type == "buy" else 1))
    positions: dict[str, Position] = {}
    for t in ordered:
        p = positions.setdefault(t.coin_id, Position(t.coin_id))
        if t.type == "buy":
            p.quantity += t.quantity
            p.cost_basis += t.quantity * t.price_usd + t.fee_usd
            continue
        if t.quantity > p.quantity:
            raise OversellError(
                f"cannot sell {t.quantity} {t.coin_id} on {t.executed_at:%Y-%m-%d}: "
                f"only {p.quantity} held"
            )
        cost_removed = p.cost_basis / p.quantity * t.quantity
        p.realized_pnl += t.quantity * t.price_usd - t.fee_usd - cost_removed
        p.quantity -= t.quantity
        p.cost_basis = ZERO if p.quantity == 0 else p.cost_basis - cost_removed
    return positions
```

`services/worker/worker/prices.py`
```python
import httpx

CHUNK = 100


class PriceClient:
    """Thin client for the internal price-service."""

    def __init__(self, base_url: str, timeout: float = 5.0, transport: httpx.BaseTransport | None = None):
        self._client = httpx.Client(base_url=base_url, timeout=timeout, transport=transport)

    def get_prices(self, ids: list[str]) -> dict[str, float]:
        unique = sorted(set(ids))
        prices: dict[str, float] = {}
        for i in range(0, len(unique), CHUNK):
            response = self._client.get("/prices", params={"ids": ",".join(unique[i : i + CHUNK])})
            response.raise_for_status()
            prices.update({k: float(v["usd"]) for k, v in response.json()["prices"].items()})
        return prices

    def get_coins(self) -> dict[str, dict]:
        response = self._client.get("/coins")
        response.raise_for_status()
        return {c["id"]: c for c in response.json()["coins"]}
```

- [ ] **Step 6: Run tests**

Run: `docker build -q --target test -t cf-worker-test services/worker && docker run --rm cf-worker-test`
Expected: ruff clean; all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add services/worker
git commit -m "feat(worker): scaffold, storage/db/price adapters, average-cost positions"
```

---

### Task 12: worker CSV import/export format and PDF report

**Files:**
- Create: `services/worker/worker/{csv_io.py,report.py}`
- Test: `services/worker/tests/{test_csv_io.py,test_report.py}`

**Interfaces:**
- Consumes: `Tx` (Task 11).
- Produces:
  - `CSV_HEADER = ["date","type","coin_id","quantity","price_usd","fee_usd","note"]`, `MAX_ROWS = 5000`.
  - `build_transactions_csv(txs: list[Tx]) -> str` (UTC ISO dates with `Z`, plain decimals).
  - `parse_transactions_csv(text: str) -> list[Tx]`. Raises `CsvImportError(errors: list[str])`, whose message lists row-numbered problems (at most 10 shown).
  - `ReportRow(coin_id, quantity, avg_cost, price, value, pnl)`, `build_portfolio_report(portfolio_name, owner, rows, realized_pnl, generated_at) -> bytes` (PDF).

- [ ] **Step 1: Write the failing tests**

`services/worker/tests/test_csv_io.py`
```python
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from worker.csv_io import CSV_HEADER, CsvImportError, build_transactions_csv, parse_transactions_csv
from worker.portfolio import Tx

HEADER = ",".join(CSV_HEADER)


def test_round_trip():
    txs = [
        Tx(datetime(2024, 1, 2, 3, 4, 5, tzinfo=UTC), "buy", "bitcoin", Decimal("0.500000000000000000"), Decimal("42000"), Decimal("10"), "first, buy"),
        Tx(datetime(2024, 2, 1, tzinfo=UTC), "sell", "bitcoin", Decimal("0.1"), Decimal("50000.5"), Decimal("0"), None),
    ]
    text = build_transactions_csv(txs)
    assert text.splitlines()[0] == HEADER
    assert text.splitlines()[1] == '2024-01-02T03:04:05Z,buy,bitcoin,0.5,42000,10,"first, buy"'
    parsed = parse_transactions_csv(text)
    assert [(t.executed_at, t.type, t.coin_id, t.quantity, t.price_usd, t.fee_usd) for t in parsed] == [
        (t.executed_at, t.type, t.coin_id, t.quantity, t.price_usd, t.fee_usd) for t in txs
    ]


def test_naive_dates_are_utc_and_fee_defaults_to_zero():
    parsed = parse_transactions_csv(f"{HEADER}\n2024-03-01 10:00:00,BUY,Ethereum,2,3000,,\n")
    assert parsed[0].executed_at == datetime(2024, 3, 1, 10, tzinfo=UTC)
    assert parsed[0].type == "buy" and parsed[0].coin_id == "ethereum"
    assert parsed[0].fee_usd == 0


def test_accepts_bom_blank_lines_and_missing_note_column():
    header6 = ",".join(CSV_HEADER[:6])
    parsed = parse_transactions_csv(f"﻿{header6}\n\n2024-01-01,buy,bitcoin,1,1,0\n\n")
    assert len(parsed) == 1


def test_empty_file():
    with pytest.raises(CsvImportError, match="empty"):
        parse_transactions_csv("")


def test_header_only():
    with pytest.raises(CsvImportError, match="no transactions"):
        parse_transactions_csv(HEADER + "\n")


def test_wrong_header():
    with pytest.raises(CsvImportError, match="header"):
        parse_transactions_csv("when,what\n2024-01-01,buy\n")


def test_collects_row_errors_with_row_numbers():
    text = (
        f"{HEADER}\n"
        "2024-01-01,buy,bitcoin,0,100,0,\n"
        "2024-01-02,buy,bitcoin,1,100,0,\n"
        "yesterday,hold,,abc,-5,x,\n"
    )
    with pytest.raises(CsvImportError) as info:
        parse_transactions_csv(text)
    errors = info.value.errors
    assert len(errors) == 2
    assert errors[0].startswith("row 2:") and "quantity" in errors[0]
    assert errors[1].startswith("row 4:")
    for word in ("date", "type", "coin_id", "quantity", "price_usd", "fee_usd"):
        assert word in errors[1]


def test_rejects_nan_and_infinity():
    with pytest.raises(CsvImportError):
        parse_transactions_csv(f"{HEADER}\n2024-01-01,buy,bitcoin,NaN,Infinity,0,\n")


def test_too_many_rows():
    rows = "\n".join("2024-01-01,buy,bitcoin,1,1,0," for _ in range(5001))
    with pytest.raises(CsvImportError, match="5000"):
        parse_transactions_csv(f"{HEADER}\n{rows}\n")
```

`services/worker/tests/test_report.py`
```python
from datetime import UTC, datetime
from decimal import Decimal

from worker.report import ReportRow, build_portfolio_report


def test_builds_a_pdf():
    rows = [
        ReportRow("bitcoin", Decimal("0.5"), Decimal("42000"), 50000.0, 25000.0, 4000.0),
        ReportRow("solana", Decimal("3"), Decimal("100"), None, None, None),
    ]
    pdf = build_portfolio_report("Main <&> Co", "Alice", rows, Decimal("12.5"), datetime(2024, 1, 1, tzinfo=UTC))
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 1000


def test_builds_a_pdf_for_an_empty_portfolio():
    assert build_portfolio_report("Empty", "Bob", [], Decimal(0), datetime.now(UTC)).startswith(b"%PDF")
```

- [ ] **Step 2: Run to verify failure**

Run: `docker build -q --target test -t cf-worker-test services/worker && docker run --rm cf-worker-test pytest -q tests/test_csv_io.py tests/test_report.py`
Expected: FAIL `ModuleNotFoundError: No module named 'worker.csv_io'`

- [ ] **Step 3: Implement CSV I/O**

`services/worker/worker/csv_io.py`
```python
"""Transaction CSV format shared by export and import (round-trips exactly)."""

import csv
import io
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation

from .portfolio import Tx

CSV_HEADER = ["date", "type", "coin_id", "quantity", "price_usd", "fee_usd", "note"]
REQUIRED_COLUMNS = CSV_HEADER[:6]
MAX_ROWS = 5000
MAX_ERRORS_SHOWN = 10


class CsvImportError(ValueError):
    def __init__(self, errors: list[str]):
        self.errors = errors
        shown = "; ".join(errors[:MAX_ERRORS_SHOWN])
        more = len(errors) - MAX_ERRORS_SHOWN
        super().__init__(shown + (f" (+{more} more)" if more > 0 else ""))


def _fmt(value: Decimal) -> str:
    return format(value.normalize(), "f") if value != 0 else "0"


def build_transactions_csv(txs: list[Tx]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(CSV_HEADER)
    for t in txs:
        date = t.executed_at.astimezone(UTC).isoformat().replace("+00:00", "Z")
        writer.writerow(
            [date, t.type, t.coin_id, _fmt(t.quantity), _fmt(t.price_usd), _fmt(t.fee_usd), t.note or ""]
        )
    return buffer.getvalue()


def _decimal(raw: str) -> Decimal | None:
    try:
        value = Decimal(raw)
    except InvalidOperation:
        return None
    return value if value.is_finite() else None


def _parse_date(raw: str) -> datetime | None:
    try:
        value = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def parse_transactions_csv(text: str) -> list[Tx]:
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    if not rows:
        raise CsvImportError(["file is empty"])
    header = [h.strip().lower() for h in rows[0]]
    if header[: len(REQUIRED_COLUMNS)] != REQUIRED_COLUMNS:
        raise CsvImportError([f"header must be: {','.join(CSV_HEADER)}"])

    numbered = [(n, r) for n, r in enumerate(rows[1:], start=2) if any(c.strip() for c in r)]
    if not numbered:
        raise CsvImportError(["file has no transactions"])
    if len(numbered) > MAX_ROWS:
        raise CsvImportError([f"file has {len(numbered)} rows, the limit is {MAX_ROWS}"])

    txs: list[Tx] = []
    errors: list[str] = []
    for line_no, row in numbered:
        cells = [c.strip() for c in row] + [""] * (len(CSV_HEADER) - len(row))
        date_raw, type_raw, coin_raw, qty_raw, price_raw, fee_raw, note = cells[: len(CSV_HEADER)]
        problems = []

        executed_at = _parse_date(date_raw)
        if executed_at is None:
            problems.append("date must be ISO 8601 (e.g. 2024-01-31T12:00:00Z)")
        tx_type = type_raw.lower()
        if tx_type not in ("buy", "sell"):
            problems.append("type must be buy or sell")
        coin_id = coin_raw.lower()
        if not coin_id:
            problems.append("coin_id is required")
        quantity = _decimal(qty_raw)
        if quantity is None or quantity <= 0:
            problems.append("quantity must be a positive number")
        price = _decimal(price_raw)
        if price is None or price < 0:
            problems.append("price_usd must be a non-negative number")
        fee = _decimal(fee_raw or "0")
        if fee is None or fee < 0:
            problems.append("fee_usd must be a non-negative number")
        if len(note) > 200:
            problems.append("note must be at most 200 characters")

        if problems:
            errors.append(f"row {line_no}: {', '.join(problems)}")
            continue
        txs.append(Tx(executed_at, tx_type, coin_id, quantity, price, fee, note or None))

    if errors:
        raise CsvImportError(errors)
    return txs
```

- [ ] **Step 4: Implement the PDF report**

`services/worker/worker/report.py`
```python
import io
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


@dataclass(frozen=True)
class ReportRow:
    coin_id: str
    quantity: Decimal
    avg_cost: Decimal
    price: float | None
    value: float | None
    pnl: float | None


def _usd(value: float | Decimal | None) -> str:
    return "n/a" if value is None else f"${value:,.2f}"


def build_portfolio_report(
    portfolio_name: str,
    owner: str,
    rows: list[ReportRow],
    realized_pnl: Decimal,
    generated_at: datetime,
) -> bytes:
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, title=f"{portfolio_name} - CryptoFolio report")
    styles = getSampleStyleSheet()

    table_data = [["Coin", "Quantity", "Avg cost", "Price", "Value", "Unrealized P/L"]]
    for r in rows:
        table_data.append(
            [r.coin_id, f"{r.quantity.normalize():f}", _usd(r.avg_cost), _usd(r.price), _usd(r.value), _usd(r.pnl)]
        )
    total_value = sum(r.value for r in rows if r.value is not None)
    total_pnl = sum(r.pnl for r in rows if r.pnl is not None)
    table_data.append(["Total", "", "", "", _usd(total_value), _usd(total_pnl)])

    table = Table(table_data, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -2), [colors.white, colors.HexColor("#f1f5f9")]),
            ]
        )
    )

    story = [
        Paragraph(f"CryptoFolio &mdash; {escape(portfolio_name)}", styles["Title"]),
        Paragraph(
            f"Prepared for {escape(owner)} on {generated_at:%Y-%m-%d %H:%M} UTC", styles["Normal"]
        ),
        Spacer(1, 16),
        table,
        Spacer(1, 16),
        Paragraph(f"Realized P/L to date: {_usd(realized_pnl)}", styles["Normal"]),
        Paragraph("Average-cost method. Prices from the CryptoFolio price-service.", styles["Italic"]),
    ]
    doc.build(story)
    return buffer.getvalue()
```

- [ ] **Step 5: Run tests**

Run: `docker build -q --target test -t cf-worker-test services/worker && docker run --rm cf-worker-test`
Expected: ruff clean; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add services/worker
git commit -m "feat(worker): transaction CSV format and PDF portfolio report"
```

---

### Task 13: worker job handlers and Redis Stream consumer

**Files:**
- Create: `services/worker/worker/{jobs.py,consumer.py}`
- Test: `services/worker/tests/{conftest.py,test_jobs_integration.py,test_consumer_integration.py}`

**Interfaces:**
- Consumes: Tasks 11–12. api contract (Task 10): stream entries `{job_id}`, `jobs` row with `params.portfolioId` / `params.key`, and the key conventions.
- Produces:
  - `Job(id, user_id, type, params, attempts)`, `JobOutcome(result_key=None, result=None)`, `PermanentJobError`, `Ctx(pool, storage, prices, settings)`.
  - Handlers `export_csv(ctx, job)`, `import_csv(ctx, job)`, `report_pdf(ctx, job)`; `HANDLERS: dict[str, Callable[[Ctx, Job], JobOutcome]]`.
  - Result contract read by the api: export → `result_key=<userId>/<jobId>.csv`, `result={"filename","rows"}`; report → `.pdf`, `result={"filename"}`; import → `result={"imported": n}`.
  - `JobConsumer(redis, ctx, handlers, *, stream, group, consumer, max_attempts=3, block_ms=5000, claim_idle_ms=60000)` with `ensure_group()`, `poll_once() -> int`, `run(stop: threading.Event)`, attribute `last_heartbeat` (monotonic seconds).
  - Semantics: always XACK. A `PermanentJobError` marks the job `failed` with no retry. Any other exception re-queues it (status `queued`, new XADD) until `attempts >= max_attempts`, then marks it `failed`. Jobs already `done`/`failed` are skipped. Pending entries idle for more than `claim_idle_ms` are reclaimed with XAUTOCLAIM.
- Integration tests need `docker-compose.test.yml` running (Task 5) and `INTEGRATION=1`. From the host they use ports 55432/56379/59000. Run them inside the test network:
  `docker run --rm --network cryptofolio-test_default -e INTEGRATION=1 -e DATABASE_URL=postgres://cryptofolio:cryptofolio@postgres:5432/cryptofolio_test -e REDIS_URL=redis://redis:6379/1 -e S3_ENDPOINT=http://minio:9000 cf-worker-test`

- [ ] **Step 1: Test fixtures**

`services/worker/tests/conftest.py`
```python
import os
import uuid
from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest
from psycopg.types.json import Jsonb
from redis import Redis

from worker.config import Settings
from worker.db import make_pool
from worker.jobs import Ctx, Job
from worker.storage import Storage

integration = pytest.mark.skipif(
    os.getenv("INTEGRATION") != "1", reason="set INTEGRATION=1 and start docker-compose.test.yml"
)


class FakePrices:
    def __init__(self):
        self.prices = {"bitcoin": 50000.0, "ethereum": 3000.0}
        self.fail = False

    def get_prices(self, ids):
        if self.fail:
            raise httpx.ConnectError("price-service down")
        return {i: self.prices[i] for i in ids if i in self.prices}

    def get_coins(self):
        return {i: {"id": i, "symbol": i[:3], "name": i.title()} for i in self.prices}


@pytest.fixture
def settings() -> Settings:
    return Settings(
        database_url=os.getenv(
            "DATABASE_URL", "postgres://cryptofolio:cryptofolio@localhost:55432/cryptofolio_test"
        ),
        redis_url=os.getenv("REDIS_URL", "redis://localhost:56379/1"),
        s3_endpoint=os.getenv("S3_ENDPOINT", "http://localhost:59000"),
        jobs_stream="jobs-worker-test",
        jobs_group="workers-test",
    )


@pytest.fixture
def pool(settings):
    p = make_pool(settings.database_url)
    with p.connection() as conn:
        conn.execute(
            "TRUNCATE users, portfolios, transactions, watchlist, alerts, notifications, "
            "portfolio_snapshots, jobs CASCADE"
        )
    yield p
    p.close()


@pytest.fixture
def redis(settings):
    r = Redis.from_url(settings.redis_url, decode_responses=True)
    r.flushdb()
    yield r
    r.close()


@pytest.fixture
def prices() -> FakePrices:
    return FakePrices()


@pytest.fixture
def ctx(pool, settings, prices) -> Ctx:
    return Ctx(pool=pool, storage=Storage(settings), prices=prices, settings=settings)


def create_user(pool, email="alice@example.com") -> str:
    with pool.connection() as conn:
        return str(
            conn.execute(
                "INSERT INTO users (email, password_hash, display_name) VALUES (%s, 'x', 'Alice') RETURNING id",
                (email,),
            ).fetchone()["id"]
        )


def create_portfolio(pool, user_id, name="Main") -> str:
    with pool.connection() as conn:
        return str(
            conn.execute(
                "INSERT INTO portfolios (user_id, name) VALUES (%s, %s) RETURNING id", (user_id, name)
            ).fetchone()["id"]
        )


def add_tx(pool, portfolio_id, coin, type_, qty, price, when=datetime(2024, 1, 1, tzinfo=UTC)):
    with pool.connection() as conn:
        conn.execute(
            "INSERT INTO transactions (portfolio_id, coin_id, type, quantity, price_usd, executed_at) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (portfolio_id, coin, type_, Decimal(qty), Decimal(price), when),
        )


def create_job(pool, user_id, type_, params, status="queued") -> Job:
    with pool.connection() as conn:
        row = conn.execute(
            "INSERT INTO jobs (user_id, type, params, status) VALUES (%s, %s, %s, %s) RETURNING id",
            (user_id, type_, Jsonb(params), status),
        ).fetchone()
    return Job(id=str(row["id"]), user_id=user_id, type=type_, params=params, attempts=1)


def get_job(pool, job_id) -> dict:
    with pool.connection() as conn:
        return conn.execute("SELECT * FROM jobs WHERE id = %s", (job_id,)).fetchone()


def random_key(user_id: str) -> str:
    return f"{user_id}/{uuid.uuid4()}.csv"
```

- [ ] **Step 2: Write failing handler integration tests**

`services/worker/tests/test_jobs_integration.py`
```python
from decimal import Decimal

import pytest

from tests.conftest import add_tx, create_job, create_portfolio, create_user, integration, random_key
from worker import jobs
from worker.jobs import PermanentJobError

pytestmark = integration

CSV = (
    "date,type,coin_id,quantity,price_usd,fee_usd,note\n"
    "2024-01-01T00:00:00Z,buy,bitcoin,1,40000,5,\n"
    "2024-02-01T00:00:00Z,sell,bitcoin,0.25,45000,0,take profit\n"
)


def upload(ctx, key, text):
    ctx.storage.put(ctx.storage.imports_bucket, key, text.encode(), "text/csv")


def tx_count(pool, portfolio_id):
    with pool.connection() as conn:
        return conn.execute(
            "SELECT count(*) AS n FROM transactions WHERE portfolio_id = %s", (portfolio_id,)
        ).fetchone()["n"]


def test_export_csv_writes_object_and_returns_filename(ctx, pool):
    user = create_user(pool)
    portfolio = create_portfolio(pool, user, "My Main!")
    add_tx(pool, portfolio, "bitcoin", "buy", "0.5", "42000")
    job = create_job(pool, user, "export_csv", {"portfolioId": portfolio})
    outcome = jobs.export_csv(ctx, job)
    assert outcome.result_key == f"{user}/{job.id}.csv"
    assert outcome.result == {"filename": "my-main-transactions.csv", "rows": 1}
    body = ctx.storage.get(ctx.storage.exports_bucket, outcome.result_key).decode()
    assert "bitcoin,0.5,42000" in body


def test_import_csv_inserts_all_rows(ctx, pool):
    user = create_user(pool)
    portfolio = create_portfolio(pool, user)
    key = random_key(user)
    upload(ctx, key, CSV)
    outcome = jobs.import_csv(ctx, create_job(pool, user, "import_csv", {"portfolioId": portfolio, "key": key}))
    assert outcome.result == {"imported": 2}
    assert tx_count(pool, portfolio) == 2


def test_import_rejects_oversell_and_inserts_nothing(ctx, pool):
    user = create_user(pool)
    portfolio = create_portfolio(pool, user)
    key = random_key(user)
    upload(ctx, key, CSV.replace("sell,bitcoin,0.25", "sell,bitcoin,5"))
    with pytest.raises(PermanentJobError, match="cannot sell"):
        jobs.import_csv(ctx, create_job(pool, user, "import_csv", {"portfolioId": portfolio, "key": key}))
    assert tx_count(pool, portfolio) == 0


def test_import_rejects_unknown_coins(ctx, pool):
    user = create_user(pool)
    portfolio = create_portfolio(pool, user)
    key = random_key(user)
    upload(ctx, key, CSV.replace("bitcoin", "notacoin"))
    with pytest.raises(PermanentJobError, match="notacoin"):
        jobs.import_csv(ctx, create_job(pool, user, "import_csv", {"portfolioId": portfolio, "key": key}))


def test_import_reports_csv_errors(ctx, pool):
    user = create_user(pool)
    portfolio = create_portfolio(pool, user)
    key = random_key(user)
    upload(ctx, key, "date,type,coin_id,quantity,price_usd,fee_usd\n2024-01-01,buy,bitcoin,-1,1,0\n")
    with pytest.raises(PermanentJobError, match="row 2"):
        jobs.import_csv(ctx, create_job(pool, user, "import_csv", {"portfolioId": portfolio, "key": key}))


def test_import_missing_file_and_foreign_key_and_foreign_portfolio(ctx, pool):
    alice = create_user(pool, "alice@example.com")
    bob = create_user(pool, "bob@example.com")
    alice_portfolio = create_portfolio(pool, alice)
    with pytest.raises(PermanentJobError, match="not found"):
        jobs.import_csv(ctx, create_job(pool, alice, "import_csv", {"portfolioId": alice_portfolio, "key": random_key(alice)}))
    with pytest.raises(PermanentJobError, match="invalid upload key"):
        jobs.import_csv(ctx, create_job(pool, alice, "import_csv", {"portfolioId": alice_portfolio, "key": random_key(bob)}))
    key = random_key(bob)
    upload(ctx, key, CSV)
    with pytest.raises(PermanentJobError, match="portfolio not found"):
        jobs.import_csv(ctx, create_job(pool, bob, "import_csv", {"portfolioId": alice_portfolio, "key": key}))


def test_report_pdf(ctx, pool):
    user = create_user(pool)
    portfolio = create_portfolio(pool, user)
    add_tx(pool, portfolio, "bitcoin", "buy", "1", "40000")
    add_tx(pool, portfolio, "solana", "buy", "2", "100")  # no price in FakePrices
    job = create_job(pool, user, "report_pdf", {"portfolioId": portfolio})
    outcome = jobs.report_pdf(ctx, job)
    assert outcome.result_key == f"{user}/{job.id}.pdf"
    assert ctx.storage.get(ctx.storage.exports_bucket, outcome.result_key).startswith(b"%PDF")


def test_export_then_import_round_trips(ctx, pool):
    user = create_user(pool)
    source = create_portfolio(pool, user, "Source")
    target = create_portfolio(pool, user, "Target")
    add_tx(pool, source, "bitcoin", "buy", "0.123456789012345678", "42000.5")
    exported = jobs.export_csv(ctx, create_job(pool, user, "export_csv", {"portfolioId": source}))
    key = random_key(user)
    upload(ctx, key, ctx.storage.get(ctx.storage.exports_bucket, exported.result_key).decode())
    jobs.import_csv(ctx, create_job(pool, user, "import_csv", {"portfolioId": target, "key": key}))
    with pool.connection() as conn:
        qty = conn.execute("SELECT quantity FROM transactions WHERE portfolio_id = %s", (target,)).fetchone()["quantity"]
    assert qty == Decimal("0.123456789012345678")
```

- [ ] **Step 3: Write failing consumer integration tests**

`services/worker/tests/test_consumer_integration.py`
```python
import pytest

from tests.conftest import add_tx, create_job, create_portfolio, create_user, get_job, integration
from worker.consumer import JobConsumer
from worker.jobs import HANDLERS, JobOutcome, PermanentJobError

pytestmark = integration


def make_consumer(redis, ctx, handlers=None, **kwargs) -> JobConsumer:
    consumer = JobConsumer(
        redis,
        ctx,
        handlers or HANDLERS,
        stream=ctx.settings.jobs_stream,
        group=ctx.settings.jobs_group,
        consumer="test-consumer",
        block_ms=100,
        **kwargs,
    )
    consumer.ensure_group()
    return consumer


def publish(redis, ctx, job_id):
    redis.xadd(ctx.settings.jobs_stream, {"job_id": job_id})


@pytest.fixture
def user_portfolio(pool):
    user = create_user(pool)
    return user, create_portfolio(pool, user)


def test_processes_an_export_job_end_to_end(redis, ctx, pool, user_portfolio):
    user, portfolio = user_portfolio
    add_tx(pool, portfolio, "bitcoin", "buy", "1", "40000")
    job = create_job(pool, user, "export_csv", {"portfolioId": portfolio})
    consumer = make_consumer(redis, ctx)
    publish(redis, ctx, job.id)
    assert consumer.poll_once() == 1
    row = get_job(pool, job.id)
    assert row["status"] == "done" and row["attempts"] == 1
    assert row["result_key"] == f"{user}/{job.id}.csv"
    assert redis.xpending(ctx.settings.jobs_stream, ctx.settings.jobs_group)["pending"] == 0


def test_permanent_errors_fail_without_retry(redis, ctx, pool, user_portfolio):
    user, portfolio = user_portfolio
    job = create_job(pool, user, "import_csv", {"portfolioId": portfolio, "key": f"{user}/missing.csv"})
    consumer = make_consumer(redis, ctx)
    publish(redis, ctx, job.id)
    consumer.poll_once()
    row = get_job(pool, job.id)
    assert row["status"] == "failed" and "not found" in row["error"]
    assert redis.xlen(ctx.settings.jobs_stream) == 1  # nothing re-queued


def test_crashes_are_retried_then_marked_failed(redis, ctx, pool, user_portfolio):
    user, portfolio = user_portfolio
    job = create_job(pool, user, "export_csv", {"portfolioId": portfolio})

    def boom(_ctx, _job):
        raise RuntimeError("disk on fire")

    consumer = make_consumer(redis, ctx, {"export_csv": boom}, max_attempts=3)
    publish(redis, ctx, job.id)
    consumer.poll_once()
    assert get_job(pool, job.id)["status"] == "queued"
    consumer.poll_once()
    consumer.poll_once()
    row = get_job(pool, job.id)
    assert row["status"] == "failed" and row["attempts"] == 3
    assert "gave up after 3 attempts" in row["error"]
    assert consumer.poll_once() == 0


def test_reclaims_messages_left_by_a_dead_consumer(redis, ctx, pool, user_portfolio):
    user, portfolio = user_portfolio
    job = create_job(pool, user, "export_csv", {"portfolioId": portfolio})
    consumer = make_consumer(redis, ctx, claim_idle_ms=0)
    publish(redis, ctx, job.id)
    # A consumer that reads the message and then "dies" without XACK:
    redis.xreadgroup(ctx.settings.jobs_group, "dead-consumer", {ctx.settings.jobs_stream: ">"}, count=1)
    consumer.poll_once()
    assert get_job(pool, job.id)["status"] == "done"


def test_skips_jobs_that_are_already_finished(redis, ctx, pool, user_portfolio):
    user, portfolio = user_portfolio
    job = create_job(pool, user, "export_csv", {"portfolioId": portfolio}, status="done")
    calls = []

    def handler(_ctx, j):
        calls.append(j.id)
        return JobOutcome()

    consumer = make_consumer(redis, ctx, {"export_csv": handler})
    publish(redis, ctx, job.id)
    consumer.poll_once()
    assert calls == []


def test_garbage_messages_are_acknowledged(redis, ctx):
    consumer = make_consumer(redis, ctx)
    redis.xadd(ctx.settings.jobs_stream, {"job_id": "not-a-uuid"})
    redis.xadd(ctx.settings.jobs_stream, {"something": "else"})
    consumer.poll_once()
    assert redis.xpending(ctx.settings.jobs_stream, ctx.settings.jobs_group)["pending"] == 0


def test_unknown_job_type_fails_permanently(redis, ctx, pool, user_portfolio):
    user, portfolio = user_portfolio
    job = create_job(pool, user, "export_csv", {"portfolioId": portfolio})
    consumer = make_consumer(redis, ctx, {"something_else": lambda c, j: JobOutcome()})
    publish(redis, ctx, job.id)
    consumer.poll_once()
    assert get_job(pool, job.id)["status"] == "failed"


def test_permanent_error_class_is_exported():
    assert issubclass(PermanentJobError, Exception)
```

- [ ] **Step 4: Run to verify failure**

Run (test infra from Task 5 must be up):
```bash
docker build -q --target test -t cf-worker-test services/worker
docker run --rm --network cryptofolio-test_default -e INTEGRATION=1 \
  -e DATABASE_URL=postgres://cryptofolio:cryptofolio@postgres:5432/cryptofolio_test \
  -e REDIS_URL=redis://redis:6379/1 -e S3_ENDPOINT=http://minio:9000 cf-worker-test pytest -q
```
Expected: FAIL `ModuleNotFoundError: No module named 'worker.jobs'`

- [ ] **Step 5: Implement job handlers**

`services/worker/worker/jobs.py`
```python
"""Background job handlers. Each takes (Ctx, Job) and returns a JobOutcome.

Raise PermanentJobError for bad input (never retried). Any other exception is
treated as transient and retried by the consumer.
"""

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from botocore.exceptions import ClientError
from psycopg_pool import ConnectionPool

from .config import Settings
from .csv_io import CsvImportError, build_transactions_csv, parse_transactions_csv
from .portfolio import OversellError, Tx, compute_positions
from .prices import PriceClient
from .report import ReportRow, build_portfolio_report
from .storage import Storage


@dataclass
class Job:
    id: str
    user_id: str
    type: str
    params: dict[str, Any]
    attempts: int


@dataclass
class JobOutcome:
    result_key: str | None = None
    result: dict[str, Any] | None = None


@dataclass
class Ctx:
    pool: ConnectionPool
    storage: Storage
    prices: PriceClient
    settings: Settings


class PermanentJobError(Exception):
    """The job can never succeed (bad input); do not retry."""


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "portfolio"


def _owned_portfolio(conn, job: Job) -> dict:
    row = conn.execute(
        "SELECT id, name FROM portfolios WHERE id = %s AND user_id = %s",
        (job.params.get("portfolioId"), job.user_id),
    ).fetchone()
    if row is None:
        raise PermanentJobError("portfolio not found")
    return row


def _load_txs(conn, portfolio_id) -> list[Tx]:
    rows = conn.execute(
        "SELECT executed_at, type, coin_id, quantity, price_usd, fee_usd, note FROM transactions "
        "WHERE portfolio_id = %s ORDER BY executed_at, created_at",
        (portfolio_id,),
    ).fetchall()
    return [Tx(**row) for row in rows]


def export_csv(ctx: Ctx, job: Job) -> JobOutcome:
    with ctx.pool.connection() as conn:
        portfolio = _owned_portfolio(conn, job)
        txs = _load_txs(conn, portfolio["id"])
    key = f"{job.user_id}/{job.id}.csv"
    ctx.storage.put(ctx.storage.exports_bucket, key, build_transactions_csv(txs).encode(), "text/csv")
    return JobOutcome(
        result_key=key,
        result={"filename": f"{_slug(portfolio['name'])}-transactions.csv", "rows": len(txs)},
    )


def import_csv(ctx: Ctx, job: Job) -> JobOutcome:
    key = str(job.params.get("key", ""))
    if not key.startswith(f"{job.user_id}/"):
        raise PermanentJobError("invalid upload key")
    try:
        raw = ctx.storage.get(ctx.storage.imports_bucket, key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            raise PermanentJobError("uploaded file not found") from exc
        raise
    try:
        parsed = parse_transactions_csv(raw.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise PermanentJobError("file must be a UTF-8 encoded CSV") from exc
    except CsvImportError as exc:
        raise PermanentJobError(str(exc)) from exc

    known = ctx.prices.get_coins()
    unknown = sorted({t.coin_id for t in parsed} - set(known))
    if unknown:
        raise PermanentJobError(f"unknown coin ids: {', '.join(unknown)}")

    with ctx.pool.connection() as conn, conn.transaction():
        portfolio = _owned_portfolio(conn, job)
        # Serialise imports/edits into the same portfolio while we validate.
        conn.execute("SELECT id FROM portfolios WHERE id = %s FOR UPDATE", (portfolio["id"],))
        try:
            compute_positions(_load_txs(conn, portfolio["id"]) + parsed)
        except OversellError as exc:
            raise PermanentJobError(str(exc)) from exc
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO transactions "
                "(portfolio_id, coin_id, type, quantity, price_usd, fee_usd, executed_at, note) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                [
                    (portfolio["id"], t.coin_id, t.type, t.quantity, t.price_usd, t.fee_usd, t.executed_at, t.note)
                    for t in parsed
                ],
            )
    return JobOutcome(result={"imported": len(parsed)})


def report_pdf(ctx: Ctx, job: Job) -> JobOutcome:
    with ctx.pool.connection() as conn:
        portfolio = _owned_portfolio(conn, job)
        txs = _load_txs(conn, portfolio["id"])
        owner = conn.execute(
            "SELECT display_name FROM users WHERE id = %s", (job.user_id,)
        ).fetchone()["display_name"]

    positions = compute_positions(txs)
    open_positions = [p for p in positions.values() if p.quantity > 0]
    prices = ctx.prices.get_prices([p.coin_id for p in open_positions])
    rows = []
    for p in sorted(open_positions, key=lambda p: p.coin_id):
        price = prices.get(p.coin_id)
        value = float(p.quantity) * price if price is not None else None
        rows.append(
            ReportRow(
                coin_id=p.coin_id,
                quantity=p.quantity,
                avg_cost=p.avg_cost,
                price=price,
                value=value,
                pnl=value - float(p.cost_basis) if value is not None else None,
            )
        )
    realized = sum((p.realized_pnl for p in positions.values()), Decimal(0))
    pdf = build_portfolio_report(portfolio["name"], owner, rows, realized, datetime.now(UTC))

    key = f"{job.user_id}/{job.id}.pdf"
    ctx.storage.put(ctx.storage.exports_bucket, key, pdf, "application/pdf")
    return JobOutcome(result_key=key, result={"filename": f"{_slug(portfolio['name'])}-report.pdf"})


HANDLERS: dict[str, Callable[[Ctx, Job], JobOutcome]] = {
    "export_csv": export_csv,
    "import_csv": import_csv,
    "report_pdf": report_pdf,
}
```

- [ ] **Step 6: Implement the consumer**

`services/worker/worker/consumer.py`
```python
"""Redis Streams consumer-group loop.

    api --XADD job_id--> stream "jobs" --XREADGROUP--> worker(s) --XACK

Run several worker containers: the consumer group spreads messages across them.
A message read by a worker that died is reclaimed with XAUTOCLAIM after it has
been idle for `claim_idle_ms`.
"""

import logging
import threading
import time
import uuid
from collections.abc import Callable

from psycopg.types.json import Jsonb
from redis import Redis
from redis.exceptions import ResponseError

from .jobs import Ctx, Job, JobOutcome, PermanentJobError
from .metrics import JOB_DURATION, JOBS

log = logging.getLogger("worker.consumer")


class JobConsumer:
    def __init__(
        self,
        redis: Redis,
        ctx: Ctx,
        handlers: dict[str, Callable[[Ctx, Job], JobOutcome]],
        *,
        stream: str,
        group: str,
        consumer: str,
        max_attempts: int = 3,
        block_ms: int = 5000,
        claim_idle_ms: int = 60_000,
    ):
        self._redis = redis
        self._ctx = ctx
        self._handlers = handlers
        self._stream = stream
        self._group = group
        self._consumer = consumer
        self._max_attempts = max_attempts
        self._block_ms = block_ms
        self._claim_idle_ms = claim_idle_ms
        self.last_heartbeat = time.monotonic()

    def ensure_group(self) -> None:
        try:
            self._redis.xgroup_create(self._stream, self._group, id="0", mkstream=True)
        except ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    def run(self, stop: threading.Event) -> None:
        self.ensure_group()
        log.info("consuming", extra={"task": f"{self._stream}/{self._group}/{self._consumer}"})
        while not stop.is_set():
            try:
                self.poll_once()
            except Exception:
                log.exception("consumer loop error; backing off")
                stop.wait(2)

    def poll_once(self) -> int:
        self.last_heartbeat = time.monotonic()
        handled = self._reclaim()
        response = self._redis.xreadgroup(
            self._group, self._consumer, {self._stream: ">"}, count=10, block=self._block_ms
        )
        for _stream, messages in response or []:
            for message_id, fields in messages:
                self._handle(message_id, fields)
                handled += 1
        return handled

    def _reclaim(self) -> int:
        _next_id, messages, *_ = self._redis.xautoclaim(
            self._stream, self._group, self._consumer,
            min_idle_time=self._claim_idle_ms, start_id="0-0", count=10,
        )
        for message_id, fields in messages:
            log.warning("reclaimed stale message", extra={"message_id": message_id})
            self._handle(message_id, fields or {})
        return len(messages)

    def _handle(self, message_id: str, fields: dict) -> None:
        try:
            self._process(fields.get("job_id"))
        finally:
            self._redis.xack(self._stream, self._group, message_id)

    def _process(self, job_id: str | None) -> None:
        job = self._start(job_id)
        if job is None:
            return
        extra = {"job_id": job.id, "job_type": job.type, "attempts": job.attempts}
        started = time.perf_counter()
        try:
            handler = self._handlers.get(job.type)
            if handler is None:
                raise PermanentJobError(f"unknown job type: {job.type}")
            outcome = handler(self._ctx, job)
        except PermanentJobError as exc:
            log.warning("job failed permanently: %s", exc, extra=extra)
            self._finish(job, "failed", error=str(exc))
            JOBS.labels(job.type, "failed").inc()
        except Exception as exc:
            if job.attempts >= self._max_attempts:
                log.exception("job failed, giving up", extra=extra)
                self._finish(job, "failed", error=f"gave up after {job.attempts} attempts: {exc}")
                JOBS.labels(job.type, "failed").inc()
            else:
                log.exception("job failed, will retry", extra=extra)
                self._requeue(job)
                JOBS.labels(job.type, "retried").inc()
        else:
            log.info("job done", extra=extra)
            self._finish(job, "done", outcome=outcome)
            JOBS.labels(job.type, "done").inc()
        finally:
            JOB_DURATION.labels(job.type).observe(time.perf_counter() - started)

    def _start(self, job_id: str | None) -> Job | None:
        try:
            uuid.UUID(str(job_id))
        except ValueError:
            log.warning("ignoring message without a valid job_id", extra={"job_id": job_id})
            return None
        with self._ctx.pool.connection() as conn:
            row = conn.execute(
                "UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = now() "
                "WHERE id = %s AND status IN ('queued', 'running') "
                "RETURNING id, user_id, type, params, attempts",
                (job_id,),
            ).fetchone()
        if row is None:
            return None
        return Job(
            id=str(row["id"]), user_id=str(row["user_id"]), type=row["type"],
            params=row["params"], attempts=row["attempts"],
        )

    def _finish(self, job: Job, status: str, outcome: JobOutcome | None = None, error: str | None = None):
        outcome = outcome or JobOutcome()
        with self._ctx.pool.connection() as conn:
            conn.execute(
                "UPDATE jobs SET status = %s, result_key = %s, result = %s, error = %s, "
                "updated_at = now() WHERE id = %s",
                (
                    status,
                    outcome.result_key,
                    Jsonb(outcome.result) if outcome.result is not None else None,
                    error[:1000] if error else None,
                    job.id,
                ),
            )

    def _requeue(self, job: Job) -> None:
        with self._ctx.pool.connection() as conn:
            conn.execute("UPDATE jobs SET status = 'queued', updated_at = now() WHERE id = %s", (job.id,))
        self._redis.xadd(self._stream, {"job_id": job.id}, maxlen=10_000, approximate=True)
```

- [ ] **Step 7: Run unit + integration tests**

Run the Step 4 command again (plus `docker run --rm cf-worker-test` for unit-only).
Expected: ruff clean; all unit and integration tests PASS.

- [ ] **Step 8: Commit**

```bash
git add services/worker
git commit -m "feat(worker): export/import/report job handlers and redis streams consumer with retries"
```

---

### Task 14: worker scheduled tasks, health server, entrypoint, compose

**Files:**
- Create: `services/worker/worker/{scheduled.py,health.py,main.py}`
- Modify: `docker-compose.yml` (add `worker`)
- Test: `services/worker/tests/{test_alerts.py,test_scheduled_integration.py,test_health.py}`

**Interfaces:**
- Consumes: `Ctx` (Task 13), tables `alerts`, `notifications`, `portfolio_snapshots`.
- Produces:
  - `evaluate_alert(direction, target, price) -> bool` (inclusive: above ⇒ price ≥ target; below ⇒ price ≤ target).
  - `check_alerts(ctx) -> int`: triggers each active alert at most once, sets `active=false, triggered_at=now()`, inserts a notification.
  - `take_snapshots(ctx, today=None) -> int`: upserts `(portfolio_id, today)` with Σ qty × price. Portfolios with a missing coin price are skipped. Empty portfolios are written as 0.
  - `HealthServer(port, liveness, readiness)` serving `/healthz`, `/readyz`, `/metrics`, with `.start()`, `.stop()`, `.port`.
  - `python -m worker.main` runs: the consumer loop in the main thread, APScheduler (alerts every `ALERT_CHECK_INTERVAL_SECONDS`, snapshots hourly at :00 and once at start), and the health server. SIGTERM triggers a graceful stop.

- [ ] **Step 1: Write failing tests**

`services/worker/tests/test_alerts.py`
```python
from decimal import Decimal

import pytest

from worker.scheduled import evaluate_alert


@pytest.mark.parametrize(
    "direction,target,price,expected",
    [
        ("above", "100", 100.0, True),
        ("above", "100", 99.99, False),
        ("below", "100", 100.0, True),
        ("below", "100", 100.01, False),
        ("above", "0.0000001", 0.0000002, True),
    ],
)
def test_evaluate_alert(direction, target, price, expected):
    assert evaluate_alert(direction, Decimal(target), price) is expected
```

`services/worker/tests/test_health.py`
```python
import urllib.error
import urllib.request

import pytest

from worker.health import HealthServer


@pytest.fixture
def server():
    state = {"alive": True, "ready": {"postgres": "ok", "redis": "ok"}}
    srv = HealthServer(0, liveness=lambda: state["alive"], readiness=lambda: state["ready"])
    srv.start()
    yield srv, state
    srv.stop()


def get(srv, path):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{srv.port}{path}", timeout=2) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def test_healthz_follows_liveness(server):
    srv, state = server
    assert get(srv, "/healthz")[0] == 200
    state["alive"] = False
    assert get(srv, "/healthz")[0] == 503


def test_readyz_reports_checks(server):
    srv, state = server
    assert get(srv, "/readyz") == (200, '{"status": "ready", "checks": {"postgres": "ok", "redis": "ok"}}')
    state["ready"] = {"postgres": "error", "redis": "ok"}
    assert get(srv, "/readyz")[0] == 503


def test_metrics_and_404(server):
    srv, _ = server
    status, body = get(srv, "/metrics")
    assert status == 200 and "worker_jobs_total" in body
    assert get(srv, "/nope")[0] == 404
```

`services/worker/tests/test_scheduled_integration.py`
```python
from datetime import date
from decimal import Decimal

from tests.conftest import add_tx, create_portfolio, create_user, integration
from worker.scheduled import check_alerts, take_snapshots

pytestmark = integration


def add_alert(pool, user_id, coin, direction, target):
    with pool.connection() as conn:
        conn.execute(
            "INSERT INTO alerts (user_id, coin_id, direction, target_price) VALUES (%s, %s, %s, %s)",
            (user_id, coin, direction, Decimal(target)),
        )


def test_triggers_matching_alerts_once(ctx, pool):
    user = create_user(pool)
    add_alert(pool, user, "bitcoin", "above", "45000")   # 50000 >= 45000 -> trigger
    add_alert(pool, user, "bitcoin", "below", "45000")   # no
    add_alert(pool, user, "solana", "above", "1")        # no price -> skipped
    assert check_alerts(ctx) == 1
    assert check_alerts(ctx) == 0
    with pool.connection() as conn:
        notes = conn.execute("SELECT title, body FROM notifications WHERE user_id = %s", (user,)).fetchall()
        active = conn.execute("SELECT count(*) AS n FROM alerts WHERE active").fetchone()["n"]
    assert len(notes) == 1
    assert "bitcoin" in notes[0]["title"] and "$50,000.00" in notes[0]["body"]
    assert active == 2


def test_no_alerts_does_not_call_price_service(ctx, prices):
    prices.fail = True
    assert check_alerts(ctx) == 0


def test_snapshots_value_and_upsert(ctx, pool, prices):
    user = create_user(pool)
    main = create_portfolio(pool, user, "Main")
    empty = create_portfolio(pool, user, "Empty")
    partial = create_portfolio(pool, user, "Partial")
    add_tx(pool, main, "bitcoin", "buy", "2", "1")
    add_tx(pool, main, "bitcoin", "sell", "0.5", "1")
    add_tx(pool, main, "ethereum", "buy", "1", "1")
    add_tx(pool, partial, "solana", "buy", "1", "1")  # no price -> skipped
    today = date(2024, 5, 1)

    assert take_snapshots(ctx, today) == 2
    prices.prices["bitcoin"] = 60000.0
    take_snapshots(ctx, today)

    with pool.connection() as conn:
        rows = {
            r["portfolio_id"]: r["value_usd"]
            for r in conn.execute("SELECT portfolio_id::text, value_usd FROM portfolio_snapshots WHERE date = %s", (today,))
        }
    assert rows == {main: Decimal("93000.00"), empty: Decimal("0.00")}
```

- [ ] **Step 2: Run to verify failure**

Run: `docker build -q --target test -t cf-worker-test services/worker && docker run --rm cf-worker-test pytest -q tests/test_alerts.py tests/test_health.py`
Expected: FAIL `ModuleNotFoundError: No module named 'worker.scheduled'`

- [ ] **Step 3: Implement scheduled tasks**

`services/worker/worker/scheduled.py`
```python
import logging
from datetime import UTC, date, datetime
from decimal import Decimal

from psycopg.rows import dict_row

from .jobs import Ctx
from .metrics import ALERTS_TRIGGERED, SNAPSHOTS_WRITTEN

log = logging.getLogger("worker.scheduled")
CENT = Decimal("0.01")


def evaluate_alert(direction: str, target: Decimal, price: float) -> bool:
    current = Decimal(str(price))
    return current >= target if direction == "above" else current <= target


def check_alerts(ctx: Ctx) -> int:
    with ctx.pool.connection() as conn:
        alerts = conn.execute(
            "SELECT id, user_id, coin_id, direction, target_price FROM alerts WHERE active"
        ).fetchall()
    if not alerts:
        return 0

    prices = ctx.prices.get_prices(sorted({a["coin_id"] for a in alerts}))
    triggered = 0
    for alert in alerts:
        price = prices.get(alert["coin_id"])
        if price is None or not evaluate_alert(alert["direction"], alert["target_price"], price):
            continue
        with ctx.pool.connection() as conn, conn.transaction():
            claimed = conn.execute(
                "UPDATE alerts SET active = false, triggered_at = now() "
                "WHERE id = %s AND active RETURNING id",
                (alert["id"],),
            ).fetchone()
            if claimed is None:  # another worker got there first
                continue
            target = alert["target_price"]
            conn.execute(
                "INSERT INTO notifications (user_id, title, body) VALUES (%s, %s, %s)",
                (
                    alert["user_id"],
                    f"{alert['coin_id']} is {alert['direction']} ${target:,.2f}",
                    f"Current price ${price:,.2f} crossed your {alert['direction']} "
                    f"${target:,.2f} alert.",
                ),
            )
        triggered += 1
    ALERTS_TRIGGERED.inc(triggered)
    return triggered


def take_snapshots(ctx: Ctx, today: date | None = None) -> int:
    today = today or datetime.now(UTC).date()
    with ctx.pool.connection() as conn:
        rows = conn.execute(
            "SELECT p.id::text AS portfolio_id, t.coin_id, "
            "SUM(CASE WHEN t.type = 'buy' THEN t.quantity ELSE -t.quantity END) AS quantity "
            "FROM portfolios p LEFT JOIN transactions t ON t.portfolio_id = p.id "
            "GROUP BY p.id, t.coin_id"
        ).fetchall()

    holdings: dict[str, dict[str, Decimal]] = {}
    for row in rows:
        coins_held = holdings.setdefault(row["portfolio_id"], {})  # empty portfolios too
        if row["coin_id"] and row["quantity"] > 0:
            coins_held[row["coin_id"]] = row["quantity"]

    coins = sorted({coin for coins in holdings.values() for coin in coins})
    prices = ctx.prices.get_prices(coins) if coins else {}

    values = []
    for portfolio_id, coins_held in holdings.items():
        missing = [c for c in coins_held if c not in prices]
        if missing:
            log.warning("skipping snapshot, missing prices for %s", missing, extra={"task": "snapshots"})
            continue
        total = sum((qty * Decimal(str(prices[c])) for c, qty in coins_held.items()), Decimal(0))
        values.append((portfolio_id, today, total.quantize(CENT)))

    with ctx.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.executemany(
            "INSERT INTO portfolio_snapshots (portfolio_id, date, value_usd) VALUES (%s, %s, %s) "
            "ON CONFLICT (portfolio_id, date) DO UPDATE SET value_usd = EXCLUDED.value_usd",
            values,
        )
    SNAPSHOTS_WRITTEN.inc(len(values))
    return len(values)
```

- [ ] **Step 4: Implement the health server**

`services/worker/worker/health.py`
```python
"""Tiny HTTP server so orchestrators can probe a process that has no web API."""

import json
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from prometheus_client import CONTENT_TYPE_LATEST, generate_latest


class HealthServer:
    def __init__(
        self,
        port: int,
        liveness: Callable[[], bool],
        readiness: Callable[[], dict[str, str]],
    ):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                if self.path == "/healthz":
                    ok = liveness()
                    outer._send(self, 200 if ok else 503, {"status": "ok" if ok else "stalled"})
                elif self.path == "/readyz":
                    checks = readiness()
                    ready = all(v == "ok" for v in checks.values())
                    outer._send(
                        self, 200 if ready else 503,
                        {"status": "ready" if ready else "not_ready", "checks": checks},
                    )
                elif self.path == "/metrics":
                    body = generate_latest()
                    self.send_response(200)
                    self.send_header("Content-Type", CONTENT_TYPE_LATEST)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    outer._send(self, 404, {"status": "not_found"})

            def log_message(self, *_args):  # keep probe traffic out of the logs
                pass

        self._server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @staticmethod
    def _send(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
```

- [ ] **Step 5: Implement the entrypoint**

`services/worker/worker/main.py`
```python
import logging
import signal
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime

from apscheduler.schedulers.background import BackgroundScheduler
from redis import Redis

from .config import Settings
from .consumer import JobConsumer
from .db import make_pool
from .health import HealthServer
from .jobs import HANDLERS, Ctx
from .logging_setup import setup_logging
from .metrics import SCHEDULED_FAILURES
from .prices import PriceClient
from .scheduled import check_alerts, take_snapshots
from .storage import Storage

log = logging.getLogger("worker")
LIVENESS_WINDOW_SECONDS = 300


def run_safely(fn: Callable[[Ctx], int], ctx: Ctx) -> Callable[[], None]:
    def wrapper() -> None:
        started = time.perf_counter()
        try:
            result = fn(ctx)
            log.info(
                "%s finished", fn.__name__,
                extra={"task": fn.__name__, "result": result,
                       "duration_ms": round((time.perf_counter() - started) * 1000, 1)},
            )
        except Exception:
            SCHEDULED_FAILURES.labels(fn.__name__).inc()
            log.exception("%s failed", fn.__name__, extra={"task": fn.__name__})

    return wrapper


def check(fn: Callable[[], object]) -> str:
    try:
        fn()
        return "ok"
    except Exception:
        return "error"


def main() -> None:
    settings = Settings()
    setup_logging(settings.log_level)
    pool = make_pool(settings.database_url)
    redis = Redis.from_url(settings.redis_url, decode_responses=True, socket_timeout=10)
    ctx = Ctx(
        pool=pool,
        storage=Storage(settings),
        prices=PriceClient(settings.price_service_url),
        settings=settings,
    )
    consumer = JobConsumer(
        redis, ctx, HANDLERS,
        stream=settings.jobs_stream, group=settings.jobs_group,
        consumer=settings.worker_name, max_attempts=settings.max_attempts,
    )

    stop = threading.Event()

    def on_signal(signum, _frame):
        log.info("received signal %s, shutting down", signum)
        stop.set()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    def ping_db() -> None:
        with pool.connection(timeout=2) as conn:
            conn.execute("SELECT 1")

    health = HealthServer(
        settings.health_port,
        liveness=lambda: time.monotonic() - consumer.last_heartbeat < LIVENESS_WINDOW_SECONDS,
        readiness=lambda: {
            "postgres": check(ping_db),
            "redis": check(redis.ping),
            "storage": check(ctx.storage.ping),
        },
    )
    health.start()

    scheduler = BackgroundScheduler(timezone="UTC")
    now = datetime.now(UTC)
    scheduler.add_job(
        run_safely(check_alerts, ctx), "interval", id="check_alerts",
        seconds=settings.alert_check_interval_seconds, next_run_time=now,
        max_instances=1, coalesce=True,
    )
    scheduler.add_job(
        run_safely(take_snapshots, ctx), "cron", id="take_snapshots",
        minute=0, next_run_time=now, max_instances=1, coalesce=True,
    )
    scheduler.start()
    log.info("worker started", extra={"task": settings.worker_name})

    try:
        consumer.run(stop)
    finally:
        scheduler.shutdown(wait=False)
        health.stop()
        pool.close()
        redis.close()
        log.info("worker stopped")


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: Run all worker tests**

Run the unit command (`docker run --rm cf-worker-test`) and the integration command from Task 13, Step 4.
Expected: ruff clean; all PASS.

- [ ] **Step 7: Add `worker` to `docker-compose.yml`** (after `api`)

```yaml
  worker:
    image: ${IMAGE_REGISTRY:-cryptofolio}/worker:${IMAGE_TAG:-local}
    build: { context: ./services/worker, target: runtime }
    environment:
      LOG_LEVEL: ${LOG_LEVEL}
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      PRICE_SERVICE_URL: ${PRICE_SERVICE_URL}
      S3_ENDPOINT: ${S3_ENDPOINT}
      S3_REGION: ${S3_REGION}
      S3_ACCESS_KEY: ${S3_ACCESS_KEY}
      S3_SECRET_KEY: ${S3_SECRET_KEY}
      S3_BUCKET_IMPORTS: ${S3_BUCKET_IMPORTS}
      S3_BUCKET_EXPORTS: ${S3_BUCKET_EXPORTS}
      JOBS_STREAM: ${JOBS_STREAM}
      ALERT_CHECK_INTERVAL_SECONDS: ${ALERT_CHECK_INTERVAL_SECONDS}
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
      minio-init: { condition: service_completed_successfully }
      price-service: { condition: service_started }
    networks: [backend]
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9100/healthz', timeout=3)"]
      interval: 15s
      timeout: 5s
      retries: 3
    stop_grace_period: 20s
    logging: *default-logging
    restart: unless-stopped
```

- [ ] **Step 8: Verify in compose**

Run: `docker compose up -d --build worker && sleep 15 && docker compose ps worker && docker compose logs --tail 20 worker`
Expected: `worker` healthy; logs show `worker started`, `check_alerts finished` (result 0 for the demo alert at $80,000) and `take_snapshots finished` (result 2). `docker compose up -d --scale worker=2` starts a second consumer; `docker compose exec redis redis-cli XINFO CONSUMERS jobs workers` lists both.

- [ ] **Step 9: Commit**

```bash
git add services/worker docker-compose.yml
git commit -m "feat(worker): alert checks, portfolio snapshots, health server, compose service"
```

---
### Task 15: frontend scaffold, API client, auth, layout, runtime config, container

**Files:**
- Create: `services/frontend/{package.json,tsconfig.json,vite.config.ts,vitest.config.ts,eslint.config.js,index.html,Dockerfile,.dockerignore,nginx.conf}`
- Create: `services/frontend/docker-entrypoint.d/40-runtime-config.sh`, `services/frontend/public/config.js`
- Create: `services/frontend/src/{main.tsx,App.tsx,index.css,config.ts}`
- Create: `services/frontend/src/lib/{api.ts,client.ts,format.ts,types.ts}`
- Create: `services/frontend/src/auth/{AuthContext.tsx,RequireAuth.tsx}`
- Create: `services/frontend/src/components/{ui.tsx,Layout.tsx,AuthShell.tsx}`
- Create: `services/frontend/src/pages/{LoginPage.tsx,RegisterPage.tsx,ProfilePage.tsx,NotFoundPage.tsx}`
- Modify: `docker-compose.yml` (add `frontend`)
- Test: `services/frontend/src/lib/{api.test.ts,format.test.ts}`

**Interfaces:**
- Consumes: api HTTP contract (Tasks 6–10), under the `/api` base URL.
- Produces:
  - `ApiClient(baseUrl, fetchImpl?)` with `get/post/put/patch/del<T>(path, body?, {auth?})`, `setAccessToken`, `refresh()` (single-flight), `onUnauthorized`; `ApiError(status, code, message, details?)`; singleton `api` in `lib/client.ts`.
  - Formatters `formatUsd`, `formatPct`, `formatQty`, `formatCompactUsd`, `pnlClass`.
  - DTO types in `lib/types.ts` (mirror the api DTOs).
  - `useAuth() -> { user, status: 'loading'|'authenticated'|'anonymous', login, register, logout, setUser }`, `<RequireAuth>`.
  - UI kit in `components/ui.tsx`: `Card, Button, inputClass, Field, PageHeader, Spinner, FullPageSpinner, ErrorBanner, StaleBadge, EmptyState, Modal, Stat, SectionTitle`.
  - `<Layout>` with the sidebar nav (Dashboard, Portfolios, Markets, Watchlist, Alerts, Import / Export, Profile) and an env badge from runtime config.
  - Runtime config: `window.__CONFIG__ = { apiBaseUrl, appEnv }`, written from `API_BASE_URL`/`APP_ENV` at container start.
  - Design tokens (Tailwind 4 `@theme`): `bg, surface, surface-2, border, text, muted, accent, gain, loss, warn`; `.num` for tabular numbers.

- [ ] **Step 1: Initialise the project and install dependencies**

`services/frontend/package.json`
```json
{
  "name": "cryptofolio-frontend",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "lint": "eslint . && tsc",
    "test": "vitest run"
  }
}
```

Run:
```bash
cd services/frontend
npm install react@18 react-dom@18 react-router-dom@6 @tanstack/react-query@5 recharts@2 lucide-react
npm install -D vite @vitejs/plugin-react typescript@5 @types/react@18 @types/react-dom@18 tailwindcss@4 @tailwindcss/vite vitest eslint @eslint/js typescript-eslint eslint-plugin-react-hooks@5 globals
```

`services/frontend/tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts"]
}
```

`services/frontend/vite.config.ts`
```ts
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev` proxies /api to the gateway started by docker compose.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { '/api': 'http://localhost' } },
});
```

`services/frontend/vitest.config.ts`
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { environment: 'node', include: ['src/**/*.test.ts'] } });
```

`services/frontend/eslint.config.js`
```js
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'public'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { plugins: { 'react-hooks': reactHooks }, rules: reactHooks.configs.recommended.rules },
  { languageOptions: { globals: globals.browser } },
);
```

`services/frontend/index.html`
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#0b0f17" />
    <title>CryptoFolio</title>
    <!-- Runtime configuration, generated at container start (see docker-entrypoint.d) -->
    <script src="/config.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`services/frontend/public/config.js` (dev default. The container overwrites it; the file must exist because the entrypoint rewrites it in place as a non-root user.)
```js
window.__CONFIG__ = { apiBaseUrl: '/api', appEnv: 'dev' };
```

`services/frontend/.dockerignore`
```
node_modules
dist
coverage
```

- [ ] **Step 2: Write failing tests for the API client and formatters**

`services/frontend/src/lib/api.test.ts`
```ts
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: string, init?: RequestInit) => Promise<Response> | Response;
const client = (handler: Handler) => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  return { api: new ApiClient('/api', fetchMock as unknown as typeof fetch), fetchMock };
};
const authHeader = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.Authorization;

describe('ApiClient', () => {
  it('sends the bearer token and a JSON body', async () => {
    const { api, fetchMock } = client(() => json(200, { ok: true }));
    api.setAccessToken('t1');
    await api.post('/portfolios', { name: 'Main' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/portfolios');
    expect(init?.method).toBe('POST');
    expect(authHeader(init)).toBe('Bearer t1');
    expect(init?.body).toBe('{"name":"Main"}');
    expect(init?.credentials).toBe('include');
  });

  it('refreshes once on 401 and retries the request', async () => {
    const { api, fetchMock } = client((url, init) => {
      if (url === '/api/auth/refresh') return json(200, { accessToken: 'new' });
      return authHeader(init) === 'Bearer new' ? json(200, { value: 42 }) : json(401, { error: { code: 'unauthorized', message: 'expired' } });
    });
    api.setAccessToken('old');
    expect(await api.get<{ value: number }>('/me')).toEqual({ value: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('shares a single refresh between concurrent 401s', async () => {
    let refreshes = 0;
    const { api } = client(async (url, init) => {
      if (url === '/api/auth/refresh') {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { accessToken: 'new' });
      }
      return authHeader(init) === 'Bearer new' ? json(200, {}) : json(401, {});
    });
    api.setAccessToken('old');
    await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);
    expect(refreshes).toBe(1);
  });

  it('calls onUnauthorized and throws when refresh fails', async () => {
    const { api } = client(() => json(401, { error: { code: 'unauthorized', message: 'nope' } }));
    const onUnauthorized = vi.fn();
    api.onUnauthorized = onUnauthorized;
    await expect(api.get('/me')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('does not refresh for auth:false requests', async () => {
    const { api, fetchMock } = client(() => json(401, { error: { code: 'invalid_credentials', message: 'Invalid email or password' } }));
    await expect(api.post('/auth/login', {}, { auth: false })).rejects.toMatchObject({ code: 'invalid_credentials', message: 'Invalid email or password' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps error bodies and non-JSON errors to ApiError', async () => {
    const { api } = client(() => json(422, { error: { code: 'insufficient_holdings', message: 'Cannot sell', details: { x: 1 } } }));
    const err = await api.post('/x', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'insufficient_holdings', details: { x: 1 } });
    const { api: api2 } = client(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(api2.get('/x')).rejects.toMatchObject({ status: 502, code: 'http_error' });
  });

  it('returns undefined for 204', async () => {
    const { api } = client(() => new Response(null, { status: 204 }));
    expect(await api.del('/watchlist/bitcoin')).toBeUndefined();
  });
});
```

`services/frontend/src/lib/format.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { formatCompactUsd, formatPct, formatQty, formatUsd, pnlClass } from './format';

describe('formatters', () => {
  it('formats USD with cents, small prices with significant digits, and null as a dash', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(-20)).toBe('-$20.00');
    expect(formatUsd(0.000123)).toBe('$0.000123');
    expect(formatUsd(null)).toBe('—');
  });

  it('formats percentages with a sign', () => {
    expect(formatPct(1.234)).toBe('+1.23%');
    expect(formatPct(-2)).toBe('-2.00%');
    expect(formatPct(0)).toBe('0.00%');
    expect(formatPct(null)).toBe('—');
  });

  it('formats quantities with up to 8 decimals', () => {
    expect(formatQty(0.123456789)).toBe('0.12345679');
    expect(formatQty(10000)).toBe('10,000');
  });

  it('formats compact USD', () => {
    expect(formatCompactUsd(1.23e12)).toBe('$1.23T');
    expect(formatCompactUsd(48500)).toBe('$48.5K');
  });

  it('picks a colour class by sign', () => {
    expect(pnlClass(5)).toBe('text-gain');
    expect(pnlClass(-5)).toBe('text-loss');
    expect(pnlClass(0)).toBe('text-muted');
    expect(pnlClass(null)).toBe('text-muted');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd services/frontend && npm test`
Expected: FAIL `Failed to resolve import "./api"` / `"./format"`.

- [ ] **Step 4: Implement the API client, formatters and types**

`services/frontend/src/lib/api.ts`
```ts
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
```

`services/frontend/src/lib/format.ts`
```ts
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usdSmall = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 4 });
const usdCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
const qty = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 });

export function formatUsd(value: number | null | undefined): string {
  if (value == null) return '—';
  return value !== 0 && Math.abs(value) < 1 ? usdSmall.format(value) : usd.format(value);
}

export function formatPct(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export const formatQty = (value: number) => qty.format(value);
export const formatCompactUsd = (value: number) => usdCompact.format(value);

export function pnlClass(value: number | null | undefined): 'text-gain' | 'text-loss' | 'text-muted' {
  if (value == null || value === 0) return 'text-muted';
  return value > 0 ? 'text-gain' : 'text-loss';
}
```

`services/frontend/src/lib/types.ts`
```ts
export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: string;
}
export interface AuthResponse {
  accessToken: string;
  user: User;
}
export interface Coin {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  currentPrice: number;
  change24h: number;
  marketCap: number;
}
export interface Totals {
  valueUsd: number;
  costBasisUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number | null;
  realizedPnlUsd: number;
  change24hUsd: number;
  change24hPct: number | null;
  missingPrices: string[];
}
export interface Holding {
  coinId: string;
  quantity: number;
  avgCostUsd: number;
  costBasisUsd: number;
  realizedPnlUsd: number;
  priceUsd: number | null;
  change24hPct: number | null;
  valueUsd: number | null;
  unrealizedPnlUsd: number | null;
  unrealizedPnlPct: number | null;
  allocationPct: number | null;
}
export interface Portfolio {
  id: string;
  name: string;
  createdAt: string;
}
export interface PortfolioSummary extends Portfolio {
  totals: Totals;
}
export interface Transaction {
  id: string;
  portfolioId: string;
  coinId: string;
  type: 'buy' | 'sell';
  quantity: number;
  priceUsd: number;
  feeUsd: number;
  totalUsd: number;
  executedAt: string;
  note: string | null;
}
export interface SnapshotPoint {
  date: string;
  valueUsd: number;
}
export interface Dashboard {
  totals: Totals;
  holdings: Holding[];
  portfolios: { id: string; name: string; totals: Totals }[];
  history: SnapshotPoint[];
  stale: boolean;
}
export interface PriceHistory {
  id: string;
  days: number;
  points: [number, number][];
  stale: boolean;
}
export interface Alert {
  id: string;
  coinId: string;
  direction: 'above' | 'below';
  targetPrice: number;
  active: boolean;
  triggeredAt: string | null;
  createdAt: string;
  currentPrice: number | null;
}
export interface AppNotification {
  id: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}
export type JobType = 'export_csv' | 'import_csv' | 'report_pdf';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';
export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  params: { portfolioId?: string; key?: string };
  result: { filename?: string; rows?: number; imported?: number } | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  downloadUrl: string | null;
}
export interface UploadTarget {
  uploadUrl: string;
  key: string;
}
```

- [ ] **Step 5: Run the unit tests**

Run: `cd services/frontend && npm test`
Expected: all PASS.

- [ ] **Step 6: Runtime config, client singleton, styles**

`services/frontend/src/config.ts`
```ts
interface RuntimeConfig {
  apiBaseUrl: string;
  appEnv: string;
}

declare global {
  interface Window {
    __CONFIG__?: Partial<RuntimeConfig>;
  }
}

/** Filled by /config.js, which the container generates from env vars at start-up. */
export const config: RuntimeConfig = {
  apiBaseUrl: window.__CONFIG__?.apiBaseUrl ?? '/api',
  appEnv: window.__CONFIG__?.appEnv ?? 'unknown',
};
```

`services/frontend/src/lib/client.ts`
```ts
import { config } from '../config';
import { ApiClient } from './api';

export const api = new ApiClient(config.apiBaseUrl);
```

`services/frontend/src/index.css`
```css
@import "tailwindcss";

@theme {
  --color-bg: #0b0f17;
  --color-surface: #121826;
  --color-surface-2: #1a2233;
  --color-border: #243049;
  --color-text: #e6eaf2;
  --color-muted: #8a94a8;
  --color-accent: #7c9cff;
  --color-gain: #22c55e;
  --color-loss: #f43f5e;
  --color-warn: #f59e0b;
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
}

html {
  color-scheme: dark;
}
body {
  @apply bg-bg font-sans text-text antialiased;
}
.num {
  @apply font-mono;
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 7: Auth context and route guard**

`services/frontend/src/auth/AuthContext.tsx`
```tsx
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
```

`services/frontend/src/auth/RequireAuth.tsx`
```tsx
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { FullPageSpinner } from '../components/ui';
import { useAuth } from './AuthContext';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}
```

- [ ] **Step 8: UI kit, auth shell, layout**

`services/frontend/src/components/ui.tsx`
```tsx
import { X } from 'lucide-react';
import { type ButtonHTMLAttributes, type ReactNode, useEffect } from 'react';
import { ApiError } from '../lib/api';

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <section className={`rounded-xl border border-border bg-surface p-5 ${className}`}>{children}</section>;
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">{children}</h2>
      {actions}
    </div>
  );
}

type Variant = 'primary' | 'ghost' | 'danger';
const buttonStyles: Record<Variant, string> = {
  primary: 'bg-accent text-bg hover:brightness-110',
  ghost: 'border border-border text-text hover:bg-surface-2',
  danger: 'border border-loss/40 text-loss hover:bg-loss/10',
};

export function Button({ variant = 'primary', className = '', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${buttonStyles[variant]} ${className}`}
      {...props}
    />
  );
}

export const inputClass =
  'w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none';

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner() {
  return (
    <div className="flex justify-center py-10" role="status" aria-label="Loading">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
    </div>
  );
}

export function FullPageSpinner() {
  return (
    <div className="grid min-h-screen place-items-center">
      <Spinner />
    </div>
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-lg border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">
      {errorMessage(error)}
    </div>
  );
}

export function StaleBadge({ stale }: { stale?: boolean }) {
  if (!stale) return null;
  return (
    <span title="The price provider is unavailable - showing the last known prices." className="rounded-full bg-warn/15 px-2.5 py-1 text-xs font-medium text-warn">
      stale prices
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-2 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Card className="!p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-muted">{label}</p>
      <div className="num mt-2 text-xl font-semibold">{value}</div>
    </Card>
  );
}

export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="text-muted hover:text-text" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
```

`services/frontend/src/components/AuthShell.tsx`
```tsx
import type { ReactNode } from 'react';

export function AuthShell({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <p className="mb-8 text-center text-2xl font-semibold tracking-tight">
          Crypto<span className="text-accent">Folio</span>
        </p>
        <div className="rounded-xl border border-border bg-surface p-6">
          <h1 className="mb-5 text-lg font-semibold">{title}</h1>
          {children}
        </div>
        <p className="mt-4 text-center text-sm text-muted">{footer}</p>
      </div>
    </div>
  );
}
```

`services/frontend/src/components/Layout.tsx`
```tsx
import { BellRing, FileDown, LayoutDashboard, LineChart, LogOut, Star, UserRound, Wallet } from 'lucide-react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { config } from '../config';
import { Button } from './ui';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/portfolios', label: 'Portfolios', icon: Wallet },
  { to: '/markets', label: 'Markets', icon: LineChart },
  { to: '/watchlist', label: 'Watchlist', icon: Star },
  { to: '/alerts', label: 'Alerts', icon: BellRing },
  { to: '/files', label: 'Import / Export', icon: FileDown },
  { to: '/profile', label: 'Profile', icon: UserRound },
];

export function Layout() {
  const { user, logout } = useAuth();
  return (
    <div className="min-h-screen md:grid md:grid-cols-[220px_1fr]">
      <aside className="border-b border-border bg-surface md:min-h-screen md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-5 py-4 md:block">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            Crypto<span className="text-accent">Folio</span>
          </Link>
          <span title="APP_ENV (runtime config)" className="rounded bg-surface-2 px-2 py-0.5 font-mono text-[11px] uppercase text-muted md:mt-2 md:inline-block">
            {config.appEnv}
          </span>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:overflow-visible">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${isActive ? 'bg-surface-2 text-text' : 'text-muted hover:text-text'}`
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="min-w-0">
        <header className="flex items-center justify-end gap-3 border-b border-border px-4 py-3 md:px-8">
          {user?.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
          ) : (
            <span className="grid h-8 w-8 place-items-center rounded-full bg-surface-2 text-sm font-semibold text-muted">
              {user?.displayName.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="hidden text-sm sm:inline">{user?.displayName}</span>
          <Button variant="ghost" onClick={() => void logout()}>
            <LogOut size={14} />
            Log out
          </Button>
        </header>
        <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Pages for this task and the app shell**

`services/frontend/src/pages/LoginPage.tsx`
```tsx
import { type FormEvent, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { AuthShell } from '../components/AuthShell';
import { Button, ErrorBanner, Field, inputClass } from '../components/ui';

const DEMO = { email: 'demo@cryptofolio.local', password: 'demo1234' };

export function LoginPage() {
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Log in" footer={<>No account? <Link to="/register" className="text-accent hover:underline">Create one</Link></>}>
      <form onSubmit={submit} className="space-y-4">
        <ErrorBanner error={error} />
        <Field label="Email">
          <input className={inputClass} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <input className={inputClass} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </Button>
        <button
          type="button"
          className="w-full text-center text-xs text-muted hover:text-text"
          onClick={() => {
            setEmail(DEMO.email);
            setPassword(DEMO.password);
          }}
        >
          Use the demo account ({DEMO.email})
        </button>
      </form>
    </AuthShell>
  );
}
```

`services/frontend/src/pages/RegisterPage.tsx`
```tsx
import { type ChangeEvent, type FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { AuthShell } from '../components/AuthShell';
import { Button, ErrorBanner, Field, inputClass } from '../components/ui';

export function RegisterPage() {
  const { register, status } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ displayName: '', email: '', password: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(form.email, form.password, form.displayName);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <AuthShell title="Create your account" footer={<>Already registered? <Link to="/login" className="text-accent hover:underline">Log in</Link></>}>
      <form onSubmit={submit} className="space-y-4">
        <ErrorBanner error={error} />
        <Field label="Display name">
          <input className={inputClass} required maxLength={60} value={form.displayName} onChange={set('displayName')} />
        </Field>
        <Field label="Email">
          <input className={inputClass} type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Password" hint="At least 8 characters">
          <input className={inputClass} type="password" autoComplete="new-password" required minLength={8} value={form.password} onChange={set('password')} />
        </Field>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthShell>
  );
}
```

`services/frontend/src/pages/ProfilePage.tsx`
```tsx
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, ErrorBanner, Field, inputClass, PageHeader, SectionTitle } from '../components/ui';
import { api } from '../lib/client';
import type { User } from '../lib/types';

export function ProfilePage() {
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user?.displayName ?? '');
  const save = useMutation({ mutationFn: (displayName: string) => api.patch<User>('/me', { displayName }), onSuccess: setUser });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(name);
  }

  return (
    <>
      <PageHeader title="Profile" subtitle={user?.email} />
      <Card className="max-w-xl">
        <SectionTitle>Display name</SectionTitle>
        <form onSubmit={submit} className="space-y-4">
          <ErrorBanner error={save.error} />
          <Field label="Name">
            <input className={inputClass} required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button type="submit" disabled={save.isPending || name.trim() === user?.displayName}>
            {save.isSuccess && name.trim() === user?.displayName ? 'Saved' : 'Save'}
          </Button>
        </form>
      </Card>
    </>
  );
}
```

`services/frontend/src/pages/NotFoundPage.tsx`
```tsx
import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui';

export function NotFoundPage() {
  return (
    <EmptyState title="Page not found">
      <Link to="/" className="text-accent hover:underline">Back to the dashboard</Link>
    </EmptyState>
  );
}
```

`services/frontend/src/App.tsx`
```tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProfilePage } from './pages/ProfilePage';
import { RegisterPage } from './pages/RegisterPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        {/* Task 17 replaces this redirect with the dashboard */}
        <Route index element={<Navigate to="/profile" replace />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
```

`services/frontend/src/main.tsx`
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { ApiError } from './lib/api';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      // Don't retry client errors (401/403/404/422...), retry server errors twice.
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 10: Container: nginx config, runtime-config entrypoint, Dockerfile**

`services/frontend/nginx.conf`
```nginx
server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;
    access_log off; # the gateway logs every request

    location = /healthz { return 200 "ok\n"; }

    # Generated at container start - never cache.
    location = /config.js {
        add_header Cache-Control "no-store";
        try_files $uri =404;
    }

    # Fingerprinted build output - cache forever.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # SPA: unknown paths fall back to index.html (client-side routing).
    location / {
        add_header Cache-Control "no-cache";
        try_files $uri $uri/ /index.html;
    }
}
```

`services/frontend/docker-entrypoint.d/40-runtime-config.sh`
```sh
#!/bin/sh
# Writes /config.js from environment variables when the container starts,
# so ONE image can be promoted unchanged from dev -> staging -> prod.
set -eu
cat > /usr/share/nginx/html/config.js <<EOF
window.__CONFIG__ = {
  apiBaseUrl: "${API_BASE_URL:-/api}",
  appEnv: "${APP_ENV:-local}"
};
EOF
echo "runtime config written: APP_ENV=${APP_ENV:-local} API_BASE_URL=${API_BASE_URL:-/api}"
```

`services/frontend/Dockerfile`
```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# `docker build --target test` -> lint + unit tests (used by CI)
FROM deps AS test
COPY . .
CMD ["sh", "-c", "npm run lint && npm test"]

FROM deps AS build
COPY . .
RUN npm run build

# Static files served by an unprivileged nginx (listens on 8080, runs as uid 101)
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=0755 docker-entrypoint.d/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
COPY --from=build --chown=nginx:nginx /app/dist /usr/share/nginx/html
EXPOSE 8080
```

- [ ] **Step 11: Add `frontend` to `docker-compose.yml`** (after `worker`)

```yaml
  frontend:
    image: ${IMAGE_REGISTRY:-cryptofolio}/frontend:${IMAGE_TAG:-local}
    build: { context: ./services/frontend, target: runtime }
    environment:
      APP_ENV: ${APP_ENV}
      API_BASE_URL: /api
    networks: [edge]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/healthz"]
      interval: 10s
      timeout: 3s
      retries: 5
    logging: *default-logging
    restart: unless-stopped
```

- [ ] **Step 12: Verify lint, tests, build and container**

Run:
```bash
cd services/frontend && npm run lint && npm test && npm run build
cd ../.. && docker compose up -d --build frontend && sleep 5 && docker compose ps frontend && docker compose exec frontend cat /usr/share/nginx/html/config.js
```
Expected: lint/tests/build succeed; container healthy; config.js shows `appEnv: "local"`.

- [ ] **Step 13: Commit**

```bash
git add services/frontend docker-compose.yml
git commit -m "feat(frontend): react scaffold, api client with token refresh, auth pages, layout, runtime config"
```

---

### Task 16: gateway and end-to-end wiring

**Files:**
- Create: `gateway/Dockerfile`, `gateway/templates/default.conf.template`
- Modify: `docker-compose.yml` (add `gateway`)

**Interfaces:**
- Consumes: `frontend:8080`, `api:3000`, `minio:9000`; env `S3_BUCKET_AVATARS|IMPORTS|EXPORTS`.
- Produces: the public entry point `http://localhost:${GATEWAY_PORT}` with routes `/` → frontend, `/api/` → api (path unchanged), `/<bucket>/…` → MinIO (path and Host unchanged, which keeps presigned signatures valid), and `/gateway/healthz`. Every response carries `X-Request-ID`, forwarded upstream. Logs are JSON.

- [ ] **Step 1: Gateway config template**

`gateway/templates/default.conf.template`
```nginx
# Rendered at container start by the nginx image (envsubst replaces ${S3_BUCKET_*} only).
# Everything below lives in the http {} context.

log_format gateway_json escape=json
  '{"ts":"$time_iso8601","service":"gateway","request_id":"$req_id",'
  '"remote":"$remote_addr","method":"$request_method","uri":"$request_uri",'
  '"status":$status,"bytes":$body_bytes_sent,"duration":$request_time,'
  '"upstream":"$upstream_addr","upstream_duration":"$upstream_response_time"}';

# Reuse the caller's X-Request-ID or mint one; it is passed to every upstream.
map $http_x_request_id $req_id {
  default $http_x_request_id;
  ""      $request_id;
}

# Docker's embedded DNS: re-resolve upstreams so restarted containers are found.
resolver 127.0.0.11 valid=10s ipv6=off;

server {
  listen 8080;
  server_name _;
  access_log /dev/stdout gateway_json;
  client_max_body_size 10m;

  gzip on;
  gzip_min_length 1024;
  gzip_types application/json application/javascript text/css image/svg+xml;

  add_header X-Request-ID $req_id always;

  # NOTE: proxy_set_header is NOT inherited by a location that sets its own,
  # so all headers are set once here and never inside a location.
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_set_header Host $http_host;
  proxy_set_header X-Request-ID $req_id;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;

  location = /gateway/healthz {
    access_log off;
    return 200 "ok\n";
  }

  location /api/ {
    set $api_upstream http://api:3000;
    proxy_pass $api_upstream;
  }

  # Presigned object-storage URLs. Path and Host must reach MinIO untouched:
  # both are part of the SigV4 signature.
  location ~ ^/(${S3_BUCKET_AVATARS}|${S3_BUCKET_IMPORTS}|${S3_BUCKET_EXPORTS})/ {
    set $storage_upstream http://minio:9000;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_pass $storage_upstream;
  }

  location / {
    set $frontend_upstream http://frontend:8080;
    proxy_pass $frontend_upstream;
  }
}
```

`gateway/Dockerfile`
```dockerfile
FROM nginxinc/nginx-unprivileged:1.27-alpine
# The image renders /etc/nginx/templates/*.template into /etc/nginx/conf.d/ at start.
COPY templates/ /etc/nginx/templates/
EXPOSE 8080
```

- [ ] **Step 2: Add `gateway` to `docker-compose.yml`** (after `frontend`)

```yaml
  gateway:
    image: ${IMAGE_REGISTRY:-cryptofolio}/gateway:${IMAGE_TAG:-local}
    build: { context: ./gateway }
    ports: ["${GATEWAY_PORT:-80}:8080"]
    environment:
      S3_BUCKET_AVATARS: ${S3_BUCKET_AVATARS}
      S3_BUCKET_IMPORTS: ${S3_BUCKET_IMPORTS}
      S3_BUCKET_EXPORTS: ${S3_BUCKET_EXPORTS}
    depends_on:
      frontend: { condition: service_healthy }
      api: { condition: service_healthy }
      minio: { condition: service_healthy }
    networks: [edge]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/gateway/healthz"]
      interval: 10s
      timeout: 3s
      retries: 5
    logging: *default-logging
    restart: unless-stopped
```

- [ ] **Step 3: Verify the whole stack end to end**

Run:
```bash
docker compose up -d --build && sleep 30 && docker compose ps -a
curl -s localhost/gateway/healthz
curl -s localhost/api/readyz
curl -s -o /dev/null -w "%{http_code}\n" localhost/metrics            # not exposed
curl -s -o /dev/null -w "%{http_code}\n" localhost/portfolios          # SPA fallback
TOKEN=$(curl -s -X POST localhost/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"demo@cryptofolio.local","password":"demo1234"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
curl -s localhost/api/dashboard -H "authorization: Bearer $TOKEN" | head -c 300; echo
URL=$(curl -s -X POST localhost/api/me/avatar/upload-url -H "authorization: Bearer $TOKEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["uploadUrl"])')
curl -s -o /dev/null -w "%{http_code}\n" -X PUT --data-binary 'hello' "$URL"
docker compose logs --tail 5 gateway
```
Expected: all services healthy, `migrate`/`minio-init` Exited (0); `ok`; readyz `ready` with postgres/redis/storage ok; `/metrics` → 200 with the SPA's index.html, **not** Prometheus text (the frontend's catch-all answers); `/portfolios` → 200; dashboard JSON with `totals.valueUsd` > 0; presigned PUT through the gateway → `200`; gateway logs are JSON lines with `request_id`. Then log in at http://localhost with the demo account in a browser and confirm the profile page loads.

- [ ] **Step 4: Commit**

```bash
git add gateway docker-compose.yml
git commit -m "feat(gateway): nginx edge routing for frontend, api and presigned storage URLs"
```

---

### Task 17: frontend dashboard, portfolios, holdings, transactions

**Files:**
- Create: `services/frontend/src/hooks/{portfolios.ts,market.ts}`
- Create: `services/frontend/src/components/{charts.tsx,CoinIcon.tsx,PnlText.tsx,HoldingsTable.tsx,TransactionsTable.tsx,AddTransactionModal.tsx}`
- Create: `services/frontend/src/pages/{DashboardPage.tsx,PortfoliosPage.tsx,PortfolioDetailPage.tsx}`
- Modify: `services/frontend/src/App.tsx`

**Interfaces:**
- Consumes: `api`, types, UI kit (Task 15); api endpoints from Task 9 and `/api/market/coins`.
- Produces:
  - Hooks: `useDashboard`, `usePortfolios`, `usePortfolio(id)`, `useHoldings(id)`, `useTransactions(id)`, `useSnapshots(id, days)`, `useCreatePortfolio`, `useRenamePortfolio(id)`, `useDeletePortfolio`, `useAddTransaction(portfolioId)`, `useDeleteTransaction`, `NewTransaction`; `useCoins`, `useCoinMap`.
  - Components: `ValueChart({points})`, `AllocationChart({holdings})`, `PriceChart({points, days})`, `CoinIcon({coinId, image, size})`, `PnlText({value, pct})`, `HoldingsTable({holdings})`, `TransactionsTable({items})`, `AddTransactionModal({portfolioId, open, onClose, defaultCoinId?})`.
  - Routes: `/` Dashboard, `/portfolios`, `/portfolios/:id`.

- [ ] **Step 1: Data hooks**

`services/frontend/src/hooks/portfolios.ts`
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/client';
import type { Dashboard, Holding, Portfolio, PortfolioSummary, SnapshotPoint, Totals, Transaction } from '../lib/types';

const PORTFOLIO_KEYS = ['dashboard', 'portfolios', 'portfolio', 'holdings', 'transactions', 'snapshots'];

export function useInvalidatePortfolioData() {
  const qc = useQueryClient();
  return () => Promise.all(PORTFOLIO_KEYS.map((key) => qc.invalidateQueries({ queryKey: [key] })));
}

export const useDashboard = () =>
  useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Dashboard>('/dashboard'), refetchInterval: 60_000 });

export const usePortfolios = () =>
  useQuery({ queryKey: ['portfolios'], queryFn: () => api.get<{ items: PortfolioSummary[]; stale: boolean }>('/portfolios') });

export const usePortfolio = (id: string) =>
  useQuery({ queryKey: ['portfolio', id], queryFn: () => api.get<Portfolio>(`/portfolios/${id}`) });

export const useHoldings = (id: string) =>
  useQuery({
    queryKey: ['holdings', id],
    queryFn: () => api.get<{ holdings: Holding[]; totals: Totals; stale: boolean }>(`/portfolios/${id}/holdings`),
    refetchInterval: 60_000,
  });

export const useTransactions = (id: string) =>
  useQuery({ queryKey: ['transactions', id], queryFn: () => api.get<{ items: Transaction[] }>(`/portfolios/${id}/transactions`) });

export const useSnapshots = (id: string, days = 30) =>
  useQuery({ queryKey: ['snapshots', id, days], queryFn: () => api.get<{ points: SnapshotPoint[] }>(`/portfolios/${id}/snapshots?days=${days}`) });

export function useCreatePortfolio() {
  const invalidate = useInvalidatePortfolioData();
  return useMutation({ mutationFn: (name: string) => api.post<Portfolio>('/portfolios', { name }), onSuccess: invalidate });
}

export function useRenamePortfolio(id: string) {
  const invalidate = useInvalidatePortfolioData();
  return useMutation({ mutationFn: (name: string) => api.patch<Portfolio>(`/portfolios/${id}`, { name }), onSuccess: invalidate });
}

export function useDeletePortfolio() {
  const invalidate = useInvalidatePortfolioData();
  return useMutation({ mutationFn: (id: string) => api.del(`/portfolios/${id}`), onSuccess: invalidate });
}

export interface NewTransaction {
  coinId: string;
  type: 'buy' | 'sell';
  quantity: string;
  priceUsd: string;
  feeUsd: string;
  executedAt: string;
  note?: string;
}

export function useAddTransaction(portfolioId: string) {
  const invalidate = useInvalidatePortfolioData();
  return useMutation({
    mutationFn: (input: NewTransaction) => api.post<Transaction>(`/portfolios/${portfolioId}/transactions`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteTransaction() {
  const invalidate = useInvalidatePortfolioData();
  return useMutation({ mutationFn: (id: string) => api.del(`/transactions/${id}`), onSuccess: invalidate });
}
```

`services/frontend/src/hooks/market.ts`
```ts
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../lib/client';
import type { Coin } from '../lib/types';

export const useCoins = () =>
  useQuery({
    queryKey: ['coins'],
    queryFn: () => api.get<{ coins: Coin[]; stale: boolean }>('/market/coins'),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

/** id -> Coin lookup for names, symbols and icons. */
export function useCoinMap(): Map<string, Coin> {
  const { data } = useCoins();
  return useMemo(() => new Map((data?.coins ?? []).map((c) => [c.id, c])), [data]);
}
```

- [ ] **Step 2: Presentational components**

`services/frontend/src/components/CoinIcon.tsx`
```tsx
export function CoinIcon({ coinId, image, size = 24 }: { coinId: string; image?: string | null; size?: number }) {
  if (image) return <img src={image} alt="" width={size} height={size} className="rounded-full" />;
  return (
    <span className="inline-grid shrink-0 place-items-center rounded-full bg-surface-2 text-[10px] font-semibold uppercase text-muted" style={{ width: size, height: size }}>
      {coinId.slice(0, 3)}
    </span>
  );
}
```

`services/frontend/src/components/PnlText.tsx`
```tsx
import { formatPct, formatUsd, pnlClass } from '../lib/format';

export function PnlText({ value, pct }: { value: number | null; pct?: number | null }) {
  return (
    <span className={`num ${pnlClass(value)}`}>
      {formatUsd(value)}
      {pct != null && <span className="ml-1 text-xs opacity-80">({formatPct(pct)})</span>}
    </span>
  );
}
```

`services/frontend/src/components/charts.tsx`
```tsx
import { useId } from 'react';
import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCompactUsd, formatPct, formatUsd } from '../lib/format';
import type { Holding, SnapshotPoint } from '../lib/types';
import { EmptyState } from './ui';

const PALETTE = ['#7c9cff', '#22c55e', '#f59e0b', '#f43f5e', '#06b6d4', '#a78bfa', '#84cc16', '#ec4899'];
const tooltipStyle = { background: '#121826', border: '1px solid #243049', borderRadius: 8, fontSize: 12 };
const axisProps = { stroke: '#8a94a8', fontSize: 11, tickLine: false, axisLine: false } as const;

type XFormat = (value: string | number) => string;

function LineArea<T extends object>({ data, xKey, yKey, xFormat, height }: { data: T[]; xKey: string; yKey: string; xFormat: XFormat; height: number }) {
  const gradientId = useId();
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c9cff" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#7c9cff" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey={xKey} tickFormatter={xFormat} minTickGap={32} {...axisProps} />
        <YAxis tickFormatter={(v: number) => formatCompactUsd(v)} width={64} domain={['auto', 'auto']} {...axisProps} />
        <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => xFormat(v as string | number)} formatter={(v) => [formatUsd(Number(v)), 'Value']} />
        <Area type="monotone" dataKey={yKey} stroke="#7c9cff" strokeWidth={2} fill={`url(#${gradientId})`} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function ValueChart({ points, height = 240 }: { points: SnapshotPoint[]; height?: number }) {
  if (points.length === 0) return <EmptyState title="No history yet">The worker records portfolio value every hour.</EmptyState>;
  return <LineArea data={points} xKey="date" yKey="valueUsd" xFormat={(d) => String(d).slice(5)} height={height} />;
}

export function PriceChart({ points, days, height = 280 }: { points: [number, number][]; days: number; height?: number }) {
  const data = points.map(([t, price]) => ({ t, price }));
  const xFormat: XFormat = (t) => {
    const d = new Date(Number(t));
    return days === 1 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  return <LineArea data={data} xKey="t" yKey="price" xFormat={xFormat} height={height} />;
}

export function AllocationChart({ holdings }: { holdings: Holding[] }) {
  const priced = holdings.filter((h) => h.valueUsd && h.valueUsd > 0);
  if (priced.length === 0) return <EmptyState title="Nothing to allocate yet" />;
  const top = priced.slice(0, 7).map((h) => ({ name: h.coinId, value: h.valueUsd!, pct: h.allocationPct }));
  const rest = priced.slice(7);
  if (rest.length) {
    top.push({ name: 'other', value: rest.reduce((s, h) => s + h.valueUsd!, 0), pct: rest.reduce((s, h) => s + (h.allocationPct ?? 0), 0) });
  }
  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row lg:flex-col xl:flex-row">
      <div className="h-44 w-44 shrink-0">
        <ResponsiveContainer>
          <PieChart>
            <Pie data={top} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="100%" stroke="none" paddingAngle={1}>
              {top.map((_, i) => (
                <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => formatUsd(Number(v))} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="w-full space-y-2 text-sm">
        {top.map((slice, i) => (
          <li key={slice.name} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />
              {slice.name}
            </span>
            <span className="num text-muted">{formatPct(slice.pct).replace('+', '')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

`services/frontend/src/components/HoldingsTable.tsx`
```tsx
import { Link } from 'react-router-dom';
import { useCoinMap } from '../hooks/market';
import { formatPct, formatQty, formatUsd } from '../lib/format';
import type { Holding } from '../lib/types';
import { CoinIcon } from './CoinIcon';
import { PnlText } from './PnlText';
import { EmptyState } from './ui';

export function HoldingsTable({ holdings }: { holdings: Holding[] }) {
  const coins = useCoinMap();
  if (holdings.length === 0) return <EmptyState title="No holdings yet">Add a buy transaction to get started.</EmptyState>;
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-muted">
          <tr className="border-b border-border">
            <th className="px-5 py-2 font-medium">Asset</th>
            <th className="px-3 py-2 text-right font-medium">Quantity</th>
            <th className="px-3 py-2 text-right font-medium">Avg cost</th>
            <th className="px-3 py-2 text-right font-medium">Price</th>
            <th className="px-3 py-2 text-right font-medium">Value</th>
            <th className="px-3 py-2 text-right font-medium">Unrealized P/L</th>
            <th className="px-5 py-2 text-right font-medium">Alloc.</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h) => {
            const coin = coins.get(h.coinId);
            return (
              <tr key={h.coinId} className="border-b border-border/60 last:border-0 hover:bg-surface-2/50">
                <td className="px-5 py-3">
                  <Link to={`/markets/${h.coinId}`} className="flex items-center gap-2.5">
                    <CoinIcon coinId={h.coinId} image={coin?.image} />
                    <span className="font-medium">{coin?.name ?? h.coinId}</span>
                    <span className="text-xs uppercase text-muted">{coin?.symbol}</span>
                  </Link>
                </td>
                <td className="num px-3 py-3 text-right">{formatQty(h.quantity)}</td>
                <td className="num px-3 py-3 text-right text-muted">{formatUsd(h.avgCostUsd)}</td>
                <td className="num px-3 py-3 text-right">{formatUsd(h.priceUsd)}</td>
                <td className="num px-3 py-3 text-right font-medium">{formatUsd(h.valueUsd)}</td>
                <td className="px-3 py-3 text-right"><PnlText value={h.unrealizedPnlUsd} pct={h.unrealizedPnlPct} /></td>
                <td className="num px-5 py-3 text-right text-muted">{formatPct(h.allocationPct).replace('+', '')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

`services/frontend/src/components/TransactionsTable.tsx`
```tsx
import { Trash2 } from 'lucide-react';
import { useDeleteTransaction } from '../hooks/portfolios';
import { formatQty, formatUsd } from '../lib/format';
import type { Transaction } from '../lib/types';
import { EmptyState, ErrorBanner } from './ui';

export function TransactionsTable({ items }: { items: Transaction[] }) {
  const remove = useDeleteTransaction();
  if (items.length === 0) return <EmptyState title="No transactions yet" />;
  return (
    <div className="space-y-3">
      <ErrorBanner error={remove.error} />
      <div className="-mx-5 overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-muted">
            <tr className="border-b border-border">
              <th className="px-5 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Asset</th>
              <th className="px-3 py-2 text-right font-medium">Quantity</th>
              <th className="px-3 py-2 text-right font-medium">Price</th>
              <th className="px-3 py-2 text-right font-medium">Fee</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
              <th className="px-3 py-2 font-medium">Note</th>
              <th className="px-5 py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((tx) => (
              <tr key={tx.id} className="border-b border-border/60 last:border-0">
                <td className="num px-5 py-3 text-muted">{new Date(tx.executedAt).toLocaleString()}</td>
                <td className="px-3 py-3">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium uppercase ${tx.type === 'buy' ? 'bg-gain/15 text-gain' : 'bg-loss/15 text-loss'}`}>{tx.type}</span>
                </td>
                <td className="px-3 py-3">{tx.coinId}</td>
                <td className="num px-3 py-3 text-right">{formatQty(tx.quantity)}</td>
                <td className="num px-3 py-3 text-right">{formatUsd(tx.priceUsd)}</td>
                <td className="num px-3 py-3 text-right text-muted">{formatUsd(tx.feeUsd)}</td>
                <td className="num px-3 py-3 text-right">{formatUsd(tx.totalUsd)}</td>
                <td className="max-w-40 truncate px-3 py-3 text-muted">{tx.note}</td>
                <td className="px-5 py-3 text-right">
                  <button
                    type="button"
                    aria-label="Delete transaction"
                    className="text-muted hover:text-loss disabled:opacity-40"
                    disabled={remove.isPending}
                    onClick={() => window.confirm('Delete this transaction?') && remove.mutate(tx.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

`services/frontend/src/components/AddTransactionModal.tsx`
```tsx
import { type ChangeEvent, type FormEvent, useState } from 'react';
import { useCoins } from '../hooks/market';
import { useAddTransaction } from '../hooks/portfolios';
import { formatUsd } from '../lib/format';
import { Button, ErrorBanner, Field, inputClass, Modal } from './ui';

function toLocalInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

const initialForm = (coinId: string) => ({
  coinId,
  type: 'buy' as 'buy' | 'sell',
  quantity: '',
  priceUsd: '',
  feeUsd: '',
  executedAt: toLocalInput(new Date()),
  note: '',
});

export function AddTransactionModal({ portfolioId, open, onClose, defaultCoinId = 'bitcoin' }: { portfolioId: string; open: boolean; onClose: () => void; defaultCoinId?: string }) {
  const { data } = useCoins();
  const add = useAddTransaction(portfolioId);
  const [form, setForm] = useState(() => initialForm(defaultCoinId));
  const coin = data?.coins.find((c) => c.id === form.coinId);

  const set = (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  function close() {
    add.reset();
    setForm(initialForm(defaultCoinId));
    onClose();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    add.mutate(
      {
        coinId: form.coinId,
        type: form.type,
        quantity: form.quantity,
        priceUsd: form.priceUsd || String(coin?.currentPrice ?? ''),
        feeUsd: form.feeUsd || '0',
        executedAt: new Date(form.executedAt).toISOString(),
        note: form.note || undefined,
      },
      { onSuccess: close },
    );
  }

  return (
    <Modal open={open} title="Add transaction" onClose={close}>
      <form onSubmit={submit} className="space-y-4">
        <ErrorBanner error={add.error} />
        <div className="grid grid-cols-2 gap-2">
          {(['buy', 'sell'] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setForm((f) => ({ ...f, type }))}
              className={`rounded-lg border py-2 text-sm font-medium uppercase ${form.type === type ? (type === 'buy' ? 'border-gain bg-gain/15 text-gain' : 'border-loss bg-loss/15 text-loss') : 'border-border text-muted'}`}
            >
              {type}
            </button>
          ))}
        </div>
        <Field label="Coin">
          <select className={inputClass} value={form.coinId} onChange={set('coinId')}>
            {(data?.coins ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.symbol.toUpperCase()})
              </option>
            ))}
          </select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Quantity">
            <input className={`${inputClass} num`} inputMode="decimal" required pattern="^\d+(\.\d{1,18})?$" placeholder="0.5" value={form.quantity} onChange={set('quantity')} />
          </Field>
          <Field label="Price (USD)" hint={coin ? `Market: ${formatUsd(coin.currentPrice)}` : undefined}>
            <input className={`${inputClass} num`} inputMode="decimal" pattern="^\d+(\.\d{1,18})?$" placeholder={coin ? String(coin.currentPrice) : ''} value={form.priceUsd} onChange={set('priceUsd')} />
          </Field>
          <Field label="Fee (USD)">
            <input className={`${inputClass} num`} inputMode="decimal" pattern="^\d+(\.\d{1,18})?$" placeholder="0" value={form.feeUsd} onChange={set('feeUsd')} />
          </Field>
          <Field label="Date">
            <input className={inputClass} type="datetime-local" required max={toLocalInput(new Date())} value={form.executedAt} onChange={set('executedAt')} />
          </Field>
        </div>
        <Field label="Note">
          <input className={inputClass} maxLength={200} value={form.note} onChange={set('note')} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button type="submit" disabled={add.isPending}>{add.isPending ? 'Saving…' : 'Add transaction'}</Button>
        </div>
      </form>
    </Modal>
  );
}
```

- [ ] **Step 3: Pages**

`services/frontend/src/pages/DashboardPage.tsx`
```tsx
import { Link } from 'react-router-dom';
import { AllocationChart, ValueChart } from '../components/charts';
import { HoldingsTable } from '../components/HoldingsTable';
import { PnlText } from '../components/PnlText';
import { Card, EmptyState, ErrorBanner, PageHeader, SectionTitle, Spinner, StaleBadge, Stat } from '../components/ui';
import { useDashboard } from '../hooks/portfolios';
import { formatUsd } from '../lib/format';

export function DashboardPage() {
  const { data, isLoading, error } = useDashboard();
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorBanner error={error} />;
  const { totals } = data;

  return (
    <>
      <PageHeader title="Dashboard" subtitle="All portfolios combined" actions={<StaleBadge stale={data.stale} />} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total value" value={formatUsd(totals.valueUsd)} />
        <Stat label="24h change" value={<PnlText value={totals.change24hUsd} pct={totals.change24hPct} />} />
        <Stat label="Unrealized P/L" value={<PnlText value={totals.unrealizedPnlUsd} pct={totals.unrealizedPnlPct} />} />
        <Stat label="Realized P/L" value={<PnlText value={totals.realizedPnlUsd} />} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle>Value, last 30 days</SectionTitle>
          <ValueChart points={data.history} />
        </Card>
        <Card>
          <SectionTitle>Allocation</SectionTitle>
          <AllocationChart holdings={data.holdings} />
        </Card>
      </div>
      <Card>
        <SectionTitle>Holdings</SectionTitle>
        <HoldingsTable holdings={data.holdings} />
        {totals.missingPrices.length > 0 && <p className="mt-3 text-xs text-warn">No current price for: {totals.missingPrices.join(', ')}</p>}
      </Card>
      <Card>
        <SectionTitle actions={<Link to="/portfolios" className="text-sm text-accent hover:underline">Manage</Link>}>Portfolios</SectionTitle>
        {data.portfolios.length === 0 ? (
          <EmptyState title="No portfolios yet">
            <Link to="/portfolios" className="text-accent hover:underline">Create your first portfolio</Link>
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {data.portfolios.map((p) => (
              <li key={p.id}>
                <Link to={`/portfolios/${p.id}`} className="flex items-center justify-between gap-4 py-3 hover:text-accent">
                  <span className="font-medium">{p.name}</span>
                  <span className="flex items-center gap-6">
                    <span className="num">{formatUsd(p.totals.valueUsd)}</span>
                    <PnlText value={p.totals.unrealizedPnlUsd} pct={p.totals.unrealizedPnlPct} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
```

`services/frontend/src/pages/PortfoliosPage.tsx`
```tsx
import { Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { PnlText } from '../components/PnlText';
import { Button, Card, EmptyState, ErrorBanner, inputClass, PageHeader, Spinner, StaleBadge } from '../components/ui';
import { useCreatePortfolio, useDeletePortfolio, usePortfolios } from '../hooks/portfolios';
import { formatUsd } from '../lib/format';

export function PortfoliosPage() {
  const { data, isLoading, error } = usePortfolios();
  const create = useCreatePortfolio();
  const remove = useDeletePortfolio();
  const [name, setName] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate(name.trim(), { onSuccess: () => setName('') });
  }

  return (
    <>
      <PageHeader title="Portfolios" actions={<StaleBadge stale={data?.stale} />} />
      <Card>
        <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row">
          <input className={inputClass} placeholder="New portfolio name" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" disabled={create.isPending} className="shrink-0">Create portfolio</Button>
        </form>
        <div className="mt-3"><ErrorBanner error={create.error ?? remove.error} /></div>
      </Card>
      {isLoading && <Spinner />}
      <ErrorBanner error={error} />
      {data && data.items.length === 0 && <EmptyState title="No portfolios yet">Create one above to start tracking.</EmptyState>}
      <div className="grid gap-4 md:grid-cols-2">
        {data?.items.map((p) => (
          <Card key={p.id} className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <Link to={`/portfolios/${p.id}`} className="text-lg font-semibold hover:text-accent">{p.name}</Link>
              <button
                type="button"
                aria-label={`Delete ${p.name}`}
                className="text-muted hover:text-loss"
                onClick={() => window.confirm(`Delete "${p.name}" and all its transactions?`) && remove.mutate(p.id)}
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div><p className="text-xs text-muted">Value</p><p className="num mt-1 font-medium">{formatUsd(p.totals.valueUsd)}</p></div>
              <div><p className="text-xs text-muted">24h</p><p className="mt-1"><PnlText value={p.totals.change24hUsd} /></p></div>
              <div><p className="text-xs text-muted">Unrealized</p><p className="mt-1"><PnlText value={p.totals.unrealizedPnlUsd} /></p></div>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
```

`services/frontend/src/pages/PortfolioDetailPage.tsx`
```tsx
import { Pencil, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AddTransactionModal } from '../components/AddTransactionModal';
import { AllocationChart, ValueChart } from '../components/charts';
import { HoldingsTable } from '../components/HoldingsTable';
import { PnlText } from '../components/PnlText';
import { TransactionsTable } from '../components/TransactionsTable';
import { Button, Card, ErrorBanner, inputClass, PageHeader, SectionTitle, Spinner, StaleBadge, Stat } from '../components/ui';
import { useDeletePortfolio, useHoldings, usePortfolio, useRenamePortfolio, useSnapshots, useTransactions } from '../hooks/portfolios';
import { formatUsd } from '../lib/format';

export function PortfolioDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const portfolio = usePortfolio(id);
  const holdings = useHoldings(id);
  const transactions = useTransactions(id);
  const snapshots = useSnapshots(id, 30);
  const rename = useRenamePortfolio(id);
  const remove = useDeletePortfolio();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');

  if (portfolio.isLoading) return <Spinner />;
  if (portfolio.error || !portfolio.data) return <ErrorBanner error={portfolio.error} />;

  function submitRename(e: FormEvent) {
    e.preventDefault();
    rename.mutate(name.trim(), { onSuccess: () => setEditing(false) });
  }

  const totals = holdings.data?.totals;
  const title = editing ? (
    <form onSubmit={submitRename} className="flex gap-2">
      <input className={inputClass} autoFocus required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      <Button type="submit" disabled={rename.isPending}>Save</Button>
      <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
    </form>
  ) : (
    <span className="flex items-center gap-3">
      {portfolio.data.name}
      <button type="button" aria-label="Rename portfolio" className="text-muted hover:text-text" onClick={() => { setName(portfolio.data!.name); setEditing(true); }}>
        <Pencil size={16} />
      </button>
    </span>
  );

  return (
    <>
      <PageHeader
        title={title}
        actions={
          <>
            <StaleBadge stale={holdings.data?.stale} />
            <Button onClick={() => setAdding(true)}><Plus size={16} />Add transaction</Button>
            <Button
              variant="danger"
              onClick={() => window.confirm('Delete this portfolio and all its transactions?') && remove.mutate(id, { onSuccess: () => navigate('/portfolios') })}
            >
              Delete
            </Button>
          </>
        }
      />
      <ErrorBanner error={rename.error ?? remove.error ?? holdings.error} />
      {totals && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Value" value={formatUsd(totals.valueUsd)} />
          <Stat label="Cost basis" value={formatUsd(totals.costBasisUsd)} />
          <Stat label="Unrealized P/L" value={<PnlText value={totals.unrealizedPnlUsd} pct={totals.unrealizedPnlPct} />} />
          <Stat label="Realized P/L" value={<PnlText value={totals.realizedPnlUsd} />} />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle>Value, last 30 days</SectionTitle>
          {snapshots.data ? <ValueChart points={snapshots.data.points} /> : <Spinner />}
        </Card>
        <Card>
          <SectionTitle>Allocation</SectionTitle>
          {holdings.data ? <AllocationChart holdings={holdings.data.holdings} /> : <Spinner />}
        </Card>
      </div>
      <Card>
        <SectionTitle>Holdings</SectionTitle>
        {holdings.data ? <HoldingsTable holdings={holdings.data.holdings} /> : <Spinner />}
      </Card>
      <Card>
        <SectionTitle>Transactions</SectionTitle>
        {transactions.data ? <TransactionsTable items={transactions.data.items} /> : <Spinner />}
      </Card>
      <AddTransactionModal portfolioId={id} open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
```

In `services/frontend/src/App.tsx`: replace the index redirect with `<Route index element={<DashboardPage />} />`, add `<Route path="portfolios" element={<PortfoliosPage />} />` and `<Route path="portfolios/:id" element={<PortfolioDetailPage />} />`, remove the `Navigate` import and the Task 17 comment, and import the three pages.

- [ ] **Step 4: Verify**

Run: `cd services/frontend && npm run lint && npm test && npm run build && cd ../.. && docker compose up -d --build frontend`
Then in a browser at http://localhost (demo account):
- Dashboard shows 4 stats, a 30-day chart, the donut and holdings.
- Portfolio "Long-term HODL" lists 4 transactions.
- Adding a sell of 100 ETH shows "Cannot sell 100 ethereum…" in the modal.
- Adding a buy of 0.1 BTC updates holdings.
- Deleting the ETH buy shows the 422 message.
- Creating and deleting a portfolio works.
Expected: lint, tests and build pass, and every flow above behaves as described.

- [ ] **Step 5: Commit**

```bash
git add services/frontend
git commit -m "feat(frontend): dashboard, portfolios, holdings, transactions and charts"
```

---

### Task 18: frontend markets, coin detail, watchlist, alerts, notifications

**Files:**
- Create: `services/frontend/src/hooks/{alerts.ts,notifications.ts}`
- Create: `services/frontend/src/components/{AlertForm.tsx,NotificationBell.tsx,WatchButton.tsx}`
- Create: `services/frontend/src/pages/{MarketsPage.tsx,CoinDetailPage.tsx,WatchlistPage.tsx,AlertsPage.tsx,NotificationsPage.tsx}`
- Modify: `services/frontend/src/hooks/market.ts`, `src/components/Layout.tsx`, `src/App.tsx`

**Interfaces:**
- Consumes: Task 7 endpoints; `useCoins`, `useCoinMap`, `usePortfolios`, `AddTransactionModal`, `PriceChart` (Task 17).
- Produces:
  - Hooks: `usePriceHistory(id, days)`, `useWatchlist`, `useToggleWatchlist`; `useAlerts`, `useCreateAlert`, `useDeleteAlert`; `useNotifications`, `useMarkRead`, `useMarkAllRead`.
  - Components: `WatchButton({coinId})`, `AlertForm({fixedCoinId?})`, `NotificationBell`.
  - Routes: `/markets`, `/markets/:id`, `/watchlist`, `/alerts`, `/notifications`.

- [ ] **Step 1: Hooks**

Append to `services/frontend/src/hooks/market.ts`:
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PriceHistory } from '../lib/types';

export const usePriceHistory = (id: string, days: number) =>
  useQuery({ queryKey: ['history', id, days], queryFn: () => api.get<PriceHistory>(`/market/history/${id}?days=${days}`) });

export const useWatchlist = () =>
  useQuery({ queryKey: ['watchlist'], queryFn: () => api.get<{ items: Coin[]; stale: boolean }>('/watchlist') });

export function useToggleWatchlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ coinId, watched }: { coinId: string; watched: boolean }) =>
      watched ? api.del(`/watchlist/${coinId}`) : api.post('/watchlist', { coinId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['watchlist'] }),
  });
}
```
(merge the imports at the top of the file: `import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';` and `import type { Coin, PriceHistory } from '../lib/types';`).

`services/frontend/src/hooks/alerts.ts`
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/client';
import type { Alert } from '../lib/types';

export const useAlerts = () =>
  useQuery({ queryKey: ['alerts'], queryFn: () => api.get<{ items: Alert[]; stale: boolean }>('/alerts'), refetchInterval: 30_000 });

export interface NewAlert {
  coinId: string;
  direction: 'above' | 'below';
  targetPrice: number;
}

export function useCreateAlert() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: NewAlert) => api.post<Alert>('/alerts', input), onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }) });
}

export function useDeleteAlert() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.del(`/alerts/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }) });
}
```

`services/frontend/src/hooks/notifications.ts`
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/client';
import type { AppNotification } from '../lib/types';

export const useNotifications = () =>
  useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: AppNotification[]; unreadCount: number }>('/notifications'),
    refetchInterval: 30_000,
  });

function useInvalidate() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['notifications'] }), qc.invalidateQueries({ queryKey: ['alerts'] })]);
}

export function useMarkRead() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.post(`/notifications/${id}/read`), onSuccess: invalidate });
}

export function useMarkAllRead() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: invalidate });
}
```

- [ ] **Step 2: Components**

`services/frontend/src/components/WatchButton.tsx`
```tsx
import { Star } from 'lucide-react';
import { useToggleWatchlist, useWatchlist } from '../hooks/market';

export function WatchButton({ coinId }: { coinId: string }) {
  const { data } = useWatchlist();
  const toggle = useToggleWatchlist();
  const watched = data?.items.some((c) => c.id === coinId) ?? false;
  return (
    <button
      type="button"
      aria-label={watched ? 'Remove from watchlist' : 'Add to watchlist'}
      aria-pressed={watched}
      disabled={toggle.isPending}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle.mutate({ coinId, watched });
      }}
      className={watched ? 'text-warn' : 'text-muted hover:text-warn'}
    >
      <Star size={16} fill={watched ? 'currentColor' : 'none'} />
    </button>
  );
}
```

`services/frontend/src/components/AlertForm.tsx`
```tsx
import { type FormEvent, useState } from 'react';
import { useCreateAlert } from '../hooks/alerts';
import { useCoins } from '../hooks/market';
import { formatUsd } from '../lib/format';
import { Button, ErrorBanner, Field, inputClass } from './ui';

export function AlertForm({ fixedCoinId }: { fixedCoinId?: string }) {
  const { data } = useCoins();
  const create = useCreateAlert();
  const [coinId, setCoinId] = useState(fixedCoinId ?? 'bitcoin');
  const [direction, setDirection] = useState<'above' | 'below'>('above');
  const [target, setTarget] = useState('');
  const coin = data?.coins.find((c) => c.id === coinId);

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate({ coinId, direction, targetPrice: Number(target) }, { onSuccess: () => setTarget('') });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <ErrorBanner error={create.error} />
      <div className="grid gap-4 sm:grid-cols-3">
        {!fixedCoinId && (
          <Field label="Coin">
            <select className={inputClass} value={coinId} onChange={(e) => setCoinId(e.target.value)}>
              {(data?.coins ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="When price is">
          <select className={inputClass} value={direction} onChange={(e) => setDirection(e.target.value as 'above' | 'below')}>
            <option value="above">at or above</option>
            <option value="below">at or below</option>
          </select>
        </Field>
        <Field label="Target (USD)" hint={coin ? `Now ${formatUsd(coin.currentPrice)}` : undefined}>
          <input className={`${inputClass} num`} type="number" min="0" step="any" required value={target} onChange={(e) => setTarget(e.target.value)} />
        </Field>
      </div>
      <Button type="submit" disabled={create.isPending}>{create.isSuccess && !target ? 'Alert created' : 'Create alert'}</Button>
    </form>
  );
}
```

`services/frontend/src/components/NotificationBell.tsx`
```tsx
import { Bell } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMarkAllRead, useNotifications } from '../hooks/notifications';

export function NotificationBell() {
  const { data } = useNotifications();
  const markAll = useMarkAllRead();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = data?.unreadCount ?? 0;

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label={`Notifications (${unread} unread)`} className="relative rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-text" onClick={() => setOpen((o) => !o)}>
        <Bell size={18} />
        {unread > 0 && (
          <span className="num absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-loss px-1 text-[10px] font-bold text-white">{unread > 9 ? '9+' : unread}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 rounded-xl border border-border bg-surface shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-semibold">Notifications</span>
            <button type="button" className="text-xs text-accent hover:underline disabled:opacity-50" disabled={unread === 0} onClick={() => markAll.mutate()}>
              Mark all read
            </button>
          </div>
          <ul className="max-h-80 divide-y divide-border overflow-y-auto">
            {(data?.items ?? []).slice(0, 6).map((n) => (
              <li key={n.id} className={`px-4 py-3 text-sm ${n.readAt ? 'text-muted' : ''}`}>
                <p className="font-medium">{n.title}</p>
                <p className="mt-0.5 text-xs text-muted">{n.body}</p>
              </li>
            ))}
            {data?.items.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">You're all caught up</li>}
          </ul>
          <Link to="/notifications" onClick={() => setOpen(false)} className="block border-t border-border px-4 py-2.5 text-center text-xs text-accent hover:underline">
            View all
          </Link>
        </div>
      )}
    </div>
  );
}
```

In `services/frontend/src/components/Layout.tsx` add `import { NotificationBell } from './NotificationBell';` and render `<NotificationBell />` as the first child of `<header>`.

- [ ] **Step 3: Pages**

`services/frontend/src/pages/MarketsPage.tsx`
```tsx
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CoinIcon } from '../components/CoinIcon';
import { Card, ErrorBanner, inputClass, PageHeader, Spinner, StaleBadge } from '../components/ui';
import { WatchButton } from '../components/WatchButton';
import { useCoins } from '../hooks/market';
import { formatCompactUsd, formatPct, formatUsd, pnlClass } from '../lib/format';

export function MarketsPage() {
  const { data, isLoading, error } = useCoins();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const coins = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.coins ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q));
  }, [data, query]);

  return (
    <>
      <PageHeader title="Markets" subtitle="Top coins by market cap" actions={<StaleBadge stale={data?.stale} />} />
      <input className={`${inputClass} max-w-sm`} placeholder="Search coins…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ErrorBanner error={error} />
      {isLoading ? (
        <Spinner />
      ) : (
        <Card>
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-muted">
                <tr className="border-b border-border">
                  <th className="w-10 px-5 py-2" />
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Coin</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-3 py-2 text-right font-medium">24h</th>
                  <th className="px-5 py-2 text-right font-medium">Market cap</th>
                </tr>
              </thead>
              <tbody>
                {coins.map((c, i) => (
                  <tr key={c.id} onClick={() => navigate(`/markets/${c.id}`)} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-surface-2/50">
                    <td className="px-5 py-3"><WatchButton coinId={c.id} /></td>
                    <td className="num px-3 py-3 text-muted">{i + 1}</td>
                    <td className="px-3 py-3">
                      <span className="flex items-center gap-2.5">
                        <CoinIcon coinId={c.id} image={c.image} />
                        <span className="font-medium">{c.name}</span>
                        <span className="text-xs uppercase text-muted">{c.symbol}</span>
                      </span>
                    </td>
                    <td className="num px-3 py-3 text-right">{formatUsd(c.currentPrice)}</td>
                    <td className={`num px-3 py-3 text-right ${pnlClass(c.change24h)}`}>{formatPct(c.change24h)}</td>
                    <td className="num px-5 py-3 text-right text-muted">{formatCompactUsd(c.marketCap)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
```

`services/frontend/src/pages/CoinDetailPage.tsx`
```tsx
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { AddTransactionModal } from '../components/AddTransactionModal';
import { AlertForm } from '../components/AlertForm';
import { PriceChart } from '../components/charts';
import { CoinIcon } from '../components/CoinIcon';
import { Button, Card, ErrorBanner, inputClass, PageHeader, SectionTitle, Spinner, StaleBadge } from '../components/ui';
import { WatchButton } from '../components/WatchButton';
import { useCoinMap, usePriceHistory } from '../hooks/market';
import { usePortfolios } from '../hooks/portfolios';
import { formatPct, formatUsd, pnlClass } from '../lib/format';

const RANGES = [
  { days: 1, label: '24H' },
  { days: 7, label: '7D' },
  { days: 30, label: '30D' },
  { days: 365, label: '1Y' },
];

export function CoinDetailPage() {
  const { id = '' } = useParams();
  const coin = useCoinMap().get(id);
  const [days, setDays] = useState(7);
  const history = usePriceHistory(id, days);
  const portfolios = usePortfolios();
  const [portfolioId, setPortfolioId] = useState('');
  const [adding, setAdding] = useState(false);
  const selectedPortfolio = portfolioId || portfolios.data?.items[0]?.id || '';

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <CoinIcon coinId={id} image={coin?.image} size={32} />
            {coin?.name ?? id}
            <span className="text-base uppercase text-muted">{coin?.symbol}</span>
            <WatchButton coinId={id} />
          </span>
        }
        subtitle={
          coin && (
            <span className="num">
              {formatUsd(coin.currentPrice)} <span className={pnlClass(coin.change24h)}>{formatPct(coin.change24h)}</span> (24h)
            </span>
          )
        }
        actions={<StaleBadge stale={history.data?.stale} />}
      />
      <Card>
        <SectionTitle
          actions={
            <div className="flex gap-1 rounded-lg bg-bg p-1">
              {RANGES.map((r) => (
                <button key={r.days} type="button" onClick={() => setDays(r.days)} className={`rounded-md px-3 py-1 text-xs font-medium ${days === r.days ? 'bg-surface-2 text-text' : 'text-muted hover:text-text'}`}>
                  {r.label}
                </button>
              ))}
            </div>
          }
        >
          Price
        </SectionTitle>
        <ErrorBanner error={history.error} />
        {history.data ? <PriceChart points={history.data.points} days={days} /> : <Spinner />}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Price alert</SectionTitle>
          <AlertForm fixedCoinId={id} />
        </Card>
        <Card>
          <SectionTitle>Record a trade</SectionTitle>
          {portfolios.data?.items.length ? (
            <div className="flex flex-col gap-3 sm:flex-row">
              <select className={inputClass} value={selectedPortfolio} onChange={(e) => setPortfolioId(e.target.value)}>
                {portfolios.data.items.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <Button className="shrink-0" onClick={() => setAdding(true)}>Add transaction</Button>
            </div>
          ) : (
            <p className="text-sm text-muted">Create a portfolio first.</p>
          )}
        </Card>
      </div>
      {selectedPortfolio && <AddTransactionModal key={`${selectedPortfolio}-${id}`} portfolioId={selectedPortfolio} defaultCoinId={id} open={adding} onClose={() => setAdding(false)} />}
    </>
  );
}
```

`services/frontend/src/pages/WatchlistPage.tsx`
```tsx
import { Link } from 'react-router-dom';
import { CoinIcon } from '../components/CoinIcon';
import { Card, EmptyState, ErrorBanner, PageHeader, Spinner, StaleBadge } from '../components/ui';
import { WatchButton } from '../components/WatchButton';
import { useWatchlist } from '../hooks/market';
import { formatPct, formatUsd, pnlClass } from '../lib/format';

export function WatchlistPage() {
  const { data, isLoading, error } = useWatchlist();
  return (
    <>
      <PageHeader title="Watchlist" actions={<StaleBadge stale={data?.stale} />} />
      <ErrorBanner error={error} />
      {isLoading && <Spinner />}
      {data && data.items.length === 0 && (
        <EmptyState title="Your watchlist is empty">
          Star coins on the <Link to="/markets" className="text-accent hover:underline">Markets</Link> page.
        </EmptyState>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data?.items.map((c) => (
          <Link key={c.id} to={`/markets/${c.id}`}>
            <Card className="transition hover:border-accent/60">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2.5">
                  <CoinIcon coinId={c.id} image={c.image} size={28} />
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs uppercase text-muted">{c.symbol}</span>
                </span>
                <WatchButton coinId={c.id} />
              </div>
              <p className="num mt-4 text-2xl font-semibold">{formatUsd(c.currentPrice)}</p>
              <p className={`num mt-1 text-sm ${pnlClass(c.change24h)}`}>{formatPct(c.change24h)} (24h)</p>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
```

`services/frontend/src/pages/AlertsPage.tsx`
```tsx
import { Trash2 } from 'lucide-react';
import { AlertForm } from '../components/AlertForm';
import { Card, EmptyState, ErrorBanner, PageHeader, SectionTitle, Spinner, StaleBadge } from '../components/ui';
import { useAlerts, useDeleteAlert } from '../hooks/alerts';
import { formatUsd } from '../lib/format';

export function AlertsPage() {
  const { data, isLoading, error } = useAlerts();
  const remove = useDeleteAlert();
  return (
    <>
      <PageHeader title="Price alerts" subtitle="The worker checks prices every minute and notifies you once." actions={<StaleBadge stale={data?.stale} />} />
      <Card>
        <SectionTitle>New alert</SectionTitle>
        <AlertForm />
      </Card>
      <Card>
        <SectionTitle>Your alerts</SectionTitle>
        <ErrorBanner error={error ?? remove.error} />
        {isLoading && <Spinner />}
        {data?.items.length === 0 && <EmptyState title="No alerts yet" />}
        <ul className="divide-y divide-border">
          {data?.items.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <span>
                <span className="font-medium">{a.coinId}</span> {a.direction === 'above' ? '≥' : '≤'} <span className="num">{formatUsd(a.targetPrice)}</span>
                <span className="ml-3 text-muted">now <span className="num">{formatUsd(a.currentPrice)}</span></span>
              </span>
              <span className="flex items-center gap-4">
                {a.active ? (
                  <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-xs text-accent">active</span>
                ) : (
                  <span className="rounded-full bg-gain/15 px-2.5 py-0.5 text-xs text-gain">triggered {a.triggeredAt && new Date(a.triggeredAt).toLocaleString()}</span>
                )}
                <button type="button" aria-label="Delete alert" className="text-muted hover:text-loss" onClick={() => remove.mutate(a.id)}>
                  <Trash2 size={15} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
```

`services/frontend/src/pages/NotificationsPage.tsx`
```tsx
import { Button, Card, EmptyState, ErrorBanner, PageHeader, Spinner } from '../components/ui';
import { useMarkAllRead, useMarkRead, useNotifications } from '../hooks/notifications';

export function NotificationsPage() {
  const { data, isLoading, error } = useNotifications();
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  return (
    <>
      <PageHeader
        title="Notifications"
        actions={<Button variant="ghost" disabled={!data?.unreadCount} onClick={() => markAll.mutate()}>Mark all read</Button>}
      />
      <ErrorBanner error={error} />
      {isLoading && <Spinner />}
      {data?.items.length === 0 && <EmptyState title="No notifications" />}
      <Card className="!p-0">
        <ul className="divide-y divide-border">
          {data?.items.map((n) => (
            <li key={n.id} className="flex items-start justify-between gap-4 px-5 py-4">
              <div className={n.readAt ? 'text-muted' : ''}>
                <p className="font-medium">{n.title}</p>
                <p className="mt-1 text-sm text-muted">{n.body}</p>
                <p className="mt-1 text-xs text-muted">{new Date(n.createdAt).toLocaleString()}</p>
              </div>
              {!n.readAt && (
                <button type="button" className="shrink-0 text-xs text-accent hover:underline" onClick={() => markRead.mutate(n.id)}>
                  Mark read
                </button>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
```

In `services/frontend/src/App.tsx` add the routes `markets`, `markets/:id`, `watchlist`, `alerts`, `notifications` with their page imports.

- [ ] **Step 4: Verify**

Run: `cd services/frontend && npm run lint && npm test && npm run build && cd ../.. && docker compose up -d --build frontend`
Then check in the browser (demo account):
- The markets search filters the list.
- Starring a coin shows it on /watchlist.
- A coin page chart switches between 24H/7D/30D/1Y.
- On /alerts, create "bitcoin at or above" with a target below the current price. Within about 60 s the bell shows 1 unread and the alert shows "triggered".
- "Mark all read" clears the badge.
Expected: every check above behaves as described.

- [ ] **Step 5: Commit**

```bash
git add services/frontend
git commit -m "feat(frontend): markets, coin charts, watchlist, price alerts and notifications"
```

---

### Task 19: frontend avatar upload and import/export page

**Files:**
- Create: `services/frontend/src/lib/upload.ts`, `src/hooks/jobs.ts`, `src/components/AvatarUploader.tsx`, `src/pages/FilesPage.tsx`
- Modify: `services/frontend/src/pages/ProfilePage.tsx`, `src/App.tsx`

**Interfaces:**
- Consumes: Task 10 endpoints (`/me/avatar/upload-url`, `/me/avatar`, `/uploads/import-url`, `/jobs`), `usePortfolios`, `useInvalidatePortfolioData` (Task 17).
- Produces: `uploadFile(url, file)`, `useJobs()` (polls every 1.5 s while any job is queued/running, otherwise every 10 s), `useCreateJob()`, `<AvatarUploader>`, route `/files`.

- [ ] **Step 1: Upload helper and job hooks**

`services/frontend/src/lib/upload.ts`
```ts
/** PUT a file straight to object storage using a presigned URL (no auth header: the URL is the credential). */
export async function uploadFile(url: string, file: File): Promise<void> {
  const res = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
  if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status})`);
}
```

`services/frontend/src/hooks/jobs.ts`
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/client';
import type { Job, JobType } from '../lib/types';

const isActive = (job: Job) => job.status === 'queued' || job.status === 'running';

export const useJobs = () =>
  useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.get<{ items: Job[] }>('/jobs'),
    refetchInterval: (query) => (query.state.data?.items.some(isActive) ? 1500 : 10_000),
  });

export interface CreateJobInput {
  type: JobType;
  params: { portfolioId: string; key?: string };
}

export function useCreateJob() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: CreateJobInput) => api.post<Job>('/jobs', input), onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }) });
}
```

- [ ] **Step 2: Avatar uploader on the profile page**

`services/frontend/src/components/AvatarUploader.tsx`
```tsx
import { type ChangeEvent, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/client';
import type { UploadTarget, User } from '../lib/types';
import { uploadFile } from '../lib/upload';
import { ErrorBanner, errorMessage } from './ui';

const MAX_BYTES = 2 * 1024 * 1024;

export function AvatarUploader() {
  const { user, setUser } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return setError('Please choose an image file.');
    if (file.size > MAX_BYTES) return setError('The image must be 2 MB or smaller.');
    setBusy(true);
    setError(null);
    try {
      // 1) ask the api for a presigned URL  2) upload directly to storage  3) tell the api which key to use
      const { uploadUrl, key } = await api.post<UploadTarget>('/me/avatar/upload-url');
      await uploadFile(uploadUrl, file);
      setUser(await api.put<User>('/me/avatar', { key }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-5">
      {user?.avatarUrl ? (
        <img src={user.avatarUrl} alt="Your avatar" className="h-20 w-20 rounded-full object-cover" />
      ) : (
        <span className="grid h-20 w-20 place-items-center rounded-full bg-surface-2 text-2xl font-semibold text-muted">{user?.displayName.slice(0, 1).toUpperCase()}</span>
      )}
      <div className="space-y-2">
        <label className="inline-flex cursor-pointer items-center rounded-lg border border-border px-3.5 py-2 text-sm font-medium hover:bg-surface-2">
          {busy ? 'Uploading…' : 'Upload new picture'}
          <input type="file" accept="image/*" className="sr-only" disabled={busy} onChange={onFile} />
        </label>
        <p className="text-xs text-muted">PNG or JPEG, up to 2 MB. Stored in object storage.</p>
        {error && <ErrorBanner error={new Error(error)} />}
      </div>
    </div>
  );
}
```

In `services/frontend/src/pages/ProfilePage.tsx` add, before the display-name card:
```tsx
      <Card className="max-w-xl">
        <SectionTitle>Avatar</SectionTitle>
        <AvatarUploader />
      </Card>
```
with `import { AvatarUploader } from '../components/AvatarUploader';`.

- [ ] **Step 3: Import / export page**

`services/frontend/src/pages/FilesPage.tsx`
```tsx
import { Download, FileText, Upload } from 'lucide-react';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { Button, Card, EmptyState, ErrorBanner, errorMessage, Field, inputClass, PageHeader, SectionTitle } from '../components/ui';
import { useCreateJob, useJobs } from '../hooks/jobs';
import { useInvalidatePortfolioData, usePortfolios } from '../hooks/portfolios';
import { api } from '../lib/client';
import type { Job, UploadTarget } from '../lib/types';
import { uploadFile } from '../lib/upload';

const MAX_CSV_BYTES = 1024 * 1024;
const JOB_LABELS: Record<Job['type'], string> = { export_csv: 'CSV export', import_csv: 'CSV import', report_pdf: 'PDF report' };
const STATUS_STYLES: Record<Job['status'], string> = {
  queued: 'bg-surface-2 text-muted',
  running: 'bg-accent/15 text-accent',
  done: 'bg-gain/15 text-gain',
  failed: 'bg-loss/15 text-loss',
};

export function FilesPage() {
  const portfolios = usePortfolios();
  const jobs = useJobs();
  const createJob = useCreateJob();
  const invalidatePortfolios = useInvalidatePortfolioData();
  const [portfolioId, setPortfolioId] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const selected = portfolioId || portfolios.data?.items[0]?.id || '';
  const names = new Map((portfolios.data?.items ?? []).map((p) => [p.id, p.name]));

  // When an import finishes, refresh portfolio data so new transactions show up everywhere.
  const doneImports = jobs.data?.items.filter((j) => j.type === 'import_csv' && j.status === 'done').length ?? 0;
  const seenImports = useRef<number | null>(null);
  useEffect(() => {
    if (seenImports.current !== null && doneImports > seenImports.current) void invalidatePortfolios();
    seenImports.current = doneImports;
  }, [doneImports, invalidatePortfolios]);

  async function onCsv(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !selected) return;
    if (!file.name.toLowerCase().endsWith('.csv')) return setImportError('Please choose a .csv file.');
    if (file.size > MAX_CSV_BYTES) return setImportError('CSV files are limited to 1 MB.');
    setUploading(true);
    setImportError(null);
    try {
      const { uploadUrl, key } = await api.post<UploadTarget>('/uploads/import-url');
      await uploadFile(uploadUrl, new File([file], file.name, { type: 'text/csv' }));
      await createJob.mutateAsync({ type: 'import_csv', params: { portfolioId: selected, key } });
    } catch (err) {
      setImportError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <PageHeader title="Import / Export" subtitle="Files are processed in the background by the worker and stored in object storage." />
      {portfolios.data?.items.length === 0 ? (
        <EmptyState title="Create a portfolio first" />
      ) : (
        <Card>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,280px)_1fr]">
            <Field label="Portfolio">
              <select className={inputClass} value={selected} onChange={(e) => setPortfolioId(e.target.value)}>
                {portfolios.data?.items.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            <div className="flex flex-wrap items-end gap-2">
              <Button variant="ghost" disabled={!selected || createJob.isPending} onClick={() => createJob.mutate({ type: 'export_csv', params: { portfolioId: selected } })}>
                <Download size={15} />Export CSV
              </Button>
              <Button variant="ghost" disabled={!selected || createJob.isPending} onClick={() => createJob.mutate({ type: 'report_pdf', params: { portfolioId: selected } })}>
                <FileText size={15} />PDF report
              </Button>
              <label className={`inline-flex cursor-pointer items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-bg hover:brightness-110 ${uploading || !selected ? 'pointer-events-none opacity-50' : ''}`}>
                <Upload size={15} />
                {uploading ? 'Uploading…' : 'Import CSV'}
                <input type="file" accept=".csv,text/csv" className="sr-only" onChange={onCsv} />
              </label>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <ErrorBanner error={createJob.error} />
            {importError && <ErrorBanner error={new Error(importError)} />}
          </div>
          <details className="mt-4 text-sm text-muted">
            <summary className="cursor-pointer">CSV format</summary>
            <pre className="num mt-2 overflow-x-auto rounded-lg bg-bg p-3 text-xs">{`date,type,coin_id,quantity,price_usd,fee_usd,note
2024-01-31T12:00:00Z,buy,bitcoin,0.5,42000,10,first buy
2024-03-01T09:30:00Z,sell,bitcoin,0.1,61000,5,`}</pre>
          </details>
        </Card>
      )}
      <Card>
        <SectionTitle>Recent jobs</SectionTitle>
        <ErrorBanner error={jobs.error} />
        {jobs.data?.items.length === 0 && <EmptyState title="No jobs yet" />}
        <ul className="divide-y divide-border">
          {jobs.data?.items.map((job) => (
            <li key={job.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <span>
                <span className="font-medium">{JOB_LABELS[job.type]}</span>
                <span className="ml-2 text-muted">{names.get(job.params.portfolioId ?? '') ?? 'deleted portfolio'}</span>
                <span className="ml-2 text-xs text-muted">{new Date(job.createdAt).toLocaleString()}</span>
              </span>
              <span className="flex items-center gap-3">
                {job.status === 'done' && job.downloadUrl && (
                  <a href={job.downloadUrl} className="text-accent hover:underline">Download {job.result?.filename}</a>
                )}
                {job.status === 'done' && job.type === 'import_csv' && <span className="text-muted">{job.result?.imported} transactions imported</span>}
                {job.status === 'failed' && <span className="max-w-md text-loss">{job.error}</span>}
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[job.status]}`}>{job.status}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
```

In `services/frontend/src/App.tsx` add `<Route path="files" element={<FilesPage />} />` with its import.

- [ ] **Step 4: Verify**

Run: `cd services/frontend && npm run lint && npm test && npm run build && cd ../.. && docker compose up -d --build frontend`
Then check in the browser:
- Profile: upload a PNG. The avatar appears on the profile and in the header, and survives a reload.
- Files: "Export CSV" goes queued → done, and Download fetches `long-term-hodl-transactions.csv`.
- Re-importing that CSV into "Active Trading" gives done with "4 transactions imported", and the dashboard updates.
- Importing a CSV with `quantity` 0 fails with "row 2: quantity must be a positive number".
- "PDF report" downloads a PDF.
Expected: every check above behaves as described.

- [ ] **Step 5: Commit**

```bash
git add services/frontend
git commit -m "feat(frontend): avatar upload and CSV/PDF import-export via presigned URLs and jobs"
```

---
### Task 20: containerised test runner (`make test`)

**Files:**
- Modify: `docker-compose.test.yml` (add the four `*-test` runner services)
- Create: `scripts/test.sh`

**Interfaces:**
- Consumes: the `test` build target of every service (Tasks 2, 5, 11, 15) and the test infra (Task 5).
- Produces: `make test` / `./scripts/test.sh [price-service|api|worker|frontend …]`. Exits non-zero on the first failing service and always tears the infra down. This is the CI entry point that later lessons build on.

- [ ] **Step 1: Add runner services** to the end of `docker-compose.test.yml` under `services:`

```yaml
  # ---- test runners (built from each service's `test` stage) ----
  price-service-test:
    build: { context: ./services/price-service, target: test }

  api-test:
    build: { context: ./services/api, target: test }
    environment:
      DATABASE_URL: postgres://cryptofolio:cryptofolio@postgres:5432/cryptofolio_test
      REDIS_URL: redis://redis:6379/0
      S3_ENDPOINT: http://minio:9000

  worker-test:
    build: { context: ./services/worker, target: test }
    environment:
      INTEGRATION: "1"
      DATABASE_URL: postgres://cryptofolio:cryptofolio@postgres:5432/cryptofolio_test
      REDIS_URL: redis://redis:6379/1
      S3_ENDPOINT: http://minio:9000

  frontend-test:
    build: { context: ./services/frontend, target: test }
```

- [ ] **Step 2: Test script**

`scripts/test.sh`
```bash
#!/usr/bin/env bash
# Runs lint + unit + integration tests of every service inside containers,
# exactly the way a CI pipeline would.
#   Usage: scripts/test.sh [price-service|api|worker|frontend ...]   (default: all)
set -euo pipefail
cd "$(dirname "$0")/.."

compose() { docker compose -f docker-compose.test.yml "$@"; }
if [ $# -eq 0 ]; then set -- price-service api worker frontend; fi

trap 'echo "==> tearing down test infrastructure"; compose down -v --remove-orphans >/dev/null 2>&1' EXIT

echo "==> starting test infrastructure"
compose up -d --wait postgres redis minio
compose run --rm minio-init
compose build migrate
compose run --rm migrate

for svc in "$@"; do
  echo "==> testing ${svc}"
  compose build "${svc}-test"
  compose run --rm "${svc}-test"
done

echo "==> all tests passed: $*"
```

Run: `chmod +x scripts/test.sh`

- [ ] **Step 3: Verify**

Run: `make test`
Expected: output ends with `==> all tests passed: price-service api worker frontend`, exit code 0, and `docker compose -f docker-compose.test.yml ps -a` afterwards is empty. Then break a test on purpose (e.g. change an expected value in `services/price-service/tests/test_api.py`), run `./scripts/test.sh price-service`, see a non-zero exit, and revert.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.test.yml scripts/test.sh
git commit -m "test: containerised test runner for all services (make test)"
```

---

### Task 21: smoke test, documentation, full verification

**Files:**
- Create: `scripts/smoke.mjs`, `README.md`, `docs/architecture.md`, `docs/services/{gateway,frontend,api,price-service,worker}.md`
- Modify: `Makefile` (add `smoke`)

**Interfaces:**
- Consumes: the running stack through the gateway.
- Produces: `make smoke` (`BASE_URL` defaults to `http://localhost`). It exercises every infrastructure component end to end, so it doubles as the post-deploy check in later CD lessons.

- [ ] **Step 1: Smoke test script**

`scripts/smoke.mjs`
```js
#!/usr/bin/env node
// End-to-end smoke test through the gateway - touches every tier and every
// infrastructure component (Postgres, Redis cache + stream, MinIO, worker).
//   Usage: BASE_URL=http://localhost node scripts/smoke.mjs
const BASE = (process.env.BASE_URL ?? 'http://localhost').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 150_000);
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
let token = '';

async function call(method, path, body, expected = [200]) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!expected.includes(res.status)) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

async function waitFor(what, check, intervalMs = 1000) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${TIMEOUT_MS} ms waiting for ${what}`);
}

async function runJob(type, params) {
  const { id } = await call('POST', '/jobs', { type, params }, [202]);
  return waitFor(`${type} job`, async () => {
    const job = await call('GET', `/jobs/${id}`);
    if (job.status === 'failed') throw new Error(`${type} job failed: ${job.error}`);
    return job.status === 'done' && job;
  });
}

async function step(name, fn) {
  const started = Date.now();
  await fn();
  console.log(`✔ ${name} (${Date.now() - started} ms)`);
}

let portfolioId;
let btcPrice;

await step('gateway is up', async () => {
  const res = await fetch(`${BASE}/gateway/healthz`);
  if (!res.ok) throw new Error(`gateway HTTP ${res.status}`);
});
await step('api is ready (postgres, redis, storage)', async () => {
  const ready = await call('GET', '/readyz');
  if (ready.status !== 'ready') throw new Error(JSON.stringify(ready));
});
await step('demo user can log in and has a dashboard', async () => {
  token = (await call('POST', '/auth/login', { email: 'demo@cryptofolio.local', password: 'demo1234' })).accessToken;
  const dashboard = await call('GET', '/dashboard');
  if (!(dashboard.totals.valueUsd > 0)) throw new Error('demo dashboard is empty');
});
await step('register a fresh smoke-test user', async () => {
  const email = `smoke-${Date.now()}@example.com`;
  token = (await call('POST', '/auth/register', { email, password: 'smoke-test-pw', displayName: 'Smoke Test' }, [201])).accessToken;
});
await step('prices come from the price-service', async () => {
  btcPrice = (await call('GET', '/market/prices?ids=bitcoin')).prices.bitcoin.usd;
  if (!(btcPrice > 0)) throw new Error('no bitcoin price');
});
await step('create portfolio, buy, holdings computed', async () => {
  portfolioId = (await call('POST', '/portfolios', { name: 'Smoke' }, [201])).id;
  await call('POST', `/portfolios/${portfolioId}/transactions`, { coinId: 'bitcoin', type: 'buy', quantity: '0.01', priceUsd: String(btcPrice) }, [201]);
  const { holdings } = await call('GET', `/portfolios/${portfolioId}/holdings`);
  if (holdings[0]?.coinId !== 'bitcoin') throw new Error('holding missing');
});
await step('overselling is rejected', async () => {
  await call('POST', `/portfolios/${portfolioId}/transactions`, { coinId: 'bitcoin', type: 'sell', quantity: '1', priceUsd: '1' }, [422]);
});
await step('CSV export: worker job + presigned download', async () => {
  const job = await runJob('export_csv', { portfolioId });
  const csv = await (await fetch(job.downloadUrl)).text();
  if (!csv.startsWith('date,type,coin_id')) throw new Error(`unexpected CSV: ${csv.slice(0, 80)}`);
});
await step('CSV import: presigned upload + worker job', async () => {
  const { uploadUrl, key } = await call('POST', '/uploads/import-url');
  const csv = 'date,type,coin_id,quantity,price_usd,fee_usd,note\n2024-01-01T00:00:00Z,buy,ethereum,1,2000,0,smoke\n';
  const put = await fetch(uploadUrl, { method: 'PUT', body: csv, headers: { 'content-type': 'text/csv' } });
  if (!put.ok) throw new Error(`upload HTTP ${put.status}`);
  const job = await runJob('import_csv', { portfolioId, key });
  if (job.result.imported !== 1) throw new Error(`imported ${job.result.imported}`);
});
await step('PDF report', async () => {
  const job = await runJob('report_pdf', { portfolioId });
  const bytes = Buffer.from(await (await fetch(job.downloadUrl)).arrayBuffer());
  if (bytes.subarray(0, 4).toString() !== '%PDF') throw new Error('not a PDF');
});
await step('avatar upload round trip', async () => {
  const { uploadUrl, key } = await call('POST', '/me/avatar/upload-url');
  const put = await fetch(uploadUrl, { method: 'PUT', body: PNG_1PX, headers: { 'content-type': 'image/png' } });
  if (!put.ok) throw new Error(`upload HTTP ${put.status}`);
  const me = await call('PUT', '/me/avatar', { key });
  if (!(await fetch(me.avatarUrl)).ok) throw new Error('avatar not downloadable');
});
await step('price alert triggers a notification (worker scheduler, up to ~60 s)', async () => {
  await call('POST', '/alerts', { coinId: 'bitcoin', direction: 'above', targetPrice: Math.floor(btcPrice / 2) }, [201]);
  await waitFor('alert notification', async () => (await call('GET', '/notifications')).unreadCount > 0, 3000);
});

console.log('\nSmoke test passed ✅');
```

Add to `Makefile` (and to `.PHONY`):
```makefile
smoke:          ## end-to-end smoke test against the running stack (BASE_URL=http://localhost)
	node scripts/smoke.mjs
```

- [ ] **Step 2: README**

`README.md`
````markdown
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
| `PRICE_PROVIDER` | `mock` | `mock` = offline deterministic prices (best for classrooms); `coingecko` = real prices (free API, rate limited; optional `COINGECKO_API_KEY`) |
| `GATEWAY_PORT` / `S3_PUBLIC_ENDPOINT` | `80` / `http://localhost` | must describe the same address |
| `IMAGE_REGISTRY` / `IMAGE_TAG` | `cryptofolio` / `local` | image names `<registry>/<service>:<tag>`, which is what CI pushes |
| `SEED_DEMO_DATA` | `true` | the migrate job creates the demo user |
| `ALERT_CHECK_INTERVAL_SECONDS` | `60` | worker alert scheduler |

## Things to try in class

- `docker compose up -d --scale worker=3`, then `docker compose exec redis redis-cli XINFO CONSUMERS jobs workers`. The consumer group spreads jobs across workers.
- `docker compose stop worker`, export a CSV (it stays *queued*), then `start worker` and watch it complete. Kill a worker mid-job and the message is reclaimed after 60 s (`XAUTOCLAIM`).
- `docker compose stop price-service`. The UI keeps working: holdings show "—" and a *stale prices* badge appears, and `/api/readyz` stays ready because it is a soft dependency.
- `docker compose stop redis` → `/api/readyz` returns 503 and shows which check failed.
- Change `APP_ENV` and restart only `frontend`. The same image shows a different environment badge (runtime config).
- `curl -s localhost/api/healthz -H 'x-request-id: demo-1'`, then `docker compose logs | grep demo-1` to trace one request across gateway and api.
- `docker compose exec api node -e "fetch('http://127.0.0.1:3000/metrics').then(r=>r.text()).then(console.log)"`: Prometheus metrics (not exposed publicly).
- `docker build --target test services/api`: every Dockerfile has a `test` stage for CI.
- `docker compose exec postgres psql -U cryptofolio -c 'select * from pgmigrations'`: migration history.

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
````

- [ ] **Step 3: Architecture doc**

`docs/architecture.md`
````markdown
# Architecture

## Topology

```mermaid
flowchart LR
  B[Browser] -->|:80| G[gateway<br/>nginx]
  G -->|/| F[frontend<br/>React + nginx]
  G -->|/api/*| A[api<br/>Node / Fastify]
  G -->|/cf-*/ presigned| M[(MinIO<br/>S3 API)]
  A -->|HTTP| P[price-service<br/>FastAPI]
  P -->|cache + last-known-good| R[(Redis)]
  P -->|HTTPS| CG[CoinGecko / mock]
  A -->|SQL| PG[(Postgres)]
  A -->|XADD jobs, rate limit| R
  A -->|sign URLs, HeadBucket| M
  W[worker<br/>Python] -->|XREADGROUP jobs| R
  W -->|SQL| PG
  W -->|put/get objects| M
  W -->|HTTP| P
  MG[migrate - one-off] -->|DDL + seed| PG
  MI[minio-init - one-off] -->|mc mb| M
```

Networks: `edge` = gateway, frontend, api, minio. `backend` = api, price-service, worker, postgres, redis, minio.
Only the gateway publishes a port.

## Request flows

**Login.** `POST /api/auth/login` → api checks the Redis rate limit (`ratelimit:login:<ip>`) and bcrypt-verifies the password.
It returns a 15-minute JWT access token in the body and a 7-day refresh token as an httpOnly cookie (`path=/api/auth`).
The SPA keeps the access token in memory. On a 401 it calls `POST /api/auth/refresh` once and retries.

**Holdings.** `GET /api/portfolios/:id/holdings` → api loads the transactions from Postgres. It asks the price-service
for `/prices?ids=…`, which answers from Redis (`cache:price:<id>`, 60 s), from the provider, or from
`lkg:price:<id>` with `stale: true` when the provider is down. The api then computes average-cost P/L.
If the price-service is unreachable, the api still answers with `valueUsd: null` and `stale: true`.

**Background job (export/import/report).**
1. `POST /api/jobs` → the api inserts `jobs(status=queued)` and runs `XADD jobs * job_id <id>`.
2. A worker `XREADGROUP`s it, sets `status=running`, runs the handler and writes the object to `cf-exports/<user>/<job>.csv|pdf`.
3. The worker stores `result_key` and `XACK`s the message.
4. Retry rules: transient errors re-queue the job (max 3 attempts); bad input fails it immediately; messages from dead workers are reclaimed with `XAUTOCLAIM`.
5. The SPA polls `GET /api/jobs` and gets a presigned download URL when the job is done.

**Upload (avatar / CSV import).** SPA → `POST /api/me/avatar/upload-url` (or `/api/uploads/import-url`) → the api
signs a PUT URL for `http://<public host>/<bucket>/<userId>/<uuid>` (15 min). The browser PUTs the file through
the gateway straight to MinIO, then tells the api the object key. The key must start with the caller's user id.

**Price alerts.** The worker scheduler runs every 60 s. It loads active alerts, fetches their prices, and for each match
it atomically sets `active=false` (safe with many workers) and inserts a notification. The SPA polls notifications every 30 s.

**Snapshots.** Every hour at :00 (and at worker start) the worker upserts `portfolio_snapshots(portfolio, today)` with
Σ quantity × price. The dashboard's 30-day chart reads these rows.

## Cross-cutting conventions

| Concern | Convention |
|---------|------------|
| Config | env vars only (`.env.example`); fail fast on missing values |
| Health | `healthz` = process alive (no dependency checks); `readyz` = dependencies OK (503 otherwise) |
| Metrics | Prometheus text at `/metrics` (api: `:3000/metrics`, price-service: `:8000/metrics`, worker: `:9100/metrics`) |
| Logs | one JSON object per line on stdout, including `service` and the request id (`x-request-id`, minted by the gateway) |
| Containers | multi-stage builds, `test` stage per service, non-root users, graceful SIGTERM |
| Data | migrations are forward-only SQL in `services/api/migrations`, applied by the `migrate` job with an advisory lock |
````

- [ ] **Step 4: Per-service docs**

`docs/services/gateway.md`
```markdown
# gateway

nginx (unprivileged image, listens on 8080; compose publishes `${GATEWAY_PORT}`). Config: `gateway/templates/default.conf.template`, rendered at start with `envsubst` (only the `S3_BUCKET_*` variables).

| Path | Upstream | Notes |
|------|----------|-------|
| `/gateway/healthz` | - | liveness |
| `/api/*` | `api:3000` | path unchanged |
| `/cf-avatars/*`, `/cf-imports/*`, `/cf-exports/*` | `minio:9000` | path **and** Host unchanged (both are signed in presigned URLs); request/response buffering off |
| `/*` | `frontend:8080` | SPA |

Adds/propagates `X-Request-ID`, logs JSON to stdout, gzip, 10 MB body limit. Uses Docker DNS (`resolver 127.0.0.11`) so restarted containers are re-resolved. `/metrics` of the api is intentionally not routed.

Env: `S3_BUCKET_AVATARS`, `S3_BUCKET_IMPORTS`, `S3_BUCKET_EXPORTS`.
```

`docs/services/frontend.md`
```markdown
# frontend

React 18 + Vite + TypeScript, TanStack Query, React Router, Recharts, Tailwind 4. Built into static files served by nginx-unprivileged on 8080 (`/healthz`).

- **Runtime config:** `docker-entrypoint.d/40-runtime-config.sh` writes `/config.js` from `APP_ENV` and `API_BASE_URL` at start. One image serves every environment.
- **Auth:** access token in memory, refresh via httpOnly cookie; `src/lib/api.ts` retries once after a single-flight refresh.
- **Uploads:** presigned PUT straight to object storage (`src/lib/upload.ts`).
- Dev: `npm run dev` (Vite on :5173, proxies `/api` to the gateway on :80).
- Tests: `npm run lint && npm test` (Vitest: API client + formatters). CI: `docker build --target test services/frontend`.

Env: `APP_ENV`, `API_BASE_URL` (default `/api`).
```

`docs/services/api.md`
```markdown
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
```

`docs/services/price-service.md`
```markdown
# price-service

Python 3.12 + FastAPI, internal only (port 8000). Providers: `mock` (deterministic sine-wave prices for 20 coins, works offline) and `coingecko` (real data, `COINGECKO_API_KEY` optional).

| Endpoint | Response |
|----------|----------|
| `GET /coins` | top coins with price, 24h change, market cap |
| `GET /prices?ids=a,b` | `{"prices":{"a":{"usd","change_24h"}},"stale"}` (1-100 ids) |
| `GET /history/{id}?days=1\|7\|30\|365` | `{"points":[[ts_ms, price]],"stale"}` |
| `GET /healthz`, `/readyz` (Redis), `/metrics` | |

Caching: Redis `cache:*` keys with TTL (prices 60 s, coins 1 h, history 10 min) plus `lkg:*` keys without TTL. When the provider fails, the last known good value is returned with `"stale": true`. With nothing cached it returns 503. Metrics: `price_cache_events_total{outcome=hit|miss|stale}`, `price_upstream_errors_total`, `http_request_duration_seconds`.

Env: `PRICE_PROVIDER`, `COINGECKO_BASE_URL`, `COINGECKO_API_KEY`, `REDIS_URL`, `LOG_LEVEL`.
Tests: `docker build --target test services/price-service && docker run --rm <image>`.
```

`docs/services/worker.md`
```markdown
# worker

Python 3.12. No public API; a small HTTP server on 9100 serves `/healthz` (the consumer loop is alive), `/readyz` (postgres, redis, storage) and `/metrics`.

**Jobs:** Redis Stream `jobs`, consumer group `workers`, consumer name = container hostname, so scaling with `--scale worker=N` just works.

| Job | Input (`jobs.params`) | Output |
|-----|-----------------------|--------|
| `export_csv` | `portfolioId` | `cf-exports/<user>/<job>.csv`, `result.filename`, `result.rows` |
| `import_csv` | `portfolioId`, `key` (in `cf-imports`) | rows inserted in one DB transaction; `result.imported` |
| `report_pdf` | `portfolioId` | `cf-exports/<user>/<job>.pdf`, `result.filename` |

Retry rules: bad input (`PermanentJobError`: bad CSV, unknown coin, oversell, missing file) → `failed` immediately. Any other error → re-queued until 3 attempts. Messages pending for more than 60 s on a dead consumer are reclaimed with `XAUTOCLAIM`.

CSV format: `date,type,coin_id,quantity,price_usd,fee_usd,note` (ISO dates; naive = UTC; max 5000 rows).

**Scheduler (APScheduler, UTC):**
- `check_alerts` runs every `ALERT_CHECK_INTERVAL_SECONDS`. Each alert fires once and creates a notification.
- `take_snapshots` runs hourly at :00 and at start. It upserts today's value per portfolio and skips portfolios with a missing price.

Metrics: `worker_jobs_total{type,outcome}`, `worker_job_duration_seconds`, `worker_alerts_triggered_total`, `worker_snapshots_written_total`, `worker_scheduled_task_failures_total`.

Env: `DATABASE_URL`, `REDIS_URL`, `PRICE_SERVICE_URL`, `S3_*`, `JOBS_STREAM`, `JOBS_GROUP`, `WORKER_NAME`, `MAX_ATTEMPTS`, `ALERT_CHECK_INTERVAL_SECONDS`, `HEALTH_PORT`, `LOG_LEVEL`.
Tests: unit tests run by default; integration tests need `INTEGRATION=1` and `docker-compose.test.yml` (see `scripts/test.sh`).
```

- [ ] **Step 5: Full verification from a clean slate**

Run:
```bash
make clean && cp .env.example .env && make up && sleep 40 && make ps
make smoke
make test
```
Expected:
- Every long-running service is `healthy`; `migrate` and `minio-init` are `Exited (0)`.
- `make smoke` prints ✔ for every step and ends with `Smoke test passed ✅`.
- `make test` ends with `all tests passed`.

Then check the rest manually:
1. **Browser walk-through:** go to http://localhost as demo. Check the dashboard, a portfolio, add and delete a transaction, markets, a coin chart, a star, an alert, the bell, avatar, export/import/report.
2. **Real prices:** set `PRICE_PROVIDER=coingecko` in `.env`, run `docker compose up -d price-service`, and confirm Markets shows real coins with images.
3. **Stale fallback:** set `COINGECKO_BASE_URL=http://invalid.invalid`, run `docker compose up -d price-service`, and wait 60 s (cache TTL). Markets and portfolios show the **stale prices** badge and nothing crashes. Set `PRICE_PROVIDER=mock` again afterwards.
4. **Reproducibility:** `docker compose down -v && docker compose up -d` gives a clean, re-seeded stack.
5. **Only one published port:** `docker compose ps --format '{{.Name}} {{.Ports}}'` shows a host port only on `gateway`.

- [ ] **Step 6: Commit**

```bash
git add README.md docs scripts/smoke.mjs Makefile
git commit -m "docs: README, architecture and service docs; end-to-end smoke test"
```
