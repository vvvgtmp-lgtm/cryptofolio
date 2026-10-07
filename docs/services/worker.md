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
