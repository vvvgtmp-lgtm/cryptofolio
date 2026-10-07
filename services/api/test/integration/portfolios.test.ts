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

  it('serialises concurrent sells so they can never oversell', async () => {
    const id = await createPortfolio();
    await addTx(id, { coinId: 'bitcoin', type: 'buy', quantity: '1', priceUsd: '40000', executedAt: '2024-01-01T00:00:00Z' });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => addTx(id, { coinId: 'bitcoin', type: 'sell', quantity: '1', priceUsd: '50000' })),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 422)).toHaveLength(11);
    const holdings = await t.app.inject({ method: 'GET', url: `/api/portfolios/${id}/holdings`, headers: alice.headers });
    expect(holdings.statusCode).toBe(200);
  });

  it('rejects numbers too large for the database with 400', async () => {
    const id = await createPortfolio();
    const res = await addTx(id, { coinId: 'bitcoin', type: 'buy', quantity: '123456789012345678901234', priceUsd: '1' });
    expect(res.statusCode).toBe(400);
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
