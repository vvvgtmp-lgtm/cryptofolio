# Acceptance test

A black-box test of any CryptoFolio build against the interface contract in
`../business-requirements.md` §7. It only talks to the gateway over HTTP, so it works whatever
languages the build uses.

## Run
```bash
# the build under test must be running (docker compose up -d) and healthy
node acceptance.mjs                            # default BASE_URL=http://localhost
BASE_URL=http://localhost:8080 node acceptance.mjs
```
- Needs Node ≥ 18.14; no dependencies.
- Takes about 1–3 minutes. The alert check waits for the worker's scheduler (up to 150 s,
  `ALERT_TIMEOUT_MS`).
- Exit code: 0 = all passed, 1 = some failed, 2 = gateway unreachable.
- The last line is `RESULT_JSON {...}`, with per-group counts and failure messages for scoring
  scripts.

## Notes
- The script creates fresh users (`*@acceptance.test`) on every run, so it is safe to rerun.
- Registration and login are rate limited per IP (~10/min). If a previous run used up the budget, the
  script waits about 65 s once. The rate-limit checks run last on purpose.
- Some checks accept either of two status codes where the contract allows it, e.g. duplicate
  registration 409 or 429 when rate limited.
- Reference result (this repository, 2026-09-28): **36/36**.
