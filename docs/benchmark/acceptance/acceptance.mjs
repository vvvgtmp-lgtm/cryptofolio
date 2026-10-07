#!/usr/bin/env node
// CryptoFolio black-box acceptance test.
// Talks ONLY to the gateway, using the interface contract in business-requirements.md §7.
// Usage: BASE_URL=http://localhost node acceptance.mjs      (Node >= 18.14, no dependencies)
// Exit code 0 = every check passed. The last line is machine-readable: RESULT_JSON {...}

const BASE = (process.env.BASE_URL ?? 'http://localhost').replace(/\/$/, '');
const ALERT_TIMEOUT_MS = Number(process.env.ALERT_TIMEOUT_MS ?? 150_000);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 60_000);
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const RUN = Date.now().toString(36);

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(group, name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ group, name, pass: true });
    console.log(`PASS  [${group}] ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    results.push({ group, name, pass: false, error: String(err?.message ?? err) });
    console.log(`FAIL  [${group}] ${name}: ${err?.message ?? err}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function cookieFrom(res) {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  const refresh = all.find((c) => /httponly/i.test(c) && /=[^;]+/.test(c.split(';')[0]));
  return refresh ? { raw: refresh, pair: refresh.split(';')[0] } : null;
}

async function api(method, path, { token, body, headers = {}, cookie } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  if (cookie) h.cookie = cookie;
  const res = await fetch(`${BASE}/api${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, res };
}

function expectStatus(r, expected, what) {
  const list = Array.isArray(expected) ? expected : [expected];
  assert(list.includes(r.status), `${what}: expected HTTP ${list.join('/')}, got ${r.status} ${r.text.slice(0, 200)}`);
}

// Registration/login are rate limited (~10/min/IP). If a previous run used the budget, wait once.
async function withRateLimitRetry(fn) {
  let r = await fn();
  if (r.status === 429) {
    console.log('      (rate limited by a previous run - waiting 65 s)');
    await sleep(65_000);
    r = await fn();
  }
  return r;
}

async function register(label) {
  const email = `${label}-${RUN}@acceptance.test`;
  const r = await withRateLimitRetry(() => api('POST', '/auth/register', { body: { email, password: 'acceptance-pw-1', displayName: label } }));
  expectStatus(r, 201, `register ${label}`);
  return { email, token: r.json.accessToken, user: r.json.user, cookie: cookieFrom(r.res) };
}

async function waitFor(what, timeoutMs, fn, intervalMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

async function runJob(token, type, params, { expectFailure = false } = {}) {
  const created = await api('POST', '/jobs', { token, body: { type, params } });
  expectStatus(created, 202, `create ${type} job`);
  return waitFor(`${type} job`, JOB_TIMEOUT_MS, async () => {
    const r = await api('GET', `/jobs/${created.json.id}`, { token });
    if (r.json?.status === 'failed' && !expectFailure) throw new Error(`${type} job failed: ${r.json.error}`);
    if (r.json?.status === 'done' && expectFailure) throw new Error(`${type} job succeeded but should have failed`);
    return ['done', 'failed'].includes(r.json?.status) && r.json;
  });
}

const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const REQUIRED_COINS = ['bitcoin', 'ethereum', 'tether', 'binancecoin', 'solana', 'ripple', 'usd-coin', 'cardano', 'dogecoin', 'tron', 'avalanche-2', 'polkadot', 'chainlink', 'litecoin', 'near', 'uniswap', 'stellar', 'cosmos', 'monero', 'aptos'];

// ---------------------------------------------------------------- preflight
try {
  await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
} catch (err) {
  console.error(`Cannot reach ${BASE} (${err?.cause?.code ?? err?.message}). Start the stack first (docker compose up -d).`);
  console.log(`RESULT_JSON ${JSON.stringify({ base: BASE, passed: 0, total: 0, error: 'unreachable' })}`);
  process.exit(2);
}

// ---------------------------------------------------------------- health
await check('health', 'gateway serves the web app at /', async () => {
  const r = await fetch(`${BASE}/`);
  assert(r.ok && /html/i.test(r.headers.get('content-type') ?? ''), `GET / -> ${r.status} ${r.headers.get('content-type')}`);
});
await check('health', 'api liveness and readiness', async () => {
  const live = await api('GET', '/healthz');
  expectStatus(live, 200, 'healthz');
  assert(live.json?.status === 'ok', 'healthz body');
  const ready = await api('GET', '/readyz');
  expectStatus(ready, 200, 'readyz');
  assert(ready.json?.status === 'ready' && typeof ready.json.checks === 'object', 'readyz body');
});
await check('health', 'Prometheus metrics are not exposed publicly', async () => {
  for (const path of ['/metrics', '/api/metrics']) {
    const r = await fetch(`${BASE}${path}`);
    const text = await r.text();
    assert(!(r.ok && /# (HELP|TYPE) /.test(text)), `${path} exposes Prometheus metrics`);
  }
});

// ---------------------------------------------------------------- demo data
let demoToken;
await check('demo', 'demo account logs in and has a populated dashboard', async () => {
  const r = await withRateLimitRetry(() => api('POST', '/auth/login', { body: { email: 'demo@cryptofolio.local', password: 'demo1234' } }));
  expectStatus(r, 200, 'demo login');
  demoToken = r.json.accessToken;
  const d = await api('GET', '/dashboard', { token: demoToken });
  expectStatus(d, 200, 'dashboard');
  assert(d.json.totals.valueUsd > 0, 'dashboard value > 0');
  assert(Array.isArray(d.json.portfolios) && d.json.portfolios.length >= 2, 'at least 2 demo portfolios');
  assert(Array.isArray(d.json.history) && d.json.history.length >= 20, `30-day history (${d.json.history?.length} points)`);
});

// ---------------------------------------------------------------- auth
let alice;
let bob;
await check('auth', 'register returns token, user and an httpOnly refresh cookie', async () => {
  alice = await register('alice');
  assert(alice.token && alice.user?.id && alice.user.email === alice.email, 'register body');
  assert(alice.cookie, 'httpOnly refresh cookie set');
  assert(/samesite/i.test(alice.cookie.raw), 'cookie has SameSite');
  bob = await register('bob');
});
await check('auth', 'email is case-insensitive and duplicates are rejected with 409', async () => {
  const r = await api('POST', '/auth/register', { body: { email: `  ${alice.email.toUpperCase()} `, password: 'acceptance-pw-1', displayName: 'dup' } });
  expectStatus(r, [409, 429], 'duplicate register');
});
await check('auth', 'short password is a validation error', async () => {
  const r = await api('POST', '/auth/register', { body: { email: `short-${RUN}@acceptance.test`, password: 'short', displayName: 'x' } });
  expectStatus(r, [400, 429], 'short password');
});
await check('auth', 'wrong password -> 401 invalid_credentials', async () => {
  const r = await api('POST', '/auth/login', { body: { email: alice.email, password: 'wrong-password' } });
  expectStatus(r, 401, 'bad login');
  assert(r.json?.error?.code === 'invalid_credentials', `code ${r.json?.error?.code}`);
});
await check('auth', 'protected endpoints require a bearer token', async () => {
  expectStatus(await api('GET', '/me'), 401, 'no token');
  expectStatus(await api('GET', '/me', { token: 'not-a-token' }), 401, 'bad token');
  const me = await api('GET', '/me', { token: alice.token });
  expectStatus(me, 200, 'me');
  assert(me.json.id === alice.user.id, 'me id');
});
let aliceCookie2;
await check('auth', 'refresh issues a new access token and rotates the refresh cookie', async () => {
  const r = await api('POST', '/auth/refresh', { cookie: alice.cookie.pair });
  expectStatus(r, 200, 'refresh');
  assert(r.json.accessToken, 'new access token');
  aliceCookie2 = cookieFrom(r.res);
  assert(aliceCookie2 && aliceCookie2.pair !== alice.cookie.pair, 'rotated cookie');
  alice.token = r.json.accessToken;
});
await check('auth', 'a used refresh token cannot be replayed', async () => {
  expectStatus(await api('POST', '/auth/refresh', { cookie: alice.cookie.pair }), 401, 'replayed refresh');
});
await check('auth', 'logout revokes the refresh token', async () => {
  expectStatus(await api('POST', '/auth/logout', { cookie: aliceCookie2.pair }), [200, 204], 'logout');
  expectStatus(await api('POST', '/auth/refresh', { cookie: aliceCookie2.pair }), 401, 'refresh after logout');
});

// ---------------------------------------------------------------- market
let prices;
await check('market', 'coin catalogue contains every required coin', async () => {
  const r = await api('GET', '/market/coins');
  expectStatus(r, 200, 'coins');
  const ids = new Set(r.json.coins.map((c) => c.id));
  const missing = REQUIRED_COINS.filter((id) => !ids.has(id));
  assert(missing.length === 0, `missing coins: ${missing.join(', ')}`);
  const c = r.json.coins.find((x) => x.id === 'bitcoin');
  for (const key of ['symbol', 'name', 'currentPrice', 'change24h', 'marketCap']) assert(key in c, `coin field ${key}`);
  assert(typeof r.json.stale === 'boolean', 'stale flag');
});
await check('market', 'prices endpoint returns usd and change24h, omits unknown ids', async () => {
  const r = await api('GET', '/market/prices?ids=bitcoin,ethereum,chainlink,not-a-coin');
  expectStatus(r, 200, 'prices');
  prices = r.json.prices;
  assert(prices.bitcoin?.usd > 0 && typeof prices.bitcoin.change24h === 'number', 'bitcoin price');
  assert(!('not-a-coin' in prices), 'unknown id omitted');
});
await check('market', 'history works for 1/7/30/365 days and validates input', async () => {
  for (const days of [1, 7, 30, 365]) {
    const r = await api('GET', `/market/history/chainlink?days=${days}`);
    expectStatus(r, 200, `history ${days}`);
    const ts = r.json.points.map((p) => p[0]);
    assert(ts.length >= 7, `history ${days}: ${ts.length} points`);
    assert(ts.every((t, i) => i === 0 || t >= ts[i - 1]), `history ${days} ascending`);
  }
  expectStatus(await api('GET', '/market/history/chainlink?days=2'), 400, 'days=2');
  expectStatus(await api('GET', '/market/history/not-a-coin?days=7'), 404, 'unknown coin');
});

// ---------------------------------------------------------------- portfolios & math
let pA;
let buyId;
await check('portfolio', 'portfolio CRUD and per-user unique names', async () => {
  const c = await api('POST', '/portfolios', { token: alice.token, body: { name: 'Main' } });
  expectStatus(c, 201, 'create');
  pA = c.json.id;
  expectStatus(await api('POST', '/portfolios', { token: alice.token, body: { name: 'Main' } }), 409, 'duplicate name');
  expectStatus(await api('POST', '/portfolios', { token: bob.token, body: { name: 'Main' } }), 201, 'other user same name');
  const renamed = await api('PATCH', `/portfolios/${pA}`, { token: alice.token, body: { name: 'Main renamed' } });
  expectStatus(renamed, 200, 'rename');
  assert(renamed.json.name === 'Main renamed', 'renamed');
  const tmp = await api('POST', '/portfolios', { token: alice.token, body: { name: 'Temp' } });
  expectStatus(await api('DELETE', `/portfolios/${tmp.json.id}`, { token: alice.token }), 204, 'delete');
  expectStatus(await api('GET', `/portfolios/${tmp.json.id}`, { token: alice.token }), 404, 'deleted is gone');
});
await check('portfolio', 'average-cost holdings and totals are correct', async () => {
  const b1 = await api('POST', `/portfolios/${pA}/transactions`, { token: alice.token, body: { coinId: 'bitcoin', type: 'buy', quantity: '1', priceUsd: '30000', feeUsd: '10', executedAt: '2024-01-01T00:00:00Z' } });
  expectStatus(b1, 201, 'buy 1');
  buyId = b1.json.id;
  expectStatus(await api('POST', `/portfolios/${pA}/transactions`, { token: alice.token, body: { coinId: 'bitcoin', type: 'buy', quantity: 1, priceUsd: 40000, executedAt: '2024-02-01T00:00:00Z' } }), 201, 'buy 2 (numbers)');
  const s = await api('POST', `/portfolios/${pA}/transactions`, { token: alice.token, body: { coinId: 'bitcoin', type: 'sell', quantity: '0.5', priceUsd: '50000', feeUsd: '5', executedAt: '2024-03-01T00:00:00Z' } });
  expectStatus(s, 201, 'sell');
  const h = await api('GET', `/portfolios/${pA}/holdings`, { token: alice.token });
  expectStatus(h, 200, 'holdings');
  const btc = h.json.holdings.find((x) => x.coinId === 'bitcoin');
  // cost basis 70010 for 2 BTC -> avg 35005; sell 0.5 @ 50000 fee 5 -> realized 0.5*50000 - 5 - 0.5*35005 = 7492.5
  assert(near(btc.quantity, 1.5, 1e-9), `quantity ${btc.quantity}`);
  assert(near(btc.avgCostUsd, 35005, 0.01), `avg cost ${btc.avgCostUsd}`);
  assert(near(btc.costBasisUsd, 52507.5, 0.01), `cost basis ${btc.costBasisUsd}`);
  assert(near(h.json.totals.realizedPnlUsd, 7492.5, 0.01), `realized ${h.json.totals.realizedPnlUsd}`);
  const live = (await api('GET', '/market/prices?ids=bitcoin')).json.prices.bitcoin.usd;
  assert(near(btc.valueUsd, 1.5 * live, 1.5 * live * 0.02), `value ${btc.valueUsd} vs 1.5 x ${live}`);
  assert(near(btc.unrealizedPnlUsd, btc.valueUsd - btc.costBasisUsd, 0.05), 'unrealized = value - cost');
  assert(near(btc.allocationPct, 100, 0.01), `allocation ${btc.allocationPct}`);
});
await check('portfolio', 'transactions listed newest first with totals', async () => {
  const r = await api('GET', `/portfolios/${pA}/transactions`, { token: alice.token });
  expectStatus(r, 200, 'list');
  const dates = r.json.items.map((t) => Date.parse(t.executedAt));
  assert(dates.every((d, i) => i === 0 || d <= dates[i - 1]), 'newest first');
  const first = r.json.items.find((t) => t.id === buyId);
  assert(near(first.totalUsd, 30010, 0.01), `totalUsd ${first.totalUsd}`);
});
await check('portfolio', 'overselling is rejected with 422 insufficient_holdings', async () => {
  const r = await api('POST', `/portfolios/${pA}/transactions`, { token: alice.token, body: { coinId: 'bitcoin', type: 'sell', quantity: '5', priceUsd: '1' } });
  expectStatus(r, 422, 'oversell');
  assert(r.json?.error?.code === 'insufficient_holdings', `code ${r.json?.error?.code}`);
});
await check('portfolio', 'a sell dated before the covering buys is rejected', async () => {
  const r = await api('POST', `/portfolios/${pA}/transactions`, { token: alice.token, body: { coinId: 'bitcoin', type: 'sell', quantity: '1', priceUsd: '1', executedAt: '2023-06-01T00:00:00Z' } });
  expectStatus(r, 422, 'back-dated sell');
});
await check('portfolio', 'deleting a buy that a later sell depends on is rejected', async () => {
  const p = (await api('POST', '/portfolios', { token: alice.token, body: { name: 'Delete rule' } })).json.id;
  const buy = await api('POST', `/portfolios/${p}/transactions`, { token: alice.token, body: { coinId: 'solana', type: 'buy', quantity: '2', priceUsd: '100', executedAt: '2024-01-01T00:00:00Z' } });
  const sell = await api('POST', `/portfolios/${p}/transactions`, { token: alice.token, body: { coinId: 'solana', type: 'sell', quantity: '2', priceUsd: '120', executedAt: '2024-02-01T00:00:00Z' } });
  expectStatus(buy, 201, 'buy');
  expectStatus(sell, 201, 'sell');
  expectStatus(await api('DELETE', `/transactions/${buy.json.id}`, { token: alice.token }), 422, 'delete needed buy');
  expectStatus(await api('DELETE', `/transactions/${sell.json.id}`, { token: alice.token }), 204, 'delete the sell');
  expectStatus(await api('DELETE', `/transactions/${buy.json.id}`, { token: alice.token }), 204, 'then the buy');
});
await check('portfolio', 'input validation: unknown coin, zero/negative, future, huge, malformed id -> 400', async () => {
  const bad = [
    { coinId: 'not-a-coin', type: 'buy', quantity: '1', priceUsd: '1' },
    { coinId: 'bitcoin', type: 'buy', quantity: '0', priceUsd: '1' },
    { coinId: 'bitcoin', type: 'buy', quantity: '-1', priceUsd: '1' },
    { coinId: 'bitcoin', type: 'hold', quantity: '1', priceUsd: '1' },
    { coinId: 'bitcoin', type: 'buy', quantity: '1', priceUsd: '1', executedAt: new Date(Date.now() + 2 * 86_400_000).toISOString() },
    { coinId: 'bitcoin', type: 'buy', quantity: '123456789012345678901234', priceUsd: '1' },
  ];
  for (const body of bad) expectStatus(await api('POST', `/portfolios/${pA}/transactions`, { token: alice.token, body }), 400, JSON.stringify(body));
  expectStatus(await api('GET', '/portfolios/not-a-uuid', { token: alice.token }), 400, 'malformed id');
});
await check('portfolio', 'concurrent sells can never oversell (10 parallel sells of 1 held ETH)', async () => {
  const p = (await api('POST', '/portfolios', { token: alice.token, body: { name: 'Race' } })).json.id;
  expectStatus(await api('POST', `/portfolios/${p}/transactions`, { token: alice.token, body: { coinId: 'ethereum', type: 'buy', quantity: '1', priceUsd: '2000', executedAt: '2024-01-01T00:00:00Z' } }), 201, 'buy');
  const results = await Promise.all(Array.from({ length: 10 }, () => api('POST', `/portfolios/${p}/transactions`, { token: alice.token, body: { coinId: 'ethereum', type: 'sell', quantity: '1', priceUsd: '2500' } })));
  const ok = results.filter((r) => r.status === 201).length;
  assert(ok === 1, `${ok} of 10 concurrent sells succeeded (statuses ${results.map((r) => r.status).join(',')})`);
  expectStatus(await api('GET', `/portfolios/${p}/holdings`, { token: alice.token }), 200, 'holdings after race');
  expectStatus(await api('GET', '/dashboard', { token: alice.token }), 200, 'dashboard after race');
});
await check('portfolio', 'snapshots endpoint and dashboard shapes', async () => {
  const s = await api('GET', `/portfolios/${pA}/snapshots?days=30`, { token: alice.token });
  expectStatus(s, 200, 'snapshots');
  assert(Array.isArray(s.json.points), 'points array');
  const d = await api('GET', '/dashboard', { token: alice.token });
  expectStatus(d, 200, 'dashboard');
  for (const key of ['totals', 'holdings', 'portfolios', 'history', 'stale']) assert(key in d.json, `dashboard.${key}`);
});

// ---------------------------------------------------------------- isolation
await check('isolation', "another user's portfolio and transactions are 404", async () => {
  for (const [method, path] of [['GET', `/portfolios/${pA}`], ['PATCH', `/portfolios/${pA}`], ['DELETE', `/portfolios/${pA}`], ['GET', `/portfolios/${pA}/holdings`], ['GET', `/portfolios/${pA}/transactions`], ['GET', `/portfolios/${pA}/snapshots`]]) {
    expectStatus(await api(method, path, { token: bob.token, body: method === 'PATCH' ? { name: 'x' } : undefined }), 404, `bob ${method} ${path}`);
  }
  expectStatus(await api('POST', `/portfolios/${pA}/transactions`, { token: bob.token, body: { coinId: 'bitcoin', type: 'buy', quantity: '1', priceUsd: '1' } }), 404, 'bob adds tx');
  expectStatus(await api('DELETE', `/transactions/${buyId}`, { token: bob.token }), 404, 'bob deletes tx');
  expectStatus(await api('POST', '/jobs', { token: bob.token, body: { type: 'export_csv', params: { portfolioId: pA } } }), 404, 'bob exports alice portfolio');
});

// ---------------------------------------------------------------- watchlist & alerts
await check('watchlist', 'add (idempotent), list with prices, remove', async () => {
  expectStatus(await api('POST', '/watchlist', { token: alice.token, body: { coinId: 'chainlink' } }), [200, 201], 'add');
  expectStatus(await api('POST', '/watchlist', { token: alice.token, body: { coinId: 'chainlink' } }), [200, 201], 'add again');
  const l = await api('GET', '/watchlist', { token: alice.token });
  expectStatus(l, 200, 'list');
  assert(l.json.items.length === 1 && l.json.items[0].id === 'chainlink' && l.json.items[0].currentPrice > 0, 'watchlist item');
  expectStatus(await api('GET', '/watchlist', { token: bob.token }), 200, 'bob list');
  assert((await api('GET', '/watchlist', { token: bob.token })).json.items.length === 0, 'watchlist is private');
  expectStatus(await api('POST', '/watchlist', { token: alice.token, body: { coinId: 'not-a-coin' } }), 400, 'unknown coin');
  expectStatus(await api('DELETE', '/watchlist/chainlink', { token: alice.token }), 204, 'remove');
});
let alertId;
await check('alerts', 'create/list/validate alerts; other users get 404', async () => {
  const bad = await api('POST', '/alerts', { token: alice.token, body: { coinId: 'bitcoin', direction: 'sideways', targetPrice: 1 } });
  expectStatus(bad, 400, 'bad direction');
  expectStatus(await api('POST', '/alerts', { token: alice.token, body: { coinId: 'bitcoin', direction: 'above', targetPrice: 0 } }), 400, 'zero target');
  const c = await api('POST', '/alerts', { token: alice.token, body: { coinId: 'bitcoin', direction: 'above', targetPrice: Math.floor(prices.bitcoin.usd / 2) } });
  expectStatus(c, 201, 'create');
  alertId = c.json.id;
  assert(c.json.active === true, 'active');
  const l = await api('GET', '/alerts', { token: alice.token });
  assert(l.json.items.some((a) => a.id === alertId && a.currentPrice > 0), 'listed with current price');
  expectStatus(await api('DELETE', `/alerts/${alertId}`, { token: bob.token }), 404, 'bob deletes alice alert');
});

// ---------------------------------------------------------------- files & jobs
await check('uploads', 'avatar: only raster types, content type enforced by storage, served with CSP', async () => {
  expectStatus(await api('POST', '/me/avatar/upload-url', { token: alice.token, body: { contentType: 'text/html' } }), 400, 'html avatar type');
  expectStatus(await api('POST', '/me/avatar/upload-url', { token: alice.token, body: { contentType: 'image/svg+xml' } }), 400, 'svg avatar type');
  const u = await api('POST', '/me/avatar/upload-url', { token: alice.token, body: { contentType: 'image/png' } });
  expectStatus(u, 200, 'upload url');
  assert(u.json.uploadUrl.startsWith(BASE), `upload URL goes through the gateway (${u.json.uploadUrl.slice(0, 60)})`);
  const spoof = await fetch(u.json.uploadUrl, { method: 'PUT', body: '<script>alert(1)</script>', headers: { 'content-type': 'text/html' } });
  assert(spoof.status >= 400 && spoof.status < 500, `HTML PUT to image URL -> ${spoof.status}`);
  const put = await fetch(u.json.uploadUrl, { method: 'PUT', body: PNG_1PX, headers: { 'content-type': 'image/png' } });
  assert(put.ok, `PNG PUT -> ${put.status}`);
  const me = await api('PUT', '/me/avatar', { token: alice.token, body: { key: u.json.key } });
  expectStatus(me, 200, 'set avatar');
  const img = await fetch(me.json.avatarUrl);
  assert(img.ok, `avatar GET -> ${img.status}`);
  const csp = img.headers.get('content-security-policy') ?? '';
  assert(/sandbox|default-src 'none'/.test(csp), `storage response CSP: "${csp}"`);
  expectStatus(await api('PUT', '/me/avatar', { token: bob.token, body: { key: u.json.key } }), 400, "bob uses alice's avatar key");
});
await check('jobs', 'CSV export completes and downloads through a presigned URL', async () => {
  const job = await runJob(alice.token, 'export_csv', { portfolioId: pA });
  assert(job.downloadUrl, 'downloadUrl');
  const csv = await (await fetch(job.downloadUrl)).text();
  assert(csv.startsWith('date,type,coin_id,quantity,price_usd,fee_usd'), `csv header: ${csv.slice(0, 60)}`);
  assert(csv.trim().split('\n').length === 4, `3 transactions exported (${csv.trim().split('\n').length - 1})`);
});
await check('jobs', 'CSV import inserts all rows', async () => {
  const p = (await api('POST', '/portfolios', { token: alice.token, body: { name: 'Imported' } })).json.id;
  const u = await api('POST', '/uploads/import-url', { token: alice.token });
  expectStatus(u, 200, 'import url');
  const csv = 'date,type,coin_id,quantity,price_usd,fee_usd,note\n2024-01-01T00:00:00Z,buy,solana,10,100,1,a\n2024-02-01T00:00:00Z,sell,solana,4,150,1,b\n';
  const put = await fetch(u.json.uploadUrl, { method: 'PUT', body: csv, headers: { 'content-type': 'text/csv' } });
  assert(put.ok, `csv PUT -> ${put.status}`);
  const job = await runJob(alice.token, 'import_csv', { portfolioId: p, key: u.json.key });
  assert(job.result?.imported === 2, `imported ${JSON.stringify(job.result)}`);
  const h = await api('GET', `/portfolios/${p}/holdings`, { token: alice.token });
  assert(near(h.json.holdings.find((x) => x.coinId === 'solana')?.quantity, 6, 1e-9), 'solana quantity 6');
});
await check('jobs', 'bad CSV import fails with a row-specific message and inserts nothing', async () => {
  const p = (await api('POST', '/portfolios', { token: alice.token, body: { name: 'BadImport' } })).json.id;
  const u = await api('POST', '/uploads/import-url', { token: alice.token });
  const csv = 'date,type,coin_id,quantity,price_usd,fee_usd,note\n2024-01-01T00:00:00Z,buy,bitcoin,1,100,0,ok\n2024-01-02T00:00:00Z,buy,bitcoin,0,100,0,bad\n';
  await fetch(u.json.uploadUrl, { method: 'PUT', body: csv, headers: { 'content-type': 'text/csv' } });
  const job = await runJob(alice.token, 'import_csv', { portfolioId: p, key: u.json.key }, { expectFailure: true });
  assert(job.status === 'failed' && /row 3/i.test(job.error ?? ''), `error: ${job.error}`);
  const t = await api('GET', `/portfolios/${p}/transactions`, { token: alice.token });
  assert(t.json.items.length === 0, 'nothing partially imported');
});
await check('jobs', 'PDF report is generated', async () => {
  const job = await runJob(alice.token, 'report_pdf', { portfolioId: pA });
  const bytes = Buffer.from(await (await fetch(job.downloadUrl)).arrayBuffer());
  assert(bytes.subarray(0, 4).toString() === '%PDF', 'starts with %PDF');
});
await check('jobs', 'jobs are private', async () => {
  const jobs = await api('GET', '/jobs', { token: alice.token });
  expectStatus(jobs, 200, 'list jobs');
  const id = jobs.json.items[0]?.id;
  assert(id, 'alice has jobs');
  expectStatus(await api('GET', `/jobs/${id}`, { token: bob.token }), 404, 'bob reads alice job');
});

// ---------------------------------------------------------------- alerts -> notifications (worker)
await check('alerts', 'an alert fires once and creates a notification (worker scheduler)', async () => {
  await waitFor('alert notification', ALERT_TIMEOUT_MS, async () => {
    const n = await api('GET', '/notifications', { token: alice.token });
    return n.json?.unreadCount > 0;
  }, 3000);
  const a = await api('GET', '/alerts', { token: alice.token });
  const alert = a.json.items.find((x) => x.id === alertId);
  assert(alert && alert.active === false && alert.triggeredAt, 'alert inactive with triggeredAt');
  const n = await api('GET', '/notifications', { token: alice.token });
  const id = n.json.items[0].id;
  expectStatus(await api('POST', `/notifications/${id}/read`, { token: bob.token }), 404, 'bob marks alice notification');
  expectStatus(await api('POST', `/notifications/${id}/read`, { token: alice.token }), [200, 204], 'mark read');
  expectStatus(await api('POST', '/notifications/read-all', { token: alice.token }), [200, 204], 'read all');
  assert((await api('GET', '/notifications', { token: alice.token })).json.unreadCount === 0, 'unread 0');
});

// ---------------------------------------------------------------- rate limits (last: they use up the per-IP budget)
await check('security', 'login rate limit cannot be bypassed with a spoofed X-Forwarded-For', async () => {
  let limited = false;
  for (let i = 0; i < 14 && !limited; i++) {
    const r = await api('POST', '/auth/login', { body: { email: `nobody-${RUN}@acceptance.test`, password: 'x-wrong-x' }, headers: { 'x-forwarded-for': `10.${i}.0.1` } });
    limited = r.status === 429;
  }
  assert(limited, 'no 429 after 14 attempts with different X-Forwarded-For values');
});
await check('security', 'registration is rate limited', async () => {
  let limited = false;
  for (let i = 0; i < 14 && !limited; i++) {
    const r = await api('POST', '/auth/register', { body: { email: `flood-${RUN}-${i}@acceptance.test`, password: 'acceptance-pw-1', displayName: 'f' } });
    limited = r.status === 429;
  }
  assert(limited, 'no 429 after 14 registrations');
});

// ---------------------------------------------------------------- summary
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
const byGroup = {};
for (const r of results) {
  byGroup[r.group] ??= { passed: 0, total: 0 };
  byGroup[r.group].total++;
  if (r.pass) byGroup[r.group].passed++;
}
console.log(`RESULT_JSON ${JSON.stringify({ base: BASE, passed, total: results.length, groups: byGroup, failures: results.filter((r) => !r.pass) })}`);
process.exit(passed === results.length ? 0 : 1);
