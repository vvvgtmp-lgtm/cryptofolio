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
