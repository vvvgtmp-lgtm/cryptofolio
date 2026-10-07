# CryptoFolio: session handoff

> Written 2026-09-28 at the end of the first build session. Read this first when you (or an AI
> assistant) continue the project. Everything below is also in git history; this file is the map.

## 1. What this project is
**CryptoFolio** is a crypto portfolio tracker built as a **teaching vehicle for a DevOps course**
(infra provisioning, containers, CI/CD, later deployment to **GCP**).

It is a polyglot, microservice, 3-tier app that starts with one `docker compose up`:

| Service | Stack | Role |
|---|---|---|
| gateway | nginx (unprivileged) | the only published port (80). Routes `/` → frontend, `/api/` → api, `/cf-*` buckets → MinIO (pre-signed URLs). Adds CSP on stored files |
| frontend | React 18 + Vite + TS + Tailwind 4, served by nginx | SPA. Runtime config via `/config.js` generated at container start |
| api | Node 22 + TypeScript, Fastify 5, Kysely/pg, ioredis | auth, portfolios, P/L, watchlist, alerts, notifications, pre-signed URLs, job API |
| price-service | Python 3.12, FastAPI | market data. Providers: `mock` (offline), `binance` (free, no key), `coingecko`. Redis cache + last-known-good |
| worker | Python 3.12 | Redis Streams consumer (CSV export/import, PDF report) + APScheduler (price alerts every 60 s, hourly snapshots) |
| postgres 16 / redis 7 / MinIO (`pgsty/minio`) | infra | data, cache/queue/rate limits, object storage |
| migrate / minio-init | one-off | SQL migrations + demo seed / bucket creation |

Demo login: **demo@cryptofolio.local / demo1234** at http://localhost

## 2. Current state (end of session)
- **Branch:** `feature/cryptofolio` (**not merged**). `main` has only the spec and plan commits
  (`c940f9f`, `fa74ac3`). The feature branch has 28 more commits, ending at `d451d1d`.
- **No git remote is configured.**
- **Working tree:** clean.
- **Tests:** `make test` is green (price-service 57, api 32 unit + 56 integration, worker 50 incl.
  integration, frontend 12). `make smoke` is green. `docs/benchmark/acceptance/acceptance.mjs`
  passes 36/36.
- **Local `.env`:** `PRICE_PROVIDER=binance` (real prices). `.env.example` keeps `mock` as the
  default.
- **Docker:** the stack was running and healthy at handoff. It was stopped from outside the session
  twice today (probably the Docker Desktop UI); `make up` restarts it with data intact.

## 3. How to run
```bash
cp .env.example .env        # first time only
make up                     # build + start everything  (http://localhost)
make ps | make logs s=api   # status / follow one service
make test                   # every service's lint+unit+integration tests in containers
make smoke                  # end-to-end smoke test through the gateway (needs Node >= 18)
make down | make clean      # stop | stop and delete all data
node docs/benchmark/acceptance/acceptance.mjs   # contract acceptance test (36 checks)
```
- **Real prices:** set `PRICE_PROVIDER=binance` in `.env`, then `docker compose up -d price-service`.
- **Port 80 busy:** set `GATEWAY_PORT=8080` **and** `S3_PUBLIC_ENDPOINT=http://localhost:8080`.

## 4. Where things are
| Path | Content |
|---|---|
| `docs/superpowers/specs/2026-09-28-cryptofolio-design.md` | approved design spec |
| `docs/superpowers/plans/2026-09-28-cryptofolio.md` | the original 21-task implementation plan (with full code) |
| `README.md`, `docs/architecture.md`, `docs/services/*.md` | user docs: quick start, flows, per-service API/env/metrics |
| `docs/benchmark/` | model-benchmark kit (see §7) |
| `docker-compose.yml` / `docker-compose.test.yml` | dev stack / throw-away test infra + test runners |
| `scripts/test.sh`, `scripts/smoke.mjs` | CI-style test runner / smoke test |
| `services/api/migrations/*.sql` | DB schema (node-pg-migrate). Add new timestamped files; never edit applied ones |
| `services/api/src/routes/*.ts` | REST API; `src/lib/` has holdings math, storage, queue, tokens, validation |
| `services/price-service/app/providers/` | `catalogue.py` (20 coins), `mock.py`, `binance.py`, `coingecko.py` |
| `services/worker/worker/` | `consumer.py`, `jobs.py`, `csv_io.py`, `report.py`, `scheduled.py`, `health.py` |

## 5. What happened in this session (chronological)
1. **Requirements and design.** Brainstormed with the instructor. Chose a polyglot stack (Node api,
   Python price-service/worker, React), 4 services + gateway, CoinGecko + mock, all feature groups,
   a monorepo, a reverse proxy, unit + integration tests, and "app + compose only" (CI/CD and
   Terraform are left for lessons). The spec and a 21-task plan were written and committed on `main`.
2. **Implementation.** Built inline, task by task, test-first, on `feature/cryptofolio` (Tasks 1–21,
   one commit or more per task).
