import { WsTicketStore } from './ws-ticket-store.js';

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
});
