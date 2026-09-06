import { Hono } from 'hono';
import { WsTicketStore, mountWsTicketRoute } from './ws-ticket-store.js';

describe('WsTicketStore', () => {
  it('issues a ticket redeemable exactly once', () => {
    const store = new WsTicketStore();
    const { ticket } = store.issue(1000);
    expect(store.redeem(ticket, 2000)).toBe(true);
    expect(store.redeem(ticket, 2000)).toBe(false);
  });
  it('rejects expired tickets (>30s)', () => {
    const store = new WsTicketStore();
    const { ticket, expiresAt } = store.issue(0);
    expect(new Date(expiresAt).getTime()).toBe(30_000);
    expect(store.redeem(ticket, 30_001)).toBe(false);
  });
  it('accepts a redeem exactly at the TTL boundary (inclusive)', () => {
    const store = new WsTicketStore();
    const { ticket } = store.issue(0);
    expect(store.redeem(ticket, 30_000)).toBe(true);
  });
  it('rejects unknown tickets', () => {
    expect(new WsTicketStore().redeem('nope', 0)).toBe(false);
  });

  it('mounts v1 and v2 mint endpoints against one returned store', async () => {
    const app = new Hono();
    const store = mountWsTicketRoute(app);
    const v1 = await app.request('/mobile/v1/ws-ticket', { method: 'POST' });
    const v2 = await app.request('/mobile/v2/ws-ticket', { method: 'POST' });
    expect(v1.status).toBe(200);
    expect(v2.status).toBe(200);

    const v1Ticket = (await v1.json()).ticket as string;
    const v2Ticket = (await v2.json()).ticket as string;
    expect(store.redeem(v1Ticket)).toBe(true);
    expect(store.redeem(v2Ticket)).toBe(true);
    expect(store.redeem(v1Ticket)).toBe(false);
    expect(store.redeem(v2Ticket)).toBe(false);
  });
});
