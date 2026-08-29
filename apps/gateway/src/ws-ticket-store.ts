import { randomBytes } from 'node:crypto';
import type { WsTicketResponse } from '@dash/mobile-contract';
import type { Hono } from 'hono';

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

/**
 * Create the process-wide ticket store and register its mint route
 * (`POST /mobile/v1/ws-ticket`) on the canonical management app.
 *
 * Deliberately ONE store for the whole gateway, created independently of any
 * listener. Every surface that mounts `/ws/chat` — the channel listener the
 * relay forwards browser traffic to, and the pinned LAN listener — must be
 * handed this same instance, or a ticket minted over HTTP is redeemable at one
 * surface and silently rejected (4001) at the other.
 *
 * Registering the handler directly on `managementApp` (mutating it after the
 * fact, as `mountProjectsWs` and the mobile test harness also do) is what gives
 * it the real mobile-bearer protection: Hono's `app.use('*', ...)` middleware
 * matches by request path at dispatch time regardless of when a route was
 * added, so this is guarded exactly like `/mobile/v1/identity`.
 */
export function mountWsTicketRoute(managementApp: Hono): WsTicketStore {
  const wsTickets = new WsTicketStore();
  managementApp.post('/mobile/v1/ws-ticket', (c) => c.json(wsTickets.issue()));
  return wsTickets;
}
