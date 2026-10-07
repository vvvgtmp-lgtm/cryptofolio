# CryptoFolio benchmark: evaluation kit (private: do not give to the model)

## 1. Protocol

### Setup (identical for every run)
- Same machine, same Docker version, and an **empty** directory with `git init` and no history.
- Don't open this repository in the model's session; it must not see the reference code.
- Record the model name/version, date, and any tool or plugin configuration (skills, agents, MCP).
- Pick a time box (e.g. 6 hours of agent time) and an interaction policy, and apply both the same way
  to every round. Suggested policy: answer clarifying questions, approve permission prompts, but give
  **no technical hints**. Count every human message after the initial prompt.

### Round 1: requirements only
Copy only `business-requirements.md` into the empty directory. Prompt, verbatim:

> You are building the application described in `business-requirements.md` in this empty repository.
> Read it completely, ask me any clarifying questions you need, then design and implement the whole
> system until its Definition of Done (section 8) is met. Work autonomously, commit as you go, and
> tell me when you are done and how to run it.

### Round 2: requirements + execution plan
Copy `business-requirements.md` **and** `execution-plan.md` into a new empty directory. Prompt, verbatim:

> You are building the application described in `business-requirements.md` in this empty repository,
> following `execution-plan.md` task by task (T1 to T21), test-first as the plan describes. Deviate
> from the plan only when something in it cannot work, and tell me each time. Work autonomously,
> commit per task, and tell me when you are done and how to run it.

### What to record per run
| Metric | How |
|---|---|
| Wall-clock time to "done" | start/end timestamps |
| Tokens / cost | from the tool's usage report (e.g. `/cost`, `/context`) |
| Human interventions | count of your messages after the initial prompt (answers, approvals, corrections) |
| Clarifying questions asked | count |
| Commits | `git log --oneline \| wc -l` |
| Self-reported vs actual | did it claim "done" while something failed? (yes/no + what) |

## 2. How to score a finished build
1. In the build's directory: `cp .env.example .env`, then `docker compose up -d --build` and wait until
   healthy (≤ 2 min).
2. `node <path>/docs/benchmark/acceptance/acceptance.mjs` gives the pass count and a `RESULT_JSON`
   line. If the app uses another port: `BASE_URL=http://localhost:8080 node acceptance.mjs`.
3. Run the build's own `make test` and `make smoke` (or their documented equivalents).
4. Walk through the manual checklists below.
5. Fill in the scorecard (section 5).

## 3. Rubric (100 points)

### A. Automated acceptance: 40 pts
`40 × passed / total` from `acceptance.mjs` (36 checks). If the stack does not start from
`docker compose up`, A = 0.

### B. Security: 15 pts (partly covered by acceptance; verify here)
| # | Check | Pass condition | Pts |
|---|---|---|---|
| B1 | Concurrent oversell safe | acceptance "concurrent sells…" passes | 3 |
| B2 | Uploads cannot run as pages | acceptance "avatar…" passes (type enforced **and** CSP header) | 3 |
| B3 | Rate limits spoof-proof | acceptance "login rate limit…X-Forwarded-For" + "registration is rate limited" pass | 2 |
| B4 | Sessions revocable | acceptance "refresh…replayed" + "logout revokes" pass | 2 |
| B5 | Data isolation | acceptance "isolation" + the other-user checks in watchlist/alerts/jobs pass | 2 |
| B6 | Secret hygiene | starting the api with `APP_ENV=production` and the example secrets **fails** with a clear message; secrets ≥ 32 chars | 2 |
| B7 | Passwords | slow hash (bcrypt/argon2/scrypt) visible in code; no plaintext or unsalted hash | 1 |

### C. DevOps readiness: 15 pts
| # | Check | Pass condition | Pts |
|---|---|---|---|
| C1 | One command | `docker compose up -d --build` from a clean clone → all healthy, one-off containers exit 0 | 2 |
| C2 | Only gateway port | `docker compose ps --format '{{.Name}} {{.Ports}}'` shows a host mapping only on the gateway | 1 |
| C3 | Health/readiness | every long-running service has liveness + readiness; stopping Redis makes the api's readiness fail | 2 |
| C4 | Metrics | `/metrics` in Prometheus format on every service internally, not public | 2 |
| C5 | Logs | JSON on stdout; a request id sent as `x-request-id` appears in gateway **and** api logs | 2 |
| C6 | Images | multi-stage, non-root (`docker compose exec <svc> id -u` ≠ 0 for every app service), a test stage per service | 2 |
| C7 | Config | `.env.example` documents every variable; no hard-coded hosts/secrets/bucket names (grep) | 2 |
| C8 | Runtime frontend config | changing `APP_ENV` + restarting only the frontend changes the env badge, no rebuild | 1 |
| C9 | Worker scaling | `--scale worker=2` → 2 consumers; jobs still processed once | 1 |

