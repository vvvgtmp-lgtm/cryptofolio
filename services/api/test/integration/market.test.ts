import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, registerUser, resetState, type TestApp } from './helpers.js';

describe('market, watchlist, alerts, notifications', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await buildTestApp();
  });
  beforeEach(async () => {
    await resetState(t.deps);
    t.prices.down = false;
  });
  afterAll(() => t.close());

  describe('market (public)', () => {
    it('lists coins without auth', async () => {
      const res = await t.app.inject({ method: 'GET', url: '/api/market/coins' });
      expect(res.statusCode).toBe(200);
      expect(res.json().coins.map((c: { id: string }) => c.id)).toContain('bitcoin');
    });

    it('returns prices for ids', async () => {
      const res = await t.app.inject({ method: 'GET', url: '/api/market/prices?ids=bitcoin,ethereum' });
      expect(res.json().prices.bitcoin).toEqual({ usd: 50000, change24h: 2 });
    });

    it('validates history days and unknown coins', async () => {
      expect((await t.app.inject({ method: 'GET', url: '/api/market/history/bitcoin?days=2' })).statusCode).toBe(400);
      expect((await t.app.inject({ method: 'GET', url: '/api/market/history/nope?days=7' })).statusCode).toBe(404);
      expect((await t.app.inject({ method: 'GET', url: '/api/market/history/bitcoin?days=30' })).statusCode).toBe(200);
    });

    it('returns 502 when the price service is down', async () => {
      t.prices.down = true;
      const res = await t.app.inject({ method: 'GET', url: '/api/market/coins' });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('price_service_unavailable');
    });
  });

  describe('watchlist', () => {
    it('adds, lists (with prices) and removes coins; adding twice is idempotent', async () => {
      const { headers } = await registerUser(t.app);
      expect((await t.app.inject({ method: 'POST', url: '/api/watchlist', headers, payload: { coinId: 'bitcoin' } })).statusCode).toBe(201);
      expect((await t.app.inject({ method: 'POST', url: '/api/watchlist', headers, payload: { coinId: 'bitcoin' } })).statusCode).toBe(201);
      const list = await t.app.inject({ method: 'GET', url: '/api/watchlist', headers });
      expect(list.json().items).toHaveLength(1);
      expect(list.json().items[0]).toMatchObject({ id: 'bitcoin', currentPrice: 50000 });
      expect((await t.app.inject({ method: 'DELETE', url: '/api/watchlist/bitcoin', headers })).statusCode).toBe(204);
      expect((await t.app.inject({ method: 'GET', url: '/api/watchlist', headers })).json().items).toHaveLength(0);
    });

    it('rejects unknown coins', async () => {
      const { headers } = await registerUser(t.app);
      const res = await t.app.inject({ method: 'POST', url: '/api/watchlist', headers, payload: { coinId: 'nope' } });
      expect(res.statusCode).toBe(400);
    });

    it('is private per user', async () => {
      const alice = await registerUser(t.app, 'alice@example.com');
      const bob = await registerUser(t.app, 'bob@example.com');
      await t.app.inject({ method: 'POST', url: '/api/watchlist', headers: alice.headers, payload: { coinId: 'bitcoin' } });
      const res = await t.app.inject({ method: 'GET', url: '/api/watchlist', headers: bob.headers });
      expect(res.json().items).toHaveLength(0);
    });
  });

  describe('alerts', () => {
    it('creates, lists with current price, and deletes', async () => {
      const { headers } = await registerUser(t.app);
      const created = await t.app.inject({
        method: 'POST', url: '/api/alerts', headers,
        payload: { coinId: 'bitcoin', direction: 'above', targetPrice: 60000 },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ coinId: 'bitcoin', direction: 'above', targetPrice: 60000, active: true });
      const list = await t.app.inject({ method: 'GET', url: '/api/alerts', headers });
      expect(list.json().items[0].currentPrice).toBe(50000);
      const del = await t.app.inject({ method: 'DELETE', url: `/api/alerts/${created.json().id}`, headers });
      expect(del.statusCode).toBe(204);
    });

    it('validates direction and target price', async () => {
      const { headers } = await registerUser(t.app);
      const bad1 = await t.app.inject({ method: 'POST', url: '/api/alerts', headers, payload: { coinId: 'bitcoin', direction: 'sideways', targetPrice: 1 } });
      const bad2 = await t.app.inject({ method: 'POST', url: '/api/alerts', headers, payload: { coinId: 'bitcoin', direction: 'above', targetPrice: 0 } });
      expect([bad1.statusCode, bad2.statusCode]).toEqual([400, 400]);
    });

    it("cannot delete another user's alert", async () => {
      const alice = await registerUser(t.app, 'alice@example.com');
      const bob = await registerUser(t.app, 'bob@example.com');
      const created = await t.app.inject({ method: 'POST', url: '/api/alerts', headers: alice.headers, payload: { coinId: 'bitcoin', direction: 'below', targetPrice: 1 } });
      const res = await t.app.inject({ method: 'DELETE', url: `/api/alerts/${created.json().id}`, headers: bob.headers });
      expect(res.statusCode).toBe(404);
    });

    it('still lists alerts when the price service is down', async () => {
      const { headers } = await registerUser(t.app);
      await t.app.inject({ method: 'POST', url: '/api/alerts', headers, payload: { coinId: 'bitcoin', direction: 'above', targetPrice: 1 } });
      t.prices.down = true;
      const res = await t.app.inject({ method: 'GET', url: '/api/alerts', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ stale: true, items: [{ currentPrice: null }] });
    });
  });

  describe('notifications', () => {
    it('lists, counts unread, marks one and all as read; other users get 404', async () => {
      const alice = await registerUser(t.app, 'alice@example.com');
      const bob = await registerUser(t.app, 'bob@example.com');
      const [n1] = await t.deps.db
        .insertInto('notifications')
        .values([
          { user_id: alice.userId, title: 'one', body: 'b' },
          { user_id: alice.userId, title: 'two', body: 'b' },
        ])
        .returning('id')
        .execute();

      let res = await t.app.inject({ method: 'GET', url: '/api/notifications', headers: alice.headers });
      expect(res.json()).toMatchObject({ unreadCount: 2 });
      expect(res.json().items).toHaveLength(2);

      expect((await t.app.inject({ method: 'POST', url: `/api/notifications/${n1.id}/read`, headers: bob.headers })).statusCode).toBe(404);
      expect((await t.app.inject({ method: 'POST', url: `/api/notifications/${n1.id}/read`, headers: alice.headers })).statusCode).toBe(204);
      res = await t.app.inject({ method: 'GET', url: '/api/notifications?unread=true', headers: alice.headers });
      expect(res.json()).toMatchObject({ unreadCount: 1 });
      expect(res.json().items).toHaveLength(1);

      await t.app.inject({ method: 'POST', url: '/api/notifications/read-all', headers: alice.headers });
      res = await t.app.inject({ method: 'GET', url: '/api/notifications', headers: alice.headers });
      expect(res.json().unreadCount).toBe(0);
    });
  });
});
