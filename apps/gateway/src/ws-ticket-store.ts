import { randomBytes } from 'node:crypto';
import type { WsTicketResponse } from '@dash/mobile-contract';

const TTL_MS = 30_000;

/** Single-use, short-lived WebSocket upgrade tickets (spec: web-interface design). */
export class WsTicketStore {
  private readonly tickets = new Map<string, number>();

  issue(now: number = Date.now()): WsTicketResponse {
    // Never-redeemed tickets would otherwise accumulate forever on a
    // long-lived gateway; sweep anything past its TTL before adding a new one.
    for (const [existing, expiry] of this.tickets) {
      if (now > expiry) this.tickets.delete(existing);
    }
    const ticket = randomBytes(32).toString('hex');
    const expiry = now + TTL_MS;
    this.tickets.set(ticket, expiry);
    return { ticket, expiresAt: new Date(expiry).toISOString() };
  }

  redeem(ticket: string, now: number = Date.now()): boolean {
    const expiry = this.tickets.get(ticket);
    if (expiry === undefined) return false;
    this.tickets.delete(ticket);
    return now <= expiry;
  }
}