3. **Headless UI walk-through** (Playwright in Docker, since the Chrome extension wasn't used): 13/13
   flows. This fixed an allocation legend that overflowed on wide screens and turned off chart
   animations.
4. **Final code review** by a fresh reviewer: 2 critical + 6 important issues, all fixed test-first:
   - **C1: stored XSS through avatar upload.** Pre-signed PUTs now sign the Content-Type (images /
     `text/csv` only), and the gateway adds CSP `sandbox` + `nosniff` on storage responses.
   - **C2: concurrent sells could oversell.** Transaction create/delete run in a DB transaction under
     a `SELECT … FOR UPDATE` portfolio lock (the same lock the worker's CSV import uses).
   - **I1: rate limit bypass via X-Forwarded-For.** `TRUST_PROXY_HOPS` (default 1).
   - **I2:** registration rate limit.
   - **I3:** JWT secrets ≥ 32 chars; example/equal secrets are refused when `APP_ENV != local`.
   - **I4:** refresh tokens are single-use (rotated) and revoked on logout (Redis `refresh:<jti>`).
   - **I5/I6:** numeric bounds in the api and in CSV import (row-specific errors, no pointless
     retries).
5. **Claude Code `/doctor` cleanup** (user-level, outside the repo):
   - 11 unused plugins disabled in `~/.claude/settings.json`;
   - `permissions.defaultMode` set to `auto`;
   - backup at `~/.claude/settings.json.bak-doctor`.
6. **Real prices.** CoinGecko's keyless API is rate limited (5–15 calls/min) and a higher limit needs
   a Demo key. Researched free alternatives (CoinPaprika: 20k calls/month, personal use only;
   CoinLore; Binance). Added the **Binance provider**: no key, no quota, same coin ids as mock,
   market cap = price × supply. Price cache keys are now **namespaced per provider**.
7. **Benchmark kit** (`docs/benchmark/`) so another model can rebuild the app in 2 rounds (§7).

## 6. Decisions and rulings to remember
| Decision | Why |
|---|---|
| MinIO via **`pgsty/minio`** (server + `mc`) | official `minio/minio` / `minio/mc` images can no longer be pulled |
| Buckets served at `/<bucket>/…` through the gateway, Host and path untouched | SigV4 pre-signed URLs sign the host and path; rewriting a `/storage/` prefix would break them |
| Test compose always runs with `-p cryptofolio-test`; `COMPOSE_PROJECT_NAME` is commented out in `.env.example` | a project name in `.env` overrides `name:` and made the test infra replace the dev stack |
| AWS SDK / boto3 checksum calculation = "when required" | newer SDKs add CRC32 params to pre-signed PUTs that browsers can't satisfy |
| All `proxy_set_header` at nginx server level; storage location repeats `X-Request-ID` | nginx does not inherit header directives into locations that define their own |
| `mock` stays the default price provider | offline and deterministic for classrooms; `binance` is opt-in |
| ruff ignores E501; frontend pins ESLint 9; api uses `import { Decimal }` | toolchain compatibility (see ledger notes in commits) |
| Compact USD formatting sets `minimumFractionDigits: 0` | alpine ICU in containers formats differently from desktop Node |
| Snapshots are upserted hourly (not only daily) | keeps today's chart point current |
| Only rotation + revoke-on-logout for refresh tokens (no token-family reuse detection) | simplicity. Side effect: two tabs refreshing at the same instant can log one out |
| api/worker use the MinIO root credentials | simplicity; a scoped user/policy is a good IAM lesson |

## 7. Benchmark kit (`docs/benchmark/`)
- `business-requirements.md`: **Round 1** input. Tech-agnostic requirements plus a normative
  interface contract (§7).
- `execution-plan.md`: **Round 2** input. Task-level plan with no source code, plus known pitfalls.
- `evaluation.md`: **private**. Protocol, prompts to paste as-is, 100-point rubric, traceability, and
  scorecard (reference = 100).
- `acceptance/acceptance.mjs`: black-box contract test (`BASE_URL=… node acceptance.mjs`). The
  reference build scores 36/36.
- To run a round: an **empty** directory containing only the allowed files; don't open this repo in
  that session.

## 8. Open items / next steps
1. **Decide the branch:** merge `feature/cryptofolio` into `main` locally, or add a remote (e.g.
   GitHub) and open a PR.
2. **Run the benchmark** rounds and fill in `docs/benchmark/evaluation.md` §5.
3. **Course material still to build** (out of scope so far; this is where the lessons go):
   - CI pipelines per service: path filters, each Dockerfile's `test` target, push images tagged
     `IMAGE_REGISTRY/IMAGE_TAG`;
   - Terraform for GCP: Cloud Run or GKE, Cloud SQL, Memorystore, GCS with HMAC keys for S3
     interop, Artifact Registry, secrets;
   - CD with `migrate` as a Cloud Run Job / K8s Job, and the smoke/acceptance test as a post-deploy
     check;
   - on GCP set `COOKIE_SECURE=true`, strong JWT secrets, `TRUST_PROXY_HOPS=2` (LB + gateway), and
     `S3_PUBLIC_ENDPOINT` = public URL.
4. **Deferred minor findings** (known, not fixed):
   - user enumeration: 409 on register, and a login timing difference;
   - gateway access log contains pre-signed URL signatures;
   - `executedAt: null` is coerced to 1970-01-01;
   - the worker ACKs a message even if the DB update around the handler fails (job stuck
     queued/running); a very long job can be reclaimed while still running;
   - rate limiter `INCR`+`EXPIRE` is not atomic;
   - public market endpoints + random ids can burn the CoinGecko quota (no negative cache);
   - watchlist has no degraded mode when the price service is down;
   - `COOKIE_SECURE` defaults to false.
5. **Environment notes:**
   - `uv` isn't installed, so the aws-core plugin's MCP server fails (`brew install uv` if you need
     it);
   - Claude Code auto-updates are off (`autoUpdates: false`); run `claude update` occasionally.

## 9. Tips for continuing with an AI assistant
- Point it at this file and at `docs/architecture.md` first. The design spec and original plan are in
  `docs/superpowers/`.
- Ask it to run `make test` and `make smoke` before and after any change. The acceptance script is a
  good regression gate for API changes.
- Keep the conventions: config only via env (document every variable in `.env.example`), health,
  readiness and metrics per service, JSON logs with request id, non-root multi-stage images with a
  `test` stage, and tests written first.
