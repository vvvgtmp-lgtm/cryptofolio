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
await step('avatar upload round trip (images only, content type enforced)', async () => {
  await call('POST', '/me/avatar/upload-url', { contentType: 'text/html' }, [400]);
  const { uploadUrl, key } = await call('POST', '/me/avatar/upload-url', { contentType: 'image/png' });
  const spoofed = await fetch(uploadUrl, { method: 'PUT', body: '<script>alert(1)</script>', headers: { 'content-type': 'text/html' } });
  if (spoofed.status !== 403) throw new Error(`HTML upload to an image URL was accepted (HTTP ${spoofed.status})`);
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