### D. Tests: 10 pts
| # | Check | Pts |
|---|---|---|
| D1 | `make test` (or documented equivalent) runs all services' tests in containers and is green | 4 |
| D2 | It does not touch or replace the running dev stack, and cleans up | 2 |
| D3 | Integration tests against real Postgres/Redis/object storage exist for api **and** worker | 2 |
| D4 | Tests are meaningful: P/L math, oversell, CSV errors, provider fallback covered (spot-check) | 2 |

### E. Architecture and code quality: 10 pts
| # | Check | Pts |
|---|---|---|
| E1 | Required services separated; ≥ 2 languages; Redis used as cache **and** queue **and** rate-limit store | 3 |
| E2 | Browser uploads/downloads go directly to storage via pre-signed URLs (no file bytes through the api) | 2 |
| E3 | Price providers: offline default + key-less real provider + stale fallback (stop the price service → pages still load) | 3 |
| E4 | Code readability / structure (reviewer judgement: 0 = tangled, 2 = clean and consistent) | 2 |

### F. Documentation: 5 pts
README quick start (1), architecture diagram + service table (1), infra component → GCP mapping (1),
configuration table (1), "things to try in class" (1).

### G. UX walk-through: 5 pts
Log in as demo, then check each page; 0.5 per item, max 5:
- dashboard with charts;
- portfolio detail with add/delete transaction;
- an oversell error shown in the dialog;
- markets search;
- coin chart with 4 ranges;
- watchlist;
- alert → bell notification;
- CSV export download;
- CSV import;
- avatar upload.

Also check phone width (390 px) is usable.

## 4. Requirement → check traceability
| Requirement (business-requirements.md) | Covered by |
|---|---|
| 2.1 accounts, sessions, avatar, demo | acceptance: demo, auth, uploads; G |
| 2.2 portfolios | acceptance: portfolio CRUD |
| 2.3 transactions, avg-cost, no oversell (back-dated, concurrent, deletion), bounds | acceptance: portfolio group; B1 |
| 2.4 dashboard + snapshots | acceptance: demo, snapshots/dashboard shapes; G |
| 2.5 markets + history | acceptance: market group; G |
| 2.6 watchlist | acceptance: watchlist |
| 2.7 alerts + notifications | acceptance: alerts group |
| 2.8 jobs: export/import/report, row errors, atomic | acceptance: jobs group |
| 2.9 providers, stale, namespacing | E3 (manual: `PRICE_PROVIDER` switch + stop price service) |
| 3 architecture constraints | C1, C2, E1, E2 |
| 4.1 operations | C3–C8 |
| 4.2 security | B1–B7 |
| 4.3 quality + docs | D, F |
| 5 UX | G |

## 5. Scorecard

| Area | Max | Reference (Opus 5.5, this repo) | Round 1 | Round 2 |
|---|---|---|---|---|
| A. Acceptance | 40 | 40 (36/36) | | |
| B. Security | 15 | 15 | | |
| C. DevOps readiness | 15 | 15 | | |
| D. Tests | 10 | 10 | | |
| E. Architecture/code | 10 | 10 | | |
| F. Docs | 5 | 5 | | |
| G. UX | 5 | 5 | | |
| **Total** | **100** | **100** | | |
| Time / tokens / interventions | | ~1 working day; two interactive sessions; see note | | |

The reference build is the definition of the target, so it scores 100 by construction. Its history
is still worth comparing against:
- It needed a **final review pass that found 2 critical + 6 important issues**, fixed before scoring:
  - stored XSS through uploads;
  - a concurrent-oversell race;
  - spoofable rate limits;
  - non-revocable refresh tokens;
  - weak secrets allowed;
  - unbounded numbers;
  - CSV overflow retries.
- It also hit these environment problems:
  - MinIO images discontinued;
  - the compose project name clobbering the dev stack;
  - container ICU formatting;
  - a price cache that wasn't namespaced by provider.

When comparing, also note which of these the other model avoided unaided in Round 1.
