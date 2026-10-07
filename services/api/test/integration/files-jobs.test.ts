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
    const { uploadUrl, key } = (await t.app.inject({ method: 'POST', url: '/api/me/avatar/upload-url', headers: alice.headers, payload: { contentType: 'image/png' } })).json();
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

  it('only issues avatar upload URLs for raster image types', async () => {
    for (const contentType of ['text/html', 'image/svg+xml', undefined]) {
      const res = await t.app.inject({ method: 'POST', url: '/api/me/avatar/upload-url', headers: alice.headers, payload: { contentType } });
      expect(res.statusCode, String(contentType)).toBe(400);
    }
  });

  it('storage rejects an upload whose content type differs from the signed one', async () => {
    const { uploadUrl } = (await t.app.inject({ method: 'POST', url: '/api/me/avatar/upload-url', headers: alice.headers, payload: { contentType: 'image/png' } })).json();
    const put = await fetch(uploadUrl, { method: 'PUT', body: '<script>alert(1)</script>', headers: { 'content-type': 'text/html' } });
    expect(put.status).toBe(403);
    const { uploadUrl: csvUrl } = (await t.app.inject({ method: 'POST', url: '/api/uploads/import-url', headers: alice.headers })).json();
    const csvPut = await fetch(csvUrl, { method: 'PUT', body: '<script>alert(1)</script>', headers: { 'content-type': 'text/html' } });
    expect(csvPut.status).toBe(403);
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
