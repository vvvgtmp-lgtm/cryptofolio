# price-service

Python 3.12 + FastAPI, internal only (port 8000). Providers (`PRICE_PROVIDER`):

| Provider | Data | Key | Limits |
|----------|------|-----|--------|
| `mock` (default) | 20 coins, deterministic sine-wave prices, fully offline | none | none |
| `binance` | the same 20 coins with real prices from `data-api.binance.vision` (USDT pairs; market cap = price x circulating supply; no logos) | none | generous per-minute weight limit, no monthly quota |
| `coingecko` | top 100 coins with logos | optional free Demo key (`COINGECKO_API_KEY`) | keyless ~5-15 calls/min; Demo key 100/min, 10k/month |

Coin ids are the same for `mock` and `binance` (CoinGecko naming), so data created under one provider keeps working under another.

| Endpoint | Response |
|----------|----------|
| `GET /coins` | top coins with price, 24h change, market cap |
| `GET /prices?ids=a,b` | `{"prices":{"a":{"usd","change_24h"}},"stale"}` (1-100 ids) |
| `GET /history/{id}?days=1\|7\|30\|365` | `{"points":[[ts_ms, price]],"stale"}` |
| `GET /healthz`, `/readyz` (Redis), `/metrics` | |

Caching: Redis `cache:*` keys with TTL (prices 60 s, coins 1 h, history 10 min) plus `lkg:*` keys without TTL. When the provider fails, the last known good value is returned with `"stale": true`. With nothing cached it returns 503. Metrics: `price_cache_events_total{outcome=hit|miss|stale}`, `price_upstream_errors_total`, `http_request_duration_seconds`.

Env: `PRICE_PROVIDER`, `BINANCE_BASE_URL`, `COINGECKO_BASE_URL`, `COINGECKO_API_KEY`, `REDIS_URL`, `LOG_LEVEL`.
Tests: `docker build --target test services/price-service && docker run --rm <image>`.
